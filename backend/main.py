"""
pySAR FastAPI backend
Wraps the pySAR encoding library and exposes REST endpoints for:
  - Dataset upload + preview
  - Config validation
  - Encoding job submission, status polling, and results retrieval
"""

import json
import logging
import math
import multiprocessing as _mp
import os
import queue as _queue_mod
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import pandas as pd
from collections import defaultdict
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

# ── Path setup: locate the sibling pySAR repo and inject its dependencies ──────
_PROJECT_ROOT = Path(__file__).resolve().parent.parent   # pysar-frontend/
_PYSAR_REPO   = _PROJECT_ROOT.parent / "pySAR"           # sibling pySAR repo

# Add the pySAR repo root so `from pySAR.encoding import Encoding` resolves to
# pySAR/pySAR/encoding.py (the inner package directory)
if _PYSAR_REPO.exists() and str(_PYSAR_REPO) not in sys.path:
    sys.path.insert(0, str(_PYSAR_REPO))

# Also inject the pySAR venv's site-packages so protpy, scipy, etc. are available
import glob as _glob
for _sp in _glob.glob(str(_PYSAR_REPO / ".venv" / "lib" / "python3.*" / "site-packages")):
    if _sp not in sys.path:
        sys.path.insert(1, _sp)

# ── Structured JSON logging (GCP Cloud Logging reads 'severity' and 'message' natively) ──
class _JsonFormatter(logging.Formatter):
    """Emit single-line JSON records; compatible with GCP Cloud Logging structured ingestion."""
    _SEVERITY: Dict[str, str] = {
        "DEBUG": "DEBUG", "INFO": "INFO", "WARNING": "WARNING",
        "ERROR": "ERROR", "CRITICAL": "CRITICAL",
    }

    def format(self, record: logging.LogRecord) -> str:  # type: ignore[override]
        payload: Dict[str, Any] = {
            "severity": self._SEVERITY.get(record.levelname, record.levelname),
            "message":  record.getMessage(),
            "logger":   record.name,
            "time":     self.formatTime(record, self.datefmt),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


_json_handler = logging.StreamHandler()
_json_handler.setFormatter(_JsonFormatter(datefmt="%Y-%m-%dT%H:%M:%S"))
logging.basicConfig(handlers=[_json_handler], level=logging.INFO, force=True)
logger = logging.getLogger("pysar_api")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start background threads on startup; replaces deprecated @app.on_event."""
    threading.Thread(target=_prewarm_pysar, daemon=True).start()
    threading.Thread(target=_cleanup_upload_dir, daemon=True, name="cleanup").start()
    yield


app = FastAPI(title="pySAR API", version="1.0.0", docs_url="/api/docs", lifespan=lifespan)

# ── Detect Vercel deployment URL for CORS ────────────────────────────────────
_VERCEL_URL = os.environ.get("VERCEL_URL")
_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
if _VERCEL_URL:
    _ALLOWED_ORIGINS.append(f"https://{_VERCEL_URL}")
# Allow custom origin via env var (e.g. a custom domain)
_EXTRA_ORIGIN = os.environ.get("CORS_ORIGIN")
if _EXTRA_ORIGIN:
    _ALLOWED_ORIGINS.append(_EXTRA_ORIGIN)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Rate limiting ──────────────────────────────────────────────────────────────
# Tracks per-IP request counts for rate-limited endpoints.
# { ip: [(timestamp, ...), ...] } — uses a sliding window.
_RATE_LIMIT_STORE: Dict[str, List[float]] = defaultdict(list)
_RATE_LIMIT_LOCK = threading.Lock()

# Limits per endpoint path prefix (requests per window_seconds)
_RATE_LIMITS: Dict[str, Dict[str, int]] = {
    "/api/encode": {"max_requests": 5, "window_seconds": 60},
    "/api/upload": {"max_requests": 20, "window_seconds": 60},
}


# Only trust X-Forwarded-For when running behind a known proxy (Cloud Run / Fly.io).
# Set TRUST_PROXY=true in the environment to enable; leave unset for direct exposure.
_TRUST_PROXY = os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes")


def _get_client_ip(request: Request) -> str:
    """Extract real client IP; only trusts X-Forwarded-For when TRUST_PROXY=true."""
    if _TRUST_PROXY:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Sliding-window rate limiter for sensitive endpoints."""
    path = request.url.path
    # Only apply to POST requests on rate-limited paths
    if request.method == "POST":
        for prefix, limits in _RATE_LIMITS.items():
            if path.startswith(prefix):
                ip = _get_client_ip(request)
                now = time.monotonic()
                window = limits["window_seconds"]
                max_req = limits["max_requests"]
                # Use per-endpoint key so upload and encode have independent buckets
                key = f"{ip}:{prefix}"
                with _RATE_LIMIT_LOCK:
                    # Prune timestamps outside the sliding window
                    timestamps = _RATE_LIMIT_STORE[key]
                    _RATE_LIMIT_STORE[key] = [t for t in timestamps if now - t < window]
                    if len(_RATE_LIMIT_STORE[key]) >= max_req:
                        logger.warning(
                            "Rate limit exceeded: ip=%s path=%s count=%s/%s per %ss",
                            ip, path, len(_RATE_LIMIT_STORE[key]), max_req, window,
                        )
                        return JSONResponse(
                            status_code=429,
                            content={"detail": f"Rate limit exceeded: max {max_req} requests per {window}s. Please wait before retrying."},
                            headers={"Retry-After": str(window)},
                        )
                    _RATE_LIMIT_STORE[key].append(now)
                break
    return await call_next(request)

# Temp directory shared by all jobs
UPLOAD_DIR = Path(tempfile.gettempdir()) / "pysar_frontend"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# In-memory job registry
JOBS: Dict[str, Dict[str, Any]] = {}

# ── Startup tasks ──────────────────────────────────────────────────────────────

def _prewarm_pysar() -> None:
    """Import pySAR eagerly so the first job doesn't pay the cold-start cost."""
    try:
        t0 = time.monotonic()
        from pySAR.encoding import Encoding  # noqa: F401
        logger.info("pySAR pre-warm complete in %.1fs", time.monotonic() - t0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pySAR pre-warm failed (will retry on first job): %s", exc)


# TTL (seconds) for completed/failed/cancelled jobs before they are evicted from JOBS.
# Keeps memory bounded even when upload files are still on disk.
_JOB_COMPLETED_TTL_SECS = int(os.environ.get("JOB_COMPLETED_TTL_SECS", 1800))  # default 30 min


def _cleanup_upload_dir(max_age_hours: int = 6) -> None:
    """Hourly sweep: removes old temp files, prunes ghost JOBS, and evicts expired rate-limit buckets."""
    while True:
        time.sleep(3600)  # wait an hour before each sweep
        cutoff = time.time() - max_age_hours * 3600

        # ── Remove stale temp files ────────────────────────────────────────────
        removed = 0
        try:
            for f in UPLOAD_DIR.iterdir():
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
                    removed += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("Temp-file cleanup error: %s", exc)
        if removed:
            logger.info("Temp-file cleanup: removed %s file(s) older than %sh", removed, max_age_hours)

        # ── Prune completed/failed/cancelled jobs past their TTL ──────────────
        # Evicts jobs regardless of whether their upload file still exists,
        # bounding in-memory JOBS growth for long-running deployments.
        _ttl_cutoff = datetime.now(timezone.utc).timestamp() - _JOB_COMPLETED_TTL_SECS
        ttl_expired = [
            jid for jid, job in list(JOBS.items())
            if job.get("status") in ("completed", "failed", "cancelled")
            and job.get("completed_at")
            and datetime.fromisoformat(job["completed_at"]).timestamp() < _ttl_cutoff
        ]
        for jid in ttl_expired:
            JOBS.pop(jid, None)
            _CANCEL_EVENTS.pop(jid, None)
            _CANCEL_PROCESSES.pop(jid, None)
        if ttl_expired:
            logger.info("JOBS cleanup: evicted %s job(s) past %ss TTL", len(ttl_expired), _JOB_COMPLETED_TTL_SECS)

        # ── Prune ghost JOBS whose upload file no longer exists ────────────────
        ghost_jobs = [
            jid for jid, job in list(JOBS.items())
            if job.get("status") in ("completed", "failed", "cancelled")
            and job.get("file_path") and not Path(job["file_path"]).exists()
        ]
        for jid in ghost_jobs:
            JOBS.pop(jid, None)
            _CANCEL_EVENTS.pop(jid, None)
            _CANCEL_PROCESSES.pop(jid, None)
        if ghost_jobs:
            logger.info("JOBS cleanup: pruned %s ghost job(s)", len(ghost_jobs))

        # ── Evict expired rate-limit buckets ──────────────────────────────────
        now_mono = time.monotonic()
        max_window = max(v["window_seconds"] for v in _RATE_LIMITS.values())
        with _RATE_LIMIT_LOCK:
            expired_keys = [
                k for k, ts in _RATE_LIMIT_STORE.items()
                if not any(now_mono - t < max_window for t in ts)
            ]
            for k in expired_keys:
                del _RATE_LIMIT_STORE[k]
        if expired_keys:
            logger.info("Rate-limit cleanup: evicted %s expired bucket(s)", len(expired_keys))


# ── Pydantic request models ─────────────────────────────────────────────────────

# Known pySAR algorithm names (mirrors VALID_ALGORITHMS in frontend/src/utils/configValidation.js)
_VALID_ALGORITHMS: frozenset = frozenset({
    "plsregression", "ridge", "lasso", "elasticnet", "svr",
    "randomforest", "gradientboosting", "hgbr", "knn", "linearregression",
    "extratrees", "bagging", "adaboost", "gpr", "linear",
})

def _subprocess_exit_hint(exitcode: int) -> str:
    """Return a human-readable hint string for a subprocess that died abnormally.

    Maps OS signal numbers (stored as negative exit codes by Python's
    multiprocessing) to actionable guidance, distinguishing SIGSEGV from
    SIGKILL/OOM from other OS terminations.
    """
    if exitcode == -11:  # SIGSEGV
        return (
            "The encoding subprocess crashed with a segmentation fault "
            "(signal 11). On macOS this is often caused by a known "
            "conflict between multiprocessing fork and Apple's "
            "Objective-C runtime. Ensure the server was started with "
            "OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES set in the "
            "environment (use start.sh, which sets this automatically)."
        )
    if exitcode == -9:  # SIGKILL — typically OOM
        return (
            "The encoding subprocess was killed (signal 9), which "
            "usually indicates the process ran out of memory. Try "
            "reducing the dataset size, lowering max_models, or "
            "increasing available RAM."
        )
    return (
        f"The encoding subprocess was terminated by the OS "
        f"(exit code {exitcode}). Try restarting the server and "
        f"reducing the dataset size or max_models."
    )

# Maximum simultaneous running jobs per client IP
_MAX_CONCURRENT_JOBS_PER_IP = 3

# Maximum accepted upload size; overridable via MAX_UPLOAD_MB env var
_MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", 10))
_MAX_UPLOAD_BYTES = _MAX_UPLOAD_MB * 1024 * 1024


class EncodeRequest(BaseModel):
    file_path: str
    sequence_col: str
    activity_col: str
    # Model
    algorithm: str = "plsregression"
    model_parameters: Optional[Dict[str, Any]] = Field(default_factory=dict)
    test_split: float = 0.2
    # Descriptor config (forwarded verbatim as the descriptors section)
    descriptors_config: Optional[Dict[str, Any]] = Field(default_factory=dict)
    # DSP config
    dsp_config: Optional[Dict[str, Any]] = Field(default_factory=lambda: {"use_dsp": 0})
    # Encoding strategy — only these three are supported by pySAR
    strategy: Literal["aai", "descriptor", "aai_descriptor"] = "aai"
    aai_indices: Optional[List[str]] = None
    selected_descriptors: Optional[List[str]] = None
    desc_combo: int = 1
    # Encoding tuning — sort_by must be a recognised metric column
    sort_by: Literal["R2", "RMSE", "MSE", "MAE", "RPD", "Explained_Var"] = "R2"
    n_jobs: int = 1
    max_models: Optional[int] = None
    sample_mode: bool = False
    random_state: Optional[int] = None
    # Cross-validation settings — passed through to the pySAR model config
    use_cv: bool = False
    cv_folds: int = 5

    @field_validator("file_path")
    @classmethod
    def _validate_file_path(cls, v: str) -> str:
        """Reject paths that escape the upload directory (path traversal guard)."""
        resolved = Path(v).resolve()
        if not str(resolved).startswith(str(UPLOAD_DIR.resolve())):
            raise ValueError("file_path must be within the server upload directory")
        return str(resolved)

    @field_validator("algorithm")
    @classmethod
    def _validate_algorithm(cls, v: str) -> str:
        """Normalise to lowercase and check against the known pySAR algorithm whitelist."""
        normalised = v.strip().lower()
        if normalised not in _VALID_ALGORITHMS:
            raise ValueError(
                f"algorithm {v!r} is not supported. "
                f"Valid options: {sorted(_VALID_ALGORITHMS)}"
            )
        return normalised

    @field_validator("n_jobs")
    @classmethod
    def _clamp_n_jobs(cls, v: int) -> int:
        """Cap n_jobs to the host CPU count to prevent thread pool exhaustion."""
        return min(max(1, v), os.cpu_count() or 4)


# ── Dataset helpers ─────────────────────────────────────────────────────────────

import re as _re
_UUID_RE = _re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    _re.IGNORECASE,
)


def _validate_file_id(file_id: str) -> None:
    """Raise 400 if file_id is not a valid UUID4-format string.

    Glob patterns accept metacharacters (*?[); validating before globbing prevents
    a crafted file_id from enumerating files in the upload directory.
    """
    if not _UUID_RE.match(file_id):
        raise HTTPException(status_code=400, detail="Invalid file_id format.")


def _read_dataset(file_path: str) -> pd.DataFrame:
    """Read a dataset file as a DataFrame, trying TSV then CSV."""
    path = Path(file_path)
    ext = path.suffix.lower()
    if ext == ".csv":
        return pd.read_csv(file_path)
    # .txt / .tsv — try tab separator first
    df = pd.read_csv(file_path, sep="\t")
    if len(df.columns) > 1:
        return df
    return pd.read_csv(file_path)


def _sequence_length_stats(df: pd.DataFrame, seq_col: str) -> Dict[str, Any]:
    """Return min/max/mean sequence length for a given column."""
    if seq_col not in df.columns:
        return {"min": 0, "max": 0, "mean": 0}
    lengths = df[seq_col].dropna().astype(str).str.len().tolist()
    if not lengths:
        return {"min": 0, "max": 0, "mean": 0}
    return {
        "min": int(min(lengths)),
        "max": int(max(lengths)),
        "mean": round(sum(lengths) / len(lengths), 1),
        "distribution": _length_histogram(lengths),
    }


# Standard + common ambiguous amino acid characters
_VALID_AA = set("ACDEFGHIKLMNPQRSTVWYacdefghiklmnpqrstvwyBZXUOJbzxuoj")


def _validate_sequences(df: pd.DataFrame, seq_col: str) -> Dict[str, Any]:
    """Check sequences for non-standard characters; return a validation report."""
    if seq_col not in df.columns:
        return {"valid": True, "invalid_count": 0, "warnings": [], "invalid_row_indices": [], "invalid_rows": []}
    warnings: List[str] = []
    invalid_count = 0
    invalid_indices: List[int] = []
    for idx, seq in df[seq_col].dropna().astype(str).items():
        bad = sorted({c for c in seq if c not in _VALID_AA and c.strip()})
        if bad:
            invalid_count += 1
            invalid_indices.append(int(idx))
            if len(warnings) < 5:  # show at most 5 sample warnings
                warnings.append(f"Row {idx}: unknown character(s) {bad} in '{seq[:20]}…'")
    # Collect row data for affected rows (cap at 50 rows)
    invalid_rows = df.loc[invalid_indices[:50]].fillna("").to_dict(orient="records") if invalid_indices else []
    return {
        "valid": invalid_count == 0,
        "invalid_count": invalid_count,
        "warnings": warnings,
        "invalid_row_indices": invalid_indices,
        "invalid_rows": invalid_rows,
    }


def _activity_histogram(series: pd.Series, bins: int = 20) -> List[Dict[str, Any]]:
    """Build a histogram for numeric activity values."""
    vals = series.dropna().tolist()
    if not vals:
        return []
    lo, hi = min(vals), max(vals)
    if lo == hi:
        return [{"bin": round(lo, 4), "count": len(vals)}]
    width = (hi - lo) / bins
    buckets: Dict[int, int] = {}
    for v in vals:
        b = int((v - lo) / width)
        b = min(b, bins - 1)
        buckets[b] = buckets.get(b, 0) + 1
    return [
        {"bin": round(lo + i * width, 4), "count": buckets.get(i, 0)}
        for i in range(bins)
    ]


def _length_histogram(lengths: List[int], bins: int = 20) -> List[Dict[str, Any]]:
    """Build a simple histogram for sequence length distribution."""
    if not lengths:
        return []
    lo, hi = min(lengths), max(lengths)
    if lo == hi:
        return [{"bin": lo, "count": len(lengths)}]
    width = (hi - lo) / bins
    buckets: Dict[int, int] = {}
    for ln in lengths:
        b = int((ln - lo) / width)
        b = min(b, bins - 1)
        buckets[b] = buckets.get(b, 0) + 1
    return [
        {"bin": round(lo + i * width), "count": buckets.get(i, 0)}
        for i in range(bins)
    ]


def _log_activity_histogram(series: pd.Series, bins: int = 20) -> List[Dict[str, Any]]:
    """Histogram of log-transformed (log1p) activity values for right-skewed targets."""
    log_vals = [math.log1p(v) for v in series.dropna() if v > -1]
    return _activity_histogram(pd.Series(log_vals), bins)


def _detect_duplicates(df: pd.DataFrame, seq_col: str) -> Dict[str, Any]:
    """Detect duplicate sequences; returns count of non-unique rows."""
    if seq_col not in df.columns:
        return {"has_duplicates": False, "duplicate_count": 0, "unique_count": len(df), "duplicate_row_indices": [], "duplicate_rows": []}
    total = len(df)
    unique = int(df[seq_col].dropna().nunique())
    duplicate_count = total - unique
    # Get indices of duplicate rows (all but the first occurrence of each sequence)
    dup_mask = df.duplicated(subset=[seq_col], keep="first")
    dup_indices = [int(i) for i in df.index[dup_mask].tolist()[:50]]
    dup_rows = df.loc[dup_indices].fillna("").to_dict(orient="records") if dup_indices else []
    return {
        "has_duplicates": duplicate_count > 0,
        "duplicate_count": duplicate_count,
        "unique_count": unique,
        "duplicate_row_indices": dup_indices,
        "duplicate_rows": dup_rows,
    }


def _check_missing(df: pd.DataFrame, seq_col: str, act_col: str) -> Dict[str, Any]:
    """Count missing / empty cells in the sequence and activity columns."""
    def _count_and_indices(col: str):
        if col not in df.columns:
            return 0, [], []
        na_mask = df[col].isna() | (df[col].astype(str).str.strip() == "")
        indices = [int(i) for i in df.index[na_mask].tolist()[:50]]
        rows = df.loc[indices].fillna("").to_dict(orient="records") if indices else []
        return int(na_mask.sum()), indices, rows
    seq_m, seq_indices, seq_rows = _count_and_indices(seq_col)
    act_m, act_indices, act_rows = _count_and_indices(act_col)
    return {
        "seq_missing": seq_m,
        "act_missing": act_m,
        "has_missing": seq_m > 0 or act_m > 0,
        "seq_missing_row_indices": seq_indices,
        "act_missing_row_indices": act_indices,
        "seq_missing_rows": seq_rows,
        "act_missing_rows": act_rows,
    }


def _detect_outliers(series: pd.Series, df: pd.DataFrame | None = None) -> Dict[str, Any]:
    """Flag activity values that are >3σ from the mean."""
    vals = series.dropna()
    if len(vals) < 4:
        return {"outlier_count": 0, "outlier_indices": [], "outlier_values": [], "outlier_rows": []}
    mean = float(vals.mean())
    std = float(vals.std())
    if std == 0:
        return {"outlier_count": 0, "outlier_indices": [], "outlier_values": [], "outlier_rows": []}
    mask = (vals - mean).abs() > 3 * std
    outliers = vals[mask]
    outlier_indices = [int(i) for i in outliers.index.tolist()[:50]]
    # Include full row data for each outlier so the frontend can display them
    outlier_rows = df.loc[outlier_indices].fillna("").to_dict(orient="records") if df is not None and outlier_indices else []
    return {
        "outlier_count": int(mask.sum()),
        "outlier_indices": outlier_indices,
        "outlier_values": [round(float(v), 4) for v in outliers.tolist()[:50]],
        "mean": round(mean, 4),
        "std": round(std, 4),
        "threshold_delta": round(3 * std, 4),
        "outlier_rows": outlier_rows,
    }


def _col_guess_confidence(df: pd.DataFrame, col: str, col_type: str) -> str:
    """Return 'high', 'medium', or 'low' confidence for an auto-guessed column."""
    name = col.lower()
    if col_type == "seq":
        if any(kw in name for kw in ("sequence", "seq", "protein", "peptide", "aa")):
            return "high"
        if col in df.columns:
            sample = df[col].dropna().astype(str).head(5).tolist()
            if sample and all(s.replace(" ", "").isalpha() for s in sample):
                return "medium"
        return "low"
    # act / target column
    if any(kw in name for kw in ("activity", "target", "label", "value", "score",
                                  "fitness", "stability", "t50", "tm")):
        return "high"
    if col in df.columns and pd.api.types.is_numeric_dtype(df[col]):
        return "medium"
    return "low"


# ── Config builder ──────────────────────────────────────────────────────────────

def _build_config(req: EncodeRequest) -> Dict[str, Any]:
    """Assemble the pySAR JSON config dict from an EncodeRequest."""
    return {
        "dataset": {
            "dataset": req.file_path,
            "sequence_col": req.sequence_col,
            "activity": req.activity_col,
        },
        "model": {
            "algorithm": req.algorithm,
            "parameters": req.model_parameters or {},
            "test_split": req.test_split,
            "use_cv": req.use_cv,
            "cv_folds": req.cv_folds,
        },
        "descriptors": req.descriptors_config or {},
        "pyDSP": req.dsp_config or {"use_dsp": 0},
    }


# ── Model count estimator ──────────────────────────────────────────────────────

_DEFAULT_DESC_COUNT = 33  # matches ALL_DESCRIPTORS in the frontend UI (pySAR v2.5.1)


def _estimate_total_models(req: EncodeRequest) -> int:
    """Estimate the number of models this encoding request will evaluate."""
    from math import comb as _comb

    if req.strategy == "aai":
        n = len(req.aai_indices) if req.aai_indices else 566
    elif req.strategy == "descriptor":
        n_desc = len(req.selected_descriptors) if req.selected_descriptors else _DEFAULT_DESC_COUNT
        combo = max(1, req.desc_combo or 1)
        n = sum(_comb(n_desc, k) for k in range(1, combo + 1))
    elif req.strategy == "aai_descriptor":
        n_aai = len(req.aai_indices) if req.aai_indices else 566
        n_desc = len(req.selected_descriptors) if req.selected_descriptors else _DEFAULT_DESC_COUNT
        combo = max(1, req.desc_combo or 1)
        n_desc_combos = sum(_comb(n_desc, k) for k in range(1, combo + 1))
        n = n_aai * n_desc_combos
    else:
        n = 0

    if req.max_models:
        n = min(n, req.max_models)
    return n


# ── Subprocess encoding worker ─────────────────────────────────────────────────

def _pySAR_encode_worker(
    queue: Any,
    encoding: Any,
    strategy: str,
    aai_indices: Optional[List[str]],
    selected_descriptors: Optional[List[str]],
    desc_combo: int,
    common: Dict[str, Any],
) -> None:
    """Runs pySAR encoding inside a forked subprocess and sends results via queue.

    Using a subprocess (rather than a thread) allows the parent to call
    proc.terminate() at any moment, which genuinely interrupts the blocking
    pySAR encoding loop — something that is impossible with Python threads.
    The queue carries at most one message: ("ok", df, y_test, y_pred) or ("error", msg).
    """
    # Redirect pySAR's automatic CSV output away from the project root.
    # pySAR writes result files to an `outputs/` folder relative to cwd;
    # by changing to a throwaway temp dir in this subprocess we prevent any
    # files accumulating in the repo. The parent process cwd is unaffected.
    _tmp_work_dir = tempfile.mkdtemp(prefix="pysar_enc_")
    os.chdir(_tmp_work_dir)
    try:
        if strategy == "aai":
            results_df = encoding.aai_encoding(aai_indices=aai_indices or None, **common)
        elif strategy == "descriptor":
            results_df = encoding.descriptor_encoding(
                descriptors=selected_descriptors or None, desc_combo=desc_combo, **common
            )
        elif strategy == "aai_descriptor":
            results_df = encoding.aai_descriptor_encoding(
                aai_indices=aai_indices or None,
                descriptors=selected_descriptors or None,
                desc_combo=desc_combo,
                **common,
            )
        else:
            raise ValueError(f"Unknown strategy: {strategy!r}")
        # Capture predicted vs actual from the encoding object before the child exits
        y_test = getattr(encoding, "y_test", None)
        y_pred = getattr(encoding, "y_pred", None)
        queue.put(("ok", results_df, y_test, y_pred))
    except Exception as exc:  # noqa: BLE001
        queue.put(("error", str(exc), None, None))
    finally:
        # Clean up the temp working dir (contains only pySAR's discarded CSV output)
        import shutil as _shutil
        try:
            _shutil.rmtree(_tmp_work_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass


# ── Job runner ──────────────────────────────────────────────────────────────────

def _run_job(job_id: str, req: EncodeRequest, cancel_event: Optional[threading.Event] = None) -> None:
    """Execute pySAR encoding in a background thread and update JOBS."""
    job = JOBS[job_id]
    short_id = job_id[:8]
    job_start = time.monotonic()

    def _log(msg: str) -> None:
        job["log"].append(msg)
        logger.info("[job:%s] %s", short_id, msg)

    def _cancelled() -> bool:
        """Return True if a cancel was requested (checks event + status flag)."""
        return (cancel_event is not None and cancel_event.is_set()) or job.get("status") == "cancelled"

    config_path: Optional[Path] = None
    try:
        logger.info(
            "[job:%s] Started — strategy=%s algorithm=%s n_jobs=%s max_models=%s",
            short_id, req.strategy, req.algorithm, req.n_jobs, req.max_models,
        )

        if _cancelled():
            _log("Cancelled before start.")
            return

        # Phase 1: build config
        job["status"] = "running"
        job["started_at"] = datetime.now(timezone.utc).isoformat()
        job["progress"] = 10
        _log("Preparing configuration…")
        config = _build_config(req)
        config_path = UPLOAD_DIR / f"{job_id}_config.json"
        config_path.write_text(json.dumps(config, indent=2))
        logger.info("[job:%s] Config written to %s", short_id, config_path)

        # Phase 2: load dataset via pySAR Encoding
        from pySAR.encoding import Encoding  # lazy import — pySAR may be heavy
        job["progress"] = 20
        _log("Initialising Encoding class…")
        t0 = time.monotonic()
        encoding = Encoding(config_file=str(config_path), verbose=False)
        _log(
            f"Dataset loaded: {encoding.num_seqs} sequences "
            f"× {encoding.sequence_length} residues "
            f"(took {time.monotonic() - t0:.1f}s)"
        )

        # Phase 3: estimate model count
        total_models = _estimate_total_models(req)
        job["total_models"] = total_models
        job["progress"] = 35
        logger.info("[job:%s] Estimated models: %s", short_id, total_models)

        # Common kwargs shared by all three encoding methods
        common: Dict[str, Any] = {
            "sort_by": req.sort_by,
            "n_jobs": req.n_jobs,
            "max_models": req.max_models,
            "sample_mode": req.sample_mode,
        }
        if req.random_state is not None:
            common["random_state"] = req.random_state

        model_hint = f" ({total_models:,} models estimated)" if total_models else ""
        _log(f"Strategy: {req.strategy} — starting encoding{model_hint}…")
        job["progress"] = 45

        if _cancelled():
            _log("Cancelled before encoding started.")
            return

        # Phase 4: run encoding in a child process so it can be terminated on cancel.
        # The child inherits the already-loaded `encoding` object via fork, so pySAR
        # does not need to re-import from scratch — only the encoding loop runs there.
        import threading as _threading
        _enc_start = time.monotonic()
        _est_secs  = max(1.0, (total_models or 10) * 0.5 / max(1, req.n_jobs))

        def _progress_ticker() -> None:
            while job.get("status") == "running" and job.get("progress", 0) < 95:
                time.sleep(1)
                _enc_elapsed = time.monotonic() - _enc_start
                # Ramp from 45 → 95 proportionally over the estimated duration
                _pct = min(95, int(45 + 50 * (_enc_elapsed / _est_secs)))
                job["progress"] = _pct
                # Also surface a live model count estimate to the frontend
                _done = int(total_models * ((_pct - 45) / 50)) if total_models else 0
                job["models_in_progress"] = _done

        _threading.Thread(target=_progress_ticker, daemon=True).start()

        # Start the subprocess
        _enc_queue = _MP_CTX.Queue()
        _enc_proc  = _MP_CTX.Process(
            target=_pySAR_encode_worker,
            args=(_enc_queue, encoding, req.strategy, req.aai_indices,
                  req.selected_descriptors, req.desc_combo, common),
            daemon=True,
        )
        _CANCEL_PROCESSES[job_id] = _enc_proc
        t_enc = time.monotonic()
        logger.info("[job:%s] Encoding subprocess starting — strategy=%s", short_id, req.strategy)
        _enc_proc.start()

        # Poll for the result while checking the cancel flag every 2 s
        _enc_result = None
        while True:
            if _cancelled():
                # Hard-terminate the subprocess immediately
                _enc_proc.terminate()
                _enc_proc.join(timeout=3)
                if _enc_proc.is_alive():
                    _enc_proc.kill()
                _CANCEL_PROCESSES.pop(job_id, None)
                _log("Cancelled — encoding process terminated.")
                return
            try:
                _enc_result = _enc_queue.get(timeout=2)
                break
            except _queue_mod.Empty:
                # Subprocess is still running — loop again
                if not _enc_proc.is_alive():
                    # Died without sending a result — killed by an OS signal
                    _CANCEL_PROCESSES.pop(job_id, None)
                    raise RuntimeError(_subprocess_exit_hint(_enc_proc.exitcode))

        _enc_proc.join(timeout=5)
        _CANCEL_PROCESSES.pop(job_id, None)

        # Unpack subprocess result
        _status_flag, *_payload = _enc_result
        if _status_flag == "error":
            # Re-raise the original error message from the subprocess
            raise RuntimeError(f"Encoding failed: {_payload[0]}")
        results_df = _payload[0]

        enc_elapsed = time.monotonic() - t_enc
        logger.info("[job:%s] Encoding subprocess finished in %.1fs", short_id, enc_elapsed)

        if _cancelled():
            _log("Cancelled after encoding — results discarded.")
            return

        # Phase 5: finalise results
        n_models = len(results_df)
        total_elapsed = time.monotonic() - job_start
        _log(f"Complete — {n_models} model(s) evaluated in {total_elapsed:.1f}s total.")
        logger.info("[job:%s] Job complete — %s model(s) | total=%.1fs enc=%.1fs", short_id, n_models, total_elapsed, enc_elapsed)
        job["status"] = "completed"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        job["progress"] = 100
        job["models_completed"] = n_models
        job["partial_results"] = results_df.head(10).to_dict(orient="records")  # top-10 preview
        job["results"] = results_df.to_dict(orient="records")
        job["columns"] = results_df.columns.tolist()

        # Phase 6: capture predicted vs actual for the best model
        try:
            _metric_cols = {"R2", "RMSE", "MSE", "MAE", "RPD", "Explained_Var"}
            id_col = next((c for c in results_df.columns if c not in _metric_cols), None)
            if id_col and len(results_df) > 0:
                best_id = str(results_df.iloc[0][id_col])
                _log(f"Fitting best model ({best_id}) for predicted-vs-actual plot…")
                # Re-run encoding with only the best model — fast single fit
                if req.strategy == "aai":
                    encoding.aai_encoding(aai_indices=[best_id], max_models=1, n_jobs=1, sort_by="R2")
                elif req.strategy == "descriptor":
                    encoding.descriptor_encoding(descriptors=[best_id], desc_combo=1, max_models=1, n_jobs=1, sort_by="R2")
                elif req.strategy == "aai_descriptor":
                    # For combined strategy, use best AAI index with all descriptors
                    encoding.aai_encoding(aai_indices=[best_id], max_models=1, n_jobs=1, sort_by="R2")
                y_test = getattr(encoding, "y_test", None)
                y_pred = getattr(encoding, "y_pred", None)
                if y_test is not None and y_pred is not None:
                    # Flatten to 1-D lists in case pySAR returns 2-D arrays
                    def _to_list(arr):
                        import numpy as _np
                        return [round(float(v), 6) for v in _np.ravel(arr)]
                    job["best_model_predictions"] = {
                        "model_name": best_id,
                        "actual":     _to_list(y_test),
                        "predicted":  _to_list(y_pred),
                    }
                    _log(f"Predictions captured: {len(job['best_model_predictions']['actual'])} test samples.")
        except Exception as _pred_exc:
            logger.warning("[job:%s] Could not capture best-model predictions: %s", short_id, _pred_exc)

    except Exception as exc:  # noqa: BLE001
        elapsed = time.monotonic() - job_start
        job["status"] = "failed"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        job["error"] = str(exc)
        _log(f"ERROR: {exc}")
        logger.exception("[job:%s] Job failed after %.1fs — %s", short_id, elapsed, exc)
    finally:
        if config_path and config_path.exists():
            try:
                config_path.unlink()
                logger.info("[job:%s] Temp config cleaned up", short_id)
            except Exception:  # noqa: BLE001
                pass


# ── API routes ──────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health() -> Dict[str, str]:
    """Liveness check."""
    logger.info("Health check requested")
    return {"status": "ok"}


@app.get("/api/aai-indices")
def get_aai_indices() -> Dict[str, List[str]]:
    """Return all AAI1 record codes for the frontend typeahead."""
    try:
        from aaindex import aaindex1
        codes = sorted(aaindex1.record_codes())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to load AAI indices: {exc}") from exc
    return {"indices": codes}


@app.get("/api/aai-indices-full")
def get_aai_indices_full() -> Dict[str, Any]:
    """Return all AAI1 records with code, title, category, pmid, and references."""
    try:
        from aaindex import aaindex1
        records = []
        for code in sorted(aaindex1.record_codes()):
            rec = aaindex1[code]
            records.append({
                "code": code,
                "title": getattr(rec, "description", "") or getattr(rec, "title", "") or code,
                "category": getattr(rec, "category", "") or "",
                "pmid": str(getattr(rec, "pmid", "") or ""),
                "references": getattr(rec, "references", "") or "",
            })
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to load AAI indices: {exc}") from exc
    return {"records": records}


# ── Static descriptor catalogue ────────────────────────────────────────────────
# Metadata for all supported protpy descriptors: name, category, description,
# approximate feature count, and whether it is configurable via metaparameters.

# Swiss-Prot average amino acid composition frequencies (%) used as reference values
# for the amino_acid_composition descriptor heatmap.
_SWISSPROT_FREQ = {
    "A": 8.25, "R": 5.53, "N": 4.06, "D": 5.45, "C": 1.37,
    "Q": 3.93, "E": 6.75, "G": 7.07, "H": 2.27, "I": 5.96,
    "L": 9.66, "K": 5.84, "M": 2.42, "F": 3.86, "P": 4.70,
    "S": 6.56, "T": 5.34, "W": 1.08, "Y": 2.92, "V": 6.87,
}

# Kyte-Doolittle hydrophobicity scale — the primary default property scale used by
# autocorrelation, CTD, and pseudo-composition descriptors.
_KD_HYDROPHOBICITY = {
    "A": 1.8,  "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5,
    "Q": -3.5, "E": -3.5, "G": -0.4, "H": -3.2, "I": 4.5,
    "L": 3.8,  "K": -3.9, "M": 1.9,  "F": 2.8,  "P": -1.6,
    "S": -0.8, "T": -0.7, "W": -0.9, "Y": -1.3, "V": 4.2,
}

_DESCRIPTOR_CATALOGUE = [
    {
        "name": "amino_acid_composition",
        "label": "Amino Acid Composition",
        "category": "Composition",
        "feature_count": 20,
        "configurable": False,
        "description": (
            "Fraction of each of the 20 standard amino acids in the sequence. "
            "Produces a 20-dimensional vector representing global amino acid usage."
        ),
        "aa_values": _SWISSPROT_FREQ,
        "aa_values_label": "Swiss-Prot average composition (%)",
    },
    {
        "name": "dipeptide_composition",
        "label": "Dipeptide Composition",
        "category": "Composition",
        "feature_count": 400,
        "configurable": False,
        "description": (
            "Fraction of all possible dipeptide (two-residue) combinations (20²). "
            "Captures local sequential information between adjacent residues."
        ),
    },
    {
        "name": "tripeptide_composition",
        "label": "Tripeptide Composition",
        "category": "Composition",
        "feature_count": 8000,
        "configurable": False,
        "description": (
            "Fraction of all possible tripeptide (three-residue) combinations (20³). "
            "High-dimensional but rich in local context; may require dimensionality reduction."
        ),
    },
    {
        "name": "moreaubroto_autocorrelation",
        "label": "Moran–Broto Autocorrelation",
        "category": "Autocorrelation",
        "feature_count": 240,
        "configurable": True,
        "description": (
            "Moreau–Broto autocorrelation based on physicochemical property scales. "
            "Measures the correlation between property values at residues separated by a given lag. "
            "Configurable: lag (default 30) and property scales."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity (default scale)",
    },
    {
        "name": "moran_autocorrelation",
        "label": "Moran Autocorrelation",
        "category": "Autocorrelation",
        "feature_count": 240,
        "configurable": True,
        "description": (
            "Moran autocorrelation normalised variant. Measures the spatial correlation of a "
            "physicochemical property along the sequence at defined lag values. "
            "Configurable: lag and property scales."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity (default scale)",
    },
    {
        "name": "geary_autocorrelation",
        "label": "Geary Autocorrelation",
        "category": "Autocorrelation",
        "feature_count": 240,
        "configurable": True,
        "description": (
            "Geary's C autocorrelation statistic. Sensitive to local variance in a physicochemical "
            "property at a given lag. Complements Moran autocorrelation. "
            "Configurable: lag and property scales."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity (default scale)",
    },
    {
        "name": "conjoint_triad",
        "label": "Conjoint Triad",
        "category": "Conjoint",
        "feature_count": 343,
        "configurable": False,
        "description": (
            "Groups the 20 amino acids into 7 classes based on dipole and side-chain volume; "
            "counts all triplet class combinations (7³ = 343). Captures structural and "
            "electrostatic environment features."
        ),
    },
    {
        "name": "ctd",
        "label": "CTD (Composition–Transition–Distribution)",
        "category": "CTD",
        "feature_count": 147,
        "configurable": True,
        "description": (
            "Encodes sequences via Composition (fraction in each class), Transition (frequency of "
            "adjacent class changes), and Distribution (position of the 1st, 25th, 50th, 75th and "
            "100th percentile). Configurable: property (default hydrophobicity) and 'all' flag."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity (default scale)",
    },
    {
        "name": "ctd_composition",
        "label": "CTD Composition",
        "category": "CTD",
        "feature_count": 21,  # 3 features × 7 properties (all_ctd=True default)
        "configurable": True,
        "description": (
            "Composition component of CTD: fraction of residues belonging to each of three "
            "physicochemical classes per property. Produces 3 features per property (21 total "
            "for all 7 properties with all_ctd=True). "
            "Configurable: property (default hydrophobicity) and 'all' flag."
        ),
    },
    {
        "name": "ctd_transition",
        "label": "CTD Transition",
        "category": "CTD",
        "feature_count": 21,  # 3 features × 7 properties (all_ctd=True default)
        "configurable": True,
        "description": (
            "Transition component of CTD: frequency of adjacent transitions between the three "
            "physicochemical classes. Produces 3 features per property (21 total for all 7 "
            "properties with all_ctd=True). "
            "Configurable: property (default hydrophobicity) and 'all' flag."
        ),
    },
    {
        "name": "ctd_distribution",
        "label": "CTD Distribution",
        "category": "CTD",
        "feature_count": 105,  # 15 features × 7 properties (all_ctd=True default)
        "configurable": True,
        "description": (
            "Distribution component of CTD: positions of the 1st, 25th, 50th, 75th, and last "
            "residue of each class as a percentage of sequence length. Produces 15 features per "
            "property (105 total for all 7 with all_ctd=True). "
            "Configurable: property (default hydrophobicity) and 'all' flag."
        ),
    },
    {
        "name": "sequence_order_coupling_number",
        "label": "Sequence Order Coupling Number",
        "category": "Sequence Order",
        "feature_count": 60,
        "configurable": True,
        "description": (
            "Captures sequence-order effects by computing correlation functions between residues "
            "at a given lag using a physicochemical distance matrix. "
            "Configurable: lag (default 30) and distance matrix."
        ),
    },
    {
        "name": "quasi_sequence_order",
        "label": "Quasi-Sequence Order",
        "category": "Sequence Order",
        "feature_count": 100,
        "configurable": True,
        "description": (
            "Extends amino acid composition with sequence-order coupling numbers. Balances "
            "composition-based and distance-based information. "
            "Configurable: lag, weight, and distance matrix."
        ),
    },
    {
        "name": "pseudo_amino_acid_composition",
        "label": "Pseudo Amino Acid Composition (PseAAC)",
        "category": "Pseudo Composition",
        "feature_count": 50,
        "configurable": True,
        "description": (
            "Augments amino acid composition with sequence-correlation factors derived from "
            "physicochemical properties, reducing information loss from pure composition. "
            "Configurable: λ (tier count, default 30), weight, and property scales."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity (default scale)",
    },
    {
        "name": "amphiphilic_pseudo_amino_acid_composition",
        "label": "Amphiphilic PseAAC",
        "category": "Pseudo Composition",
        "feature_count": 80,
        "configurable": True,
        "description": (
            "Variant of PseAAC that specifically incorporates hydrophobicity and hydrophilicity "
            "correlation factors, making it useful for membrane-active or amphiphilic peptides. "
            "Configurable: λ (default 30) and weight."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity (default scale)",
    },
    # ── New descriptors added in pySAR v2.5.1 / protpy v1.3.0 ──────────────────
    {
        "name": "gravy",
        "label": "GRAVY (Grand Average Hydropathicity)",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Mean of the Kyte-Doolittle hydropathy values across all residues. "
            "A positive value indicates overall hydrophobicity; negative indicates hydrophilicity."
        ),
        "aa_values": _KD_HYDROPHOBICITY,
        "aa_values_label": "Kyte-Doolittle hydrophobicity scale",
    },
    {
        "name": "aromaticity",
        "label": "Aromaticity",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": "Fraction of aromatic residues (F, W, Y, H) in the sequence.",
    },
    {
        "name": "instability_index",
        "label": "Instability Index",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Stability classifier based on dipeptide instability weight values (DIWV). "
            "Values below 40 indicate a stable protein; 40 or above indicates instability."
        ),
    },
    {
        "name": "isoelectric_point",
        "label": "Isoelectric Point",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Estimated pH at which the protein carries no net charge, calculated iteratively "
            "using standard pKa values for ionisable residues."
        ),
    },
    {
        "name": "molecular_weight",
        "label": "Molecular Weight",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Average molecular weight of the protein calculated from residue masses, "
            "corrected for water lost at each peptide bond."
        ),
    },
    {
        "name": "charge_distribution",
        "label": "Charge Distribution",
        "category": "Composition",
        "feature_count": 3,
        "configurable": True,
        "description": (
            "Positive, negative, and net charge of ionisable residues at a given pH "
            "using the Henderson-Hasselbalch equation. "
            "Configurable: ph (default 7.4)."
        ),
    },
    {
        "name": "hydrophobic_polar_charged_composition",
        "label": "Hydrophobic/Polar/Charged Composition",
        "category": "Composition",
        "feature_count": 3,
        "configurable": False,
        "description": (
            "Percentage of residues in each of three physicochemical groups: hydrophobic "
            "(A, C, F, I, L, M, V, W, Y), polar (G, N, Q, S, T), and charged (D, E, H, K, R)."
        ),
    },
    {
        "name": "secondary_structure_propensity",
        "label": "Secondary Structure Propensity",
        "category": "Composition",
        "feature_count": 3,
        "configurable": False,
        "description": (
            "Average Chou-Fasman propensity values for alpha-helix, beta-sheet, and random coil "
            "conformations across all residues."
        ),
    },
    {
        "name": "kmer_composition",
        "label": "k-mer Composition",
        "category": "Composition",
        "feature_count": 400,
        "configurable": True,
        "description": (
            "Frequency of all possible k-length residue subsequences as a percentage of total "
            "k-mers. Produces 20^k features (400 at default k=2). "
            "Configurable: k (default 2)."
        ),
    },
    {
        "name": "reduced_alphabet_composition",
        "label": "Reduced Alphabet Composition",
        "category": "Composition",
        "feature_count": 6,
        "configurable": True,
        "description": (
            "Amino acid composition after mapping residues to a reduced alphabet of physicochemical "
            "groups. Supported alphabet sizes: 2, 3, 4, 6. "
            "Configurable: alphabet_size (default 6)."
        ),
    },
    {
        "name": "motif_composition",
        "label": "Motif Composition",
        "category": "Composition",
        "feature_count": 8,
        "configurable": False,
        "description": (
            "Count of occurrences of 8 built-in biological sequence motifs (e.g. N-linked "
            "glycosylation, RGD integrin, zinc-finger CxxC, PEST degradation signal). "
            "Returns 8 features using the default built-in motif set."
        ),
    },
    {
        "name": "amino_acid_pair_composition",
        "label": "Amino Acid Pair Composition",
        "category": "Composition",
        "feature_count": 400,
        "configurable": False,
        "description": (
            "Frequency of all 400 residue-pair combinations with column names annotated by the "
            "physicochemical class of each residue (Hydrophobic, Polar, Charged, or Other)."
        ),
    },
    {
        "name": "aliphatic_index",
        "label": "Aliphatic Index",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Relative volume occupied by aliphatic side chains (Ala, Val, Ile, Leu). "
            "Higher values indicate greater thermostability. "
            "Formula: AI = Ala% + 2.9×Val% + 3.9×(Ile%+Leu%)."
        ),
    },
    {
        "name": "extinction_coefficient",
        "label": "Extinction Coefficient",
        "category": "Composition",
        "feature_count": 2,
        "configurable": False,
        "description": (
            "Molar extinction coefficient at 280 nm from Trp (W), Tyr (Y), and Cys (C) residues. "
            "Reported for both reduced (no disulfide bonds) and oxidised (all Cys paired) states."
        ),
    },
    {
        "name": "boman_index",
        "label": "Boman Index",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Sum of solubility values for amino acids divided by sequence length, predicting "
            "potential for protein–protein interactions. "
            "Positive values suggest membrane-binding or interaction potential."
        ),
    },
    {
        "name": "aggregation_propensity",
        "label": "Aggregation Propensity",
        "category": "Composition",
        "feature_count": 2,
        "configurable": False,
        "description": (
            "Estimates aggregation-prone regions via a sliding-window approach combining "
            "Kyte-Doolittle hydrophobicity and charge neutrality. "
            "Returns count of qualifying windows and the fraction of the sequence covered."
        ),
    },
    {
        "name": "hydrophobic_moment",
        "label": "Hydrophobic Moment",
        "category": "Composition",
        "feature_count": 2,
        "configurable": True,
        "description": (
            "Mean and maximum hydrophobic moment across sliding windows using the Eisenberg "
            "hydrophobicity scale and a helical-wheel projection. Captures amphipathicity of "
            "putative helix segments. "
            "Configurable: window (default 11), angle in degrees (default 100 for α-helix)."
        ),
    },
    {
        "name": "shannon_entropy",
        "label": "Shannon Entropy",
        "category": "Composition",
        "feature_count": 1,
        "configurable": False,
        "description": (
            "Information-theoretic measure of amino acid diversity. "
            "Computed as H = -Σ p_i log₂(p_i) where p_i is the fractional frequency of each "
            "amino acid type present. Range: 0 (single residue type) to ~4.32 bits (uniform)."
        ),
    },
]


@app.get("/api/descriptors")
def get_descriptors() -> Dict[str, Any]:
    """Return the full descriptor catalogue with metadata."""
    return {"descriptors": _DESCRIPTOR_CATALOGUE}


@app.post("/api/upload")
async def upload_dataset(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a dataset file and return column names, shape, and a row preview."""
    ext = Path(file.filename or "data").suffix.lower()
    if ext not in {".txt", ".csv", ".tsv"}:
        raise HTTPException(
            status_code=400,
            detail="Only .txt, .csv, and .tsv files are supported.",
        )

    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{file_id}{ext}"
    content = await file.read()
    # Reject files that exceed the size limit before writing to disk
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum upload size is {_MAX_UPLOAD_MB} MB.",
        )
    file_path.write_bytes(content)

    try:
        df = _read_dataset(str(file_path))
    except Exception as exc:  # noqa: BLE001
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc

    return _build_dataset_response(df, file_id, file.filename or "data", str(file_path))


@app.post("/api/upload-descriptors")
async def upload_descriptors_csv(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a pre-calculated descriptors CSV and return a preview."""
    ext = Path(file.filename or "descriptors.csv").suffix.lower()
    if ext not in {".csv", ".tsv", ".txt"}:
        raise HTTPException(status_code=400, detail="Only .csv, .tsv, and .txt files are supported.")

    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"desc_{file_id}{ext}"
    content = await file.read()
    # Reject files that exceed the size limit before writing to disk
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum upload size is {_MAX_UPLOAD_MB} MB.",
        )
    file_path.write_bytes(content)

    try:
        df = _read_dataset(str(file_path))
    except Exception as exc:  # noqa: BLE001
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse descriptors file: {exc}") from exc

    # Basic validation: must have numeric columns
    numeric_cols = df.select_dtypes(include="number").columns.tolist()
    if len(numeric_cols) == 0:
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Descriptors CSV must contain at least one numeric column.")

    return {
        "file_id": file_id,
        "file_path": str(file_path),
        "filename": file.filename,
        "columns": df.columns.tolist(),
        "numeric_columns": numeric_cols,
        "shape": list(df.shape),
        "preview": df.head(5).fillna("").to_dict(orient="records"),
    }



@app.get("/api/dataset/{file_id}/rows")
def get_all_rows(file_id: str) -> Dict[str, Any]:
    """Return all rows for an uploaded dataset (no row cap)."""
    _validate_file_id(file_id)
    # Reconstruct path by scanning UPLOAD_DIR for a file whose stem matches the id
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Dataset not found")
    try:
        df = _read_dataset(str(matches[0]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc
    return {"rows": df.fillna("").to_dict(orient="records"), "total": len(df)}


# ── Sample datasets ─────────────────────────────────────────────────────────────

_EXAMPLE_DATASETS_DIR = Path(__file__).resolve().parent.parent / "example_datasets"

_EXAMPLE_DATASETS = [
    {"name": "thermostability", "filename": "thermostability.txt",
     "description": "Enzyme thermostability (T50) — 261 protein variants"},
    {"name": "absorption", "filename": "absorption.txt",
     "description": "UV absorption wavelength — 179 fluorescent protein variants"},
    {"name": "enantioselectivity", "filename": "enantioselectivity.txt",
     "description": "Enzyme enantioselectivity — 152 lipase variants"},
    {"name": "localization", "filename": "localization.txt",
     "description": "Subcellular localization score — protein sequences"},
]


def _build_dataset_response(df: pd.DataFrame, file_id: str, filename: str,
                             file_path: str) -> Dict[str, Any]:
    """Shared logic for building an upload/sample-load API response from a DataFrame."""
    seq_guess = next((c for c in df.columns if "seq" in c.lower()), df.columns[0])
    _ACT_EXCLUDE = {"sequence", "seq", "id", "name", "is_train"}
    # Prefer numeric columns (skip the sequence column) when guessing the activity column
    _act_candidates = [c for c in df.columns if c != seq_guess and c.lower() not in _ACT_EXCLUDE]
    act_guess = next(
        (c for c in _act_candidates if pd.api.types.is_numeric_dtype(df[c])),
        _act_candidates[0] if _act_candidates else df.columns[-1],
    )
    is_numeric_act = act_guess in df.columns and pd.api.types.is_numeric_dtype(df[act_guess])
    act_series = df[act_guess] if is_numeric_act else None
    return {
        "file_id": file_id,
        "filename": filename,
        "file_path": file_path,
        "columns": df.columns.tolist(),
        "num_rows": len(df),
        "preview": df.head(20).fillna("").to_dict(orient="records"),
        "seq_col_guess": seq_guess,
        "act_col_guess": act_guess,
        "seq_guess_confidence": _col_guess_confidence(df, seq_guess, "seq"),
        "act_guess_confidence": _col_guess_confidence(df, act_guess, "act"),
        "length_stats": _sequence_length_stats(df, seq_guess),
        "activity_stats": (
            {
                "min": round(float(act_series.min()), 4),
                "max": round(float(act_series.max()), 4),
                "mean": round(float(act_series.mean()), 4),
                "std": round(float(act_series.std()), 4),
                "skewness": round(float(act_series.dropna().skew()), 3),
                "kurtosis": round(float(act_series.dropna().kurtosis()), 3),
                "histogram": _activity_histogram(act_series),
                "log_histogram": _log_activity_histogram(act_series),
            }
            if is_numeric_act else {}
        ),
        "seq_validation": _validate_sequences(df, seq_guess),
        "duplicate_info": _detect_duplicates(df, seq_guess),
        "missing_info": _check_missing(df, seq_guess, act_guess),
        "outlier_info": (
            _detect_outliers(act_series, df) if is_numeric_act
            else {"outlier_count": 0, "outlier_indices": [], "outlier_values": [], "outlier_rows": []}
        ),
    }


@app.get("/api/example-datasets")
def list_example_datasets() -> Dict[str, Any]:
    """Return the list of built-in example datasets with a few preview rows each."""
    enriched = []
    for entry in _EXAMPLE_DATASETS:
        item = {**entry, "columns": [], "preview_rows": []}
        src = _EXAMPLE_DATASETS_DIR / entry["filename"]
        if src.exists():
            try:
                df = _read_dataset(str(src))
                item["columns"] = df.columns.tolist()
                item["preview_rows"] = df.head(3).fillna("").to_dict(orient="records")
                item["num_rows"] = len(df)
            except Exception:
                pass  # fallback to empty preview
        enriched.append(item)
    return {"datasets": enriched}


@app.post("/api/example-dataset/{name}")
async def load_example_dataset(name: str) -> Dict[str, Any]:
    """Load a built-in example dataset and return the same shape as /api/upload."""
    entry = next((d for d in _EXAMPLE_DATASETS if d["name"] == name), None)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Sample dataset '{name}' not found")
    src = _EXAMPLE_DATASETS_DIR / entry["filename"]
    if not src.exists():
        raise HTTPException(status_code=500, detail="Sample dataset file not found on server")
    # Copy to upload dir with a fresh file_id so downstream jobs work normally
    file_id = str(uuid.uuid4())
    ext = src.suffix
    dest = UPLOAD_DIR / f"{file_id}{ext}"
    dest.write_bytes(src.read_bytes())
    try:
        df = _read_dataset(str(dest))
    except Exception as exc:  # noqa: BLE001
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse sample dataset: {exc}") from exc
    return _build_dataset_response(df, file_id, entry["filename"], str(dest))


@app.post("/api/dataset/{file_id}/deduplicate")
def deduplicate_dataset(file_id: str, seq_col: str) -> Dict[str, Any]:
    """Remove duplicate sequences and return a fresh file_id + updated stats."""
    _validate_file_id(file_id)
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Dataset not found")
    try:
        df = _read_dataset(str(matches[0]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc
    if seq_col not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{seq_col}' not found")
    deduped = df.drop_duplicates(subset=[seq_col])
    new_id = str(uuid.uuid4())
    new_path = UPLOAD_DIR / f"{new_id}.csv"
    deduped.to_csv(str(new_path), index=False)
    result = _build_dataset_response(deduped, new_id, matches[0].name, str(new_path))
    result["removed"] = len(df) - len(deduped)
    return result


@app.post("/api/dataset/{file_id}/fix-missing-sequences")
def fix_missing_sequences(file_id: str, seq_col: str, act_col: str) -> Dict[str, Any]:
    """Drop rows where the sequence column is null or empty and return a fresh dataset."""
    _validate_file_id(file_id)
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Dataset not found")
    try:
        df = _read_dataset(str(matches[0]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc
    if seq_col not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{seq_col}' not found")
    # Identify rows with null or whitespace-only sequences
    null_mask = df[seq_col].isna() | (df[seq_col].astype(str).str.strip() == "")
    removed = int(null_mask.sum())
    fixed_df = df[~null_mask].reset_index(drop=True)
    new_id = str(uuid.uuid4())
    new_path = UPLOAD_DIR / f"{new_id}.csv"
    fixed_df.to_csv(str(new_path), index=False)
    result = _build_dataset_response(fixed_df, new_id, matches[0].name, str(new_path))
    result["removed"] = removed
    result["fix_method"] = "remove_rows"
    return result


@app.post("/api/dataset/{file_id}/fix-missing-activity")
def fix_missing_activity(
    file_id: str,
    seq_col: str,
    act_col: str,
    method: str = "mean",
) -> Dict[str, Any]:
    """
    Remediate missing activity values.

    method values:
      mean   — fill nulls with the column mean
      median — fill nulls with the column median
      remove — drop rows with null activity
    """
    _validate_file_id(file_id)
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Dataset not found")
    try:
        df = _read_dataset(str(matches[0]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc
    if act_col not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{act_col}' not found")
    if method not in ("mean", "median", "remove"):
        raise HTTPException(status_code=400, detail="method must be 'mean', 'median', or 'remove'")

    null_mask = df[act_col].isna() | (df[act_col].astype(str).str.strip() == "")
    affected = int(null_mask.sum())

    fixed_df = df.copy()
    if method == "remove":
        fixed_df = df[~null_mask].reset_index(drop=True)
    else:
        # Convert to numeric first; coerce errors to NaN so we can fill them
        numeric_col = pd.to_numeric(fixed_df[act_col], errors="coerce")
        fill_value = float(numeric_col.mean() if method == "mean" else numeric_col.median())
        fixed_df[act_col] = numeric_col.fillna(fill_value)

    new_id = str(uuid.uuid4())
    new_path = UPLOAD_DIR / f"{new_id}.csv"
    fixed_df.to_csv(str(new_path), index=False)
    result = _build_dataset_response(fixed_df, new_id, matches[0].name, str(new_path))
    result["affected"] = affected
    result["fix_method"] = method
    return result


@app.post("/api/dataset/{file_id}/fix-outliers")
def fix_outliers(
    file_id: str,
    seq_col: str,
    act_col: str,
    method: str = "winsorize",
) -> Dict[str, Any]:
    """
    Remediate outlier activity values (>3σ from mean).

    method values:
      winsorize — clamp values to [mean - 3σ, mean + 3σ]
      remove    — drop rows whose activity is an outlier
    """
    _validate_file_id(file_id)
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Dataset not found")
    try:
        df = _read_dataset(str(matches[0]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc
    if act_col not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{act_col}' not found")
    if method not in ("winsorize", "remove", "mean"):
        raise HTTPException(status_code=400, detail="method must be 'winsorize', 'mean', or 'remove'")

    numeric_col = pd.to_numeric(df[act_col], errors="coerce")
    vals = numeric_col.dropna()
    if len(vals) < 4:
        raise HTTPException(status_code=400, detail="Not enough numeric activity values to detect outliers")

    mean_v = float(vals.mean())
    std_v = float(vals.std())
    lo = mean_v - 3 * std_v
    hi = mean_v + 3 * std_v
    outlier_mask = (numeric_col - mean_v).abs() > 3 * std_v
    affected = int(outlier_mask.sum())

    fixed_df = df.copy()
    fixed_df[act_col] = numeric_col  # ensure numeric type
    if method == "winsorize":
        # Clamp outlier values to the 3σ boundary
        fixed_df[act_col] = numeric_col.clip(lower=lo, upper=hi)
    elif method == "mean":
        # Replace outlier values with the column mean
        fixed_df.loc[outlier_mask, act_col] = round(mean_v, 4)
    else:  # remove
        fixed_df = df[~outlier_mask].reset_index(drop=True)

    new_id = str(uuid.uuid4())
    new_path = UPLOAD_DIR / f"{new_id}.csv"
    fixed_df.to_csv(str(new_path), index=False)
    result = _build_dataset_response(fixed_df, new_id, matches[0].name, str(new_path))
    result["affected"] = affected
    result["fix_method"] = method
    return result


# Per-job cancel events; keyed by job_id
_CANCEL_EVENTS: Dict[str, threading.Event] = {}

# Per-job subprocess handles; used to forcefully terminate encoding on cancel
_CANCEL_PROCESSES: Dict[str, "_mp.Process"] = {}

# Multiprocessing context — fork inherits parent sys.path and loaded modules so pySAR
# does not need to be re-imported from scratch in every subprocess.
# NOTE: on macOS, fork after numpy/BLAS/Objective-C initialisation can cause SIGSEGV
# due to Apple's fork-safety mechanism. Set the env var before any Process.start() call
# so that child processes inherit it and the Objective-C fork-safety check is disabled.
# This is safe to set here because it only affects Objective-C runtime behaviour in
# forked children; it has no effect on Linux.
if sys.platform == "darwin":
    os.environ.setdefault("OBJC_DISABLE_INITIALIZE_FORK_SAFETY", "YES")

_MP_CTX = _mp.get_context("fork")


@app.post("/api/encode")
def start_encoding(req: EncodeRequest, request: Request) -> Dict[str, str]:
    """Submit an encoding job; returns a job_id for polling."""
    # Per-IP concurrent job limit — count pending/running jobs for this client
    ip = _get_client_ip(request)
    running_count = sum(
        1 for j in JOBS.values()
        if j.get("status") in ("pending", "running") and j.get("ip") == ip
    )
    if running_count >= _MAX_CONCURRENT_JOBS_PER_IP:
        logger.warning(
            "Concurrent job limit exceeded: ip=%s running=%s/%s",
            ip, running_count, _MAX_CONCURRENT_JOBS_PER_IP,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"Too many active jobs. Maximum {_MAX_CONCURRENT_JOBS_PER_IP} "
                "concurrent jobs per IP — wait for a running job to finish."
            ),
        )

    job_id = str(uuid.uuid4())
    logger.info(
        "[job:%s] Encode request received — strategy=%s algorithm=%s file=%s",
        job_id[:8], req.strategy, req.algorithm, req.file_path,
    )
    cancel_event = threading.Event()
    _CANCEL_EVENTS[job_id] = cancel_event
    JOBS[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": 0,
        "models_completed": 0,    # updated after encoding completes
        "models_in_progress": 0,  # live estimate updated by ticker thread
        "total_models": 0,         # estimated before encoding starts
        "partial_results": [],     # top-10 rows populated on completion
        "log": [],
        "results": None,
        "columns": [],
        "best_model_predictions": None,
        "error": None,
        "strategy": req.strategy,
        "algorithm": req.algorithm,
        "ip": ip,                  # stored for concurrent job counting
        "created_at": datetime.now(timezone.utc).isoformat(),
        "started_at": None,
        "completed_at": None,
    }
    thread = threading.Thread(target=_run_job, args=(job_id, req, cancel_event), daemon=True)
    thread.start()
    logger.info("[job:%s] Background thread started", job_id[:8])
    return {"job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> Dict[str, str]:
    """Request cancellation of a running job.

    Returns 200 even if the job is unknown (e.g. it ran on a different Cloud Run
    instance) so the frontend always treats the click as successful.
    """
    _validate_file_id(job_id)
    if job_id not in JOBS:
        # Job may live on a different container instance — treat as already stopped
        logger.info("[job:%s] Cancel requested but job not found on this instance (already done or different instance)", job_id[:8])
        return {"cancelled": job_id}
    # Signal the cancel event so the thread detects it between phase boundaries
    if job_id in _CANCEL_EVENTS:
        _CANCEL_EVENTS[job_id].set()
    # Immediately terminate the encoding subprocess if it is running
    if job_id in _CANCEL_PROCESSES:
        proc = _CANCEL_PROCESSES.pop(job_id)
        proc.terminate()
        logger.info("[job:%s] Encoding subprocess terminated by cancel request", job_id[:8])
    job = JOBS[job_id]
    if job["status"] in {"pending", "running"}:
        job["status"] = "cancelled"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        job["log"].append("Cancelled by user.")
        logger.info("[job:%s] Cancelled by user", job_id[:8])
    return {"cancelled": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    """Return the current status and (when done) results for a job."""
    _validate_file_id(job_id)
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JOBS[job_id]


@app.get("/api/jobs")
def list_jobs() -> List[Dict[str, Any]]:
    """List all jobs (metadata only, no results payload)."""
    return [
        {k: v for k, v in j.items() if k not in {"results"}}
        for j in JOBS.values()
    ]


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> Dict[str, str]:
    """Remove a job from the registry."""
    _validate_file_id(job_id)
    JOBS.pop(job_id, None)
    return {"deleted": job_id}


@app.get("/api/version")
def get_version() -> Dict[str, str]:
    """Return backend, pySAR, and Python version strings for diagnostics."""
    import sys as _sys
    pysar_version = "unknown"
    try:
        import importlib.metadata as _meta
        pysar_version = _meta.version("pysar")
    except Exception:  # noqa: BLE001
        try:
            from pySAR import __version__ as _v
            pysar_version = _v
        except Exception:  # noqa: BLE001
            pass
    return {
        "backend_version": "2.5.1",
        "pysar_version": pysar_version,
        "python_version": _sys.version,
    }
