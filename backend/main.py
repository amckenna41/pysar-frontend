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
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

# Force single-threaded BLAS *before* numpy is imported (via pandas below) — these
# libraries read their thread-count env vars once at load time. Encoding subprocesses
# are forked from this already multi-threaded server process (see _MP_CTX below); a
# BLAS/OpenMP worker thread caught mid-operation at fork time can leave its internal
# lock permanently held in the child, hanging or crashing it. With BLAS forced to one
# thread there are no such worker threads to be caught, which removes that failure mode
# entirely. This also avoids oversubscription, since parallelism here is already
# handled at the model level via n_jobs.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import pandas as pd
from collections import defaultdict
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, field_validator, model_validator

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
    _load_jobs_from_db()
    threading.Thread(target=_prewarm_pysar, daemon=True).start()
    threading.Thread(target=_cleanup_upload_dir, daemon=True, name="cleanup").start()
    yield


# Single source of truth for the backend version — surfaced by /api/version and the
# OpenAPI schema. Bump here on release (mirrors the CHANGELOG / git tag).
BACKEND_VERSION = "2.5.6"

app = FastAPI(title="pySAR API", version=BACKEND_VERSION, docs_url="/api/docs", lifespan=lifespan)

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
    # Custom response headers are invisible to browser JS unless explicitly exposed —
    # the frontend reads X-Session-Id off every response to persist/refresh its session.
    expose_headers=["X-Session-Id"],
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


# Number of trusted reverse-proxy hops in front of this app (Cloud Run / GCLB / Fly = 1).
# Set TRUST_PROXY_HOPS to that count when deployed behind a proxy; leave 0 for direct exposure.
def _trust_proxy_hops() -> int:
    raw = os.environ.get("TRUST_PROXY_HOPS")
    if raw is not None:
        try:
            return max(0, int(raw))
        except ValueError:
            return 0
    # Back-compat: legacy TRUST_PROXY=true is treated as exactly one trusted hop.
    return 1 if os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes") else 0


_TRUST_PROXY_HOPS = _trust_proxy_hops()


def _get_client_ip(request: Request) -> str:
    """Return the client IP, resistant to X-Forwarded-For spoofing.

    The last _TRUST_PROXY_HOPS entries of X-Forwarded-For are appended by trusted
    infrastructure and cannot be forged by the client; everything to their LEFT is
    client-controlled. We therefore read the entry _TRUST_PROXY_HOPS positions from the
    RIGHT — never the leftmost, which a client could rotate per-request to mint a fresh
    rate-limit / concurrent-job bucket and bypass both abuse controls. Falls back to the
    socket peer when the header is absent or has fewer hops than expected.
    """
    if _TRUST_PROXY_HOPS > 0:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            parts = [p.strip() for p in forwarded_for.split(",") if p.strip()]
            if len(parts) >= _TRUST_PROXY_HOPS:
                return parts[-_TRUST_PROXY_HOPS]
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

# Per-job persisted best-model artifacts (pickled sklearn model + scaler) live here,
# one subdirectory per job. Used by the model-download and /predict endpoints (feature 2).
_MODELS_DIR = UPLOAD_DIR / "models"
_MODELS_DIR.mkdir(parents=True, exist_ok=True)

# In-memory job registry — remains the live source of truth while a job is running
# (fast, no per-tick DB round trip for the progress ticker). Write-through persisted to
# SQLite below at creation and at every terminal transition, and reloaded on startup, so
# job HISTORY survives a process restart/redeploy. An in-flight job's subprocess/thread
# can't itself be resumed after a restart — that would need a real external task queue —
# so this fixes history durability and ownership, not live-job resumption.
JOBS: Dict[str, Dict[str, Any]] = {}

# Guards the "count this IP's running jobs, then reserve a slot" sequence in
# start_encoding so concurrent requests from the same IP can't all pass the
# count check before any of them actually inserts a job (TOCTOU race).
_JOBS_ADMISSION_LOCK = threading.Lock()

# ── Persistent job store (SQLite) ───────────────────────────────────────────────
_JOBS_DB_PATH = UPLOAD_DIR / "jobs.sqlite3"
_jobs_db_lock = threading.Lock()
_jobs_db_conn = sqlite3.connect(str(_JOBS_DB_PATH), check_same_thread=False)
_jobs_db_conn.execute("PRAGMA journal_mode=WAL")
_jobs_db_conn.execute(
    "CREATE TABLE IF NOT EXISTS jobs ("
    "  job_id TEXT PRIMARY KEY,"
    "  session_id TEXT,"
    "  status TEXT,"
    "  data TEXT NOT NULL"
    ")"
)
_jobs_db_conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id)")
_jobs_db_conn.commit()


def _persist_job(job_id: str) -> None:
    """Write-through the current in-memory snapshot of a job into SQLite.

    Called at job creation and at terminal status transitions only (not on every
    progress tick) — persisting mid-flight progress has no payoff since the encoding
    subprocess/thread producing it dies with the process regardless of what's on disk.
    """
    job = JOBS.get(job_id)
    if job is None:
        return
    try:
        with _jobs_db_lock:
            _jobs_db_conn.execute(
                "INSERT INTO jobs (job_id, session_id, status, data) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(job_id) DO UPDATE SET "
                "session_id=excluded.session_id, status=excluded.status, data=excluded.data",
                (job_id, job.get("session_id"), job.get("status"), json.dumps(job)),
            )
            _jobs_db_conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[job:%s] Failed to persist job to SQLite: %s", job_id[:8], exc)


def _delete_persisted_job(job_id: str) -> None:
    try:
        with _jobs_db_lock:
            _jobs_db_conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            _jobs_db_conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[job:%s] Failed to delete persisted job from SQLite: %s", job_id[:8], exc)


def _load_jobs_from_db() -> None:
    """Repopulate the in-memory JOBS cache from SQLite on startup.

    Any job still 'pending'/'running' at the time of a restart is marked 'failed' —
    its subprocess/thread is gone and cannot make further progress — so polling
    clients get a definitive terminal status instead of hanging forever.
    """
    try:
        with _jobs_db_lock:
            rows = _jobs_db_conn.execute("SELECT job_id, data FROM jobs").fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to load persisted jobs from SQLite: %s", exc)
        return
    restored = 0
    for job_id, data in rows:
        try:
            job = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            continue
        was_incomplete = job.get("status") in ("pending", "running")
        if was_incomplete:
            job["status"] = "failed"
            job["error"] = "Server restarted while this job was in progress."
            job["completed_at"] = job.get("completed_at") or datetime.now(timezone.utc).isoformat()
        JOBS[job_id] = job
        # Re-register any share token so shared links survive a restart (feature 10).
        _tok = job.get("share_token")
        if _tok:
            _SHARE_TOKENS[_tok] = job_id
        if was_incomplete:
            _persist_job(job_id)  # write the corrected terminal status back to disk
        restored += 1
    if restored:
        logger.info("Restored %s job(s) from persistent store", restored)

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

        # ── Prune dataset-owner entries whose upload file is gone ──────────────
        try:
            existing_ids = {_file_id_from_path(str(f)) for f in UPLOAD_DIR.iterdir() if f.is_file()}
            with _DATASET_OWNERS_LOCK:
                stale_ids = [fid for fid in _DATASET_OWNERS if fid not in existing_ids]
                for fid in stale_ids:
                    _DATASET_OWNERS.pop(fid, None)
            if stale_ids:
                logger.info("Dataset-owner cleanup: pruned %s stale entr(ies)", len(stale_ids))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Dataset-owner cleanup error: %s", exc)

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
            _delete_persisted_job(jid)
            _delete_job_model_dir(jid)
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
            _delete_persisted_job(jid)
            _delete_job_model_dir(jid)
        if ghost_jobs:
            logger.info("JOBS cleanup: pruned %s ghost job(s)", len(ghost_jobs))

        # ── Prune orphaned share tokens whose job is gone (feature 10) ─────────
        with _SHARE_LOCK:
            orphan_tokens = [t for t, jid in _SHARE_TOKENS.items() if jid not in JOBS]
            for t in orphan_tokens:
                _SHARE_TOKENS.pop(t, None)

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

class _JobError(RuntimeError):
    """A job failure carrying a stable machine-readable code alongside the human message.

    The code lands in job['error_code'] so the frontend can branch on it (e.g. show a
    "reduce dataset size" hint for 'oom') instead of pattern-matching the free-text message.
    """
    def __init__(self, message: str, code: str = "job_error") -> None:
        super().__init__(message)
        self.code = code


def _subprocess_exit_code(exitcode: Optional[int]) -> str:
    """Map an abnormal subprocess exit code to a stable error_code token."""
    if exitcode == -11:  # SIGSEGV
        return "segfault"
    if exitcode == -9:   # SIGKILL — typically OOM
        return "oom"
    return "subprocess_terminated"


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

# Hard wall-clock ceiling on a single job's encoding phase. Paired with the
# max_models/desc_combo caps below, this stops a single client from monopolizing the
# one-instance backend indefinitely — a request could otherwise stay just under the
# model-count ceiling yet still run for hours depending on dataset size/algorithm.
#
# Deployment note: encoding runs in a daemon background thread (see /api/encode), so
# this cap is NOT bound by the platform's HTTP request timeout — /encode returns a
# job_id immediately and the client polls. The load-bearing platform requirement is
# that CPU stays allocated between the (short) poll requests: Cloud Run gets this via
# --no-cpu-throttling + --min-instances=1 (see cloudbuild.yaml). On platforms that
# throttle idle CPU or spin down between requests, raise MAX_JOB_DURATION_SECS's
# effective limit won't help — the thread simply pauses/dies. Keep this default well
# under any platform hard cap on instance lifetime.
_MAX_JOB_DURATION_SECS = int(os.environ.get("MAX_JOB_DURATION_SECS", 1800))  # default 30 min

# Maximum accepted upload size; overridable via MAX_UPLOAD_MB env var
_MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", 10))
_MAX_UPLOAD_BYTES = _MAX_UPLOAD_MB * 1024 * 1024

# Hard ceiling on the number of models a single /api/encode request may evaluate.
# Requests estimated above this must set max_models to stay under it (see start_encoding).
_MAX_ESTIMATED_MODELS = int(os.environ.get("MAX_ESTIMATED_MODELS", 20000))


def _check_bounded_payload(
    v: Optional[Dict[str, Any]],
    *,
    field_name: str,
    max_keys: int = 50,
    max_depth: int = 4,
    max_str_len: int = 2000,
) -> None:
    """Raise ValueError if a request-supplied dict is pathologically large or deep."""

    def _walk(obj: Any, depth: int) -> None:
        if depth > max_depth:
            raise ValueError(f"{field_name} is nested too deeply (max depth {max_depth}).")
        if isinstance(obj, dict):
            if len(obj) > max_keys:
                raise ValueError(f"{field_name} has too many keys (max {max_keys}).")
            for val in obj.values():
                _walk(val, depth + 1)
        elif isinstance(obj, list):
            if len(obj) > max_keys:
                raise ValueError(f"{field_name} list is too long (max {max_keys} items).")
            for item in obj:
                _walk(item, depth + 1)
        elif isinstance(obj, str) and len(obj) > max_str_len:
            raise ValueError(f"{field_name} contains a string longer than {max_str_len} characters.")

    if v:
        _walk(v, 0)


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
    # Task type — regression (pySAR-native) or classification (parallel path, feature 4)
    task_type: Literal["regression", "classification"] = "regression"
    # Encoding strategy — the first three are pySAR-native; "embedding" uses protein
    # language-model embeddings (feature 5), gated on optional torch/transformers deps.
    strategy: Literal["aai", "descriptor", "aai_descriptor", "embedding"] = "aai"
    # PLM checkpoint for the embedding strategy (ignored by the other strategies).
    embedding_model: Optional[str] = Field(default=None, max_length=200)
    # Length-bounded so a hostile body can't ship a giant array that inflates memory
    # before the model-count ceiling is checked. 566 AAI indices and 33 descriptors
    # exist in total, so these caps are comfortably above any legitimate request.
    aai_indices: Optional[List[str]] = Field(default=None, max_length=600)
    selected_descriptors: Optional[List[str]] = Field(default=None, max_length=100)
    desc_combo: int = Field(default=1, ge=1, le=5)
    # Encoding tuning — sort_by must be a recognised metric column
    sort_by: Literal["R2", "RMSE", "MSE", "MAE", "RPD", "Explained_Var"] = "R2"
    n_jobs: int = 1
    max_models: Optional[int] = Field(default=None, gt=0)
    sample_mode: bool = False
    random_state: Optional[int] = None
    # Cross-validation settings — passed through to the pySAR model config
    use_cv: bool = False
    cv_folds: int = 5
    # Optional webhook POSTed once when the job reaches a terminal state (feature 10).
    # Point it at a Slack/Zapier/email-relay incoming hook. SSRF-guarded at fire time.
    notify_webhook: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("notify_webhook")
    @classmethod
    def _validate_webhook(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not v.strip():
            return None
        v = v.strip()
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("notify_webhook must be an http(s) URL.")
        return v

    @field_validator("file_path")
    @classmethod
    def _validate_file_path(cls, v: str) -> str:
        """Reject paths that escape the upload directory (path traversal guard)."""
        resolved = Path(v).resolve()
        if not resolved.is_relative_to(UPLOAD_DIR.resolve()):
            raise ValueError("file_path must be within the server upload directory")
        return str(resolved)

    @field_validator("algorithm")
    @classmethod
    def _normalise_algorithm(cls, v: str) -> str:
        """Normalise to lowercase/stripped; the task-aware whitelist check is below."""
        return v.strip().lower()

    @model_validator(mode="after")
    def _validate_algorithm_for_task(self) -> "EncodeRequest":
        """Check the algorithm against the whitelist for the chosen task_type.

        Regression uses pySAR's estimators; classification uses the parallel sklearn
        classifier layer (feature 4), which has a different set of valid names.
        """
        if self.task_type == "classification":
            from backend.classification import VALID_CLASSIFIERS
            if self.algorithm not in VALID_CLASSIFIERS:
                raise ValueError(
                    f"algorithm {self.algorithm!r} is not a supported classifier. "
                    f"Valid options: {sorted(VALID_CLASSIFIERS)}"
                )
        elif self.algorithm not in _VALID_ALGORITHMS:
            raise ValueError(
                f"algorithm {self.algorithm!r} is not supported. "
                f"Valid options: {sorted(_VALID_ALGORITHMS)}"
            )
        return self

    @field_validator("n_jobs")
    @classmethod
    def _clamp_n_jobs(cls, v: int) -> int:
        """Cap n_jobs to the host CPU count to prevent thread pool exhaustion."""
        return min(max(1, v), os.cpu_count() or 4)

    @field_validator("test_split")
    @classmethod
    def _validate_test_split(cls, v: float) -> float:
        if not (0.0 < v < 1.0):
            raise ValueError("test_split must be between 0 and 1 (exclusive).")
        return v

    @field_validator("cv_folds")
    @classmethod
    def _validate_cv_folds(cls, v: int) -> int:
        if not (2 <= v <= 20):
            raise ValueError("cv_folds must be between 2 and 20.")
        return v

    @field_validator("aai_indices", "selected_descriptors")
    @classmethod
    def _bound_string_list(cls, v: Optional[List[str]], info) -> Optional[List[str]]:
        """Cap each entry's length — AAI codes and descriptor names are short tokens."""
        if v:
            for item in v:
                if not isinstance(item, str) or len(item) > 64:
                    raise ValueError(
                        f"{info.field_name} entries must be strings of at most 64 characters."
                    )
        return v

    @field_validator("model_parameters", "descriptors_config", "dsp_config")
    @classmethod
    def _validate_payload_shape(cls, v: Optional[Dict[str, Any]], info) -> Optional[Dict[str, Any]]:
        """Reject pathologically large/deep payloads before they reach pySAR/sklearn.

        These dicts are forwarded near-verbatim, so per-key range validation would need
        a full schema per algorithm/descriptor; this bounds size/depth as a cheap
        backstop against malformed or hostile bodies crashing the worker.
        """
        _check_bounded_payload(v, field_name=info.field_name)
        return v


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


# ── Dataset ownership ────────────────────────────────────────────────────────────
# file_id -> session_id map for uploaded datasets. In-memory only, mirroring the
# ephemeral nature of the upload scratch files (swept after 6h). The unguessable UUID4
# file id is the primary access control; this adds session-scoped defense in depth so
# one client can't read or transform another's dataset even if a file_id leaks (logs,
# shared screen, etc.) — matching the ownership model already applied to jobs.
_DATASET_OWNERS: Dict[str, str] = {}
_DATASET_OWNERS_LOCK = threading.Lock()


def _register_dataset(file_id: str, session_id: str) -> None:
    with _DATASET_OWNERS_LOCK:
        _DATASET_OWNERS[file_id] = session_id


def _check_dataset_owner(file_id: str, session_id: str) -> None:
    """Raise 404 if this session is known not to own the dataset.

    Unknown file ids (e.g. created before a restart wiped the map) are allowed through:
    the UUID is unguessable, so absence of a record is treated as 'cannot prove foreign
    ownership' rather than a hard denial that would break legitimate post-restart access.
    """
    owner = _DATASET_OWNERS.get(file_id)
    if owner is not None and owner != session_id:
        # Same 404 as "missing" so ownership status isn't leaked.
        raise HTTPException(status_code=404, detail="Dataset not found")


def _file_id_from_path(file_path: str) -> Optional[str]:
    """Extract the UUID stem from an upload file path (handles the 'desc_' prefix)."""
    stem = Path(file_path).stem
    if stem.startswith("desc_"):
        stem = stem[len("desc_"):]
    return stem if _UUID_RE.match(stem) else None


def _read_dataset(file_path: str) -> pd.DataFrame:
    """Read a dataset file as a DataFrame, trying TSV then CSV."""
    path = Path(file_path)
    ext = path.suffix.lower()
    if ext == ".csv":
        return pd.read_csv(file_path)
    # .txt / .tsv — try tab, then comma, then any-whitespace (README documents all three).
    df = pd.read_csv(file_path, sep="\t")
    if len(df.columns) > 1:
        return df
    df = pd.read_csv(file_path)
    if len(df.columns) > 1:
        return df
    # Fall back to whitespace-delimited (e.g. space-separated .txt) — engine='python'
    # is required for a regex separator.
    return pd.read_csv(file_path, sep=r"\s+", engine="python")


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

_DEFAULT_DESC_COUNT = 33  # matches ALL_DESCRIPTORS in the frontend UI (pySAR v2.5.6)


def _raw_model_count(req: EncodeRequest) -> int:
    """Compute how many models this request would evaluate, ignoring any max_models cap."""
    from math import comb as _comb

    if req.strategy == "embedding":
        return 1  # a single mean-pooled embedding feature set → one model
    if req.strategy == "aai":
        return len(req.aai_indices) if req.aai_indices else 566
    if req.strategy == "descriptor":
        n_desc = len(req.selected_descriptors) if req.selected_descriptors else _DEFAULT_DESC_COUNT
        combo = max(1, req.desc_combo or 1)
        return sum(_comb(n_desc, k) for k in range(1, combo + 1))
    if req.strategy == "aai_descriptor":
        n_aai = len(req.aai_indices) if req.aai_indices else 566
        n_desc = len(req.selected_descriptors) if req.selected_descriptors else _DEFAULT_DESC_COUNT
        combo = max(1, req.desc_combo or 1)
        n_desc_combos = sum(_comb(n_desc, k) for k in range(1, combo + 1))
        return n_aai * n_desc_combos
    return 0


def _estimate_total_models(req: EncodeRequest) -> int:
    """Estimate the number of models this encoding request will evaluate, capped by max_models."""
    n = _raw_model_count(req)
    if req.max_models:
        n = min(n, req.max_models)
    return n


# ── Classification grid (feature 4) ─────────────────────────────────────────────

def _classification_grid(
    encoding: Any,
    strategy: str,
    aai_indices: Optional[List[str]],
    selected_descriptors: Optional[List[str]],
    desc_combo: int,
    clf: Dict[str, Any],
):
    """Run a classification grid over the requested encodings, reusing pySAR's
    build_features for X and the self-contained classification layer for metrics.

    Returns (results_df, best_extras) where results_df mirrors the regression results
    shape (id column + metric columns) so the rest of the pipeline is unchanged.
    """
    import pandas as _pd
    from itertools import combinations as _combinations
    from backend import classification as _clf

    activity = getattr(encoding, "activity", None)
    if activity is None:
        raise RuntimeError("Dataset has no activity/label column for classification.")

    algorithm = clf["algorithm"]
    params = clf.get("parameters") or {}
    test_split = clf.get("test_split", 0.2)
    random_state = clf.get("random_state")
    max_models = clf.get("max_models")

    rows: List[Dict[str, Any]] = []
    best: Dict[str, Any] = {}

    def _record(id_fields: Dict[str, Any], X) -> None:
        Xv = X.to_numpy(dtype=float) if hasattr(X, "to_numpy") else X
        res = _clf.evaluate_classifier(Xv, activity, algorithm, params, test_split, random_state)
        row = {**id_fields, "Accuracy": res["Accuracy"], "F1": res["F1"],
               "AUC": res["AUC"], "Precision": res["Precision"], "Recall": res["Recall"]}
        rows.append(row)
        if not best or (res["Accuracy"] or 0) > (best["res"]["Accuracy"] or 0):
            best.update({"res": res, "id_fields": id_fields})

    def _desc_combos() -> List[tuple]:
        descs = selected_descriptors or []
        out: List[tuple] = []
        for k in range(1, (desc_combo or 1) + 1):
            out.extend(_combinations(descs, k))
        return out

    if strategy == "aai":
        from aaindex import aaindex1
        indices = aai_indices or list(aaindex1.record_codes())
        if max_models:
            indices = indices[:max_models]
        for code in indices:
            _record({"Index": code}, encoding.build_features(feature_type="aai", index=code))
    elif strategy == "descriptor":
        from pySAR.descriptors import Descriptors
        desc_instance = Descriptors(config_file=encoding.config_file)
        combos = _desc_combos()
        if max_models:
            combos = combos[:max_models]
        for combo in combos:
            entry = combo if len(combo) > 1 else combo[0]
            X = encoding.build_features(feature_type="descriptor", descriptor_entry=entry, desc_instance=desc_instance)
            _record({"Descriptor": "+".join(combo)}, X)
    else:  # aai_descriptor
        from pySAR.descriptors import Descriptors
        from aaindex import aaindex1
        desc_instance = Descriptors(config_file=encoding.config_file)
        indices = aai_indices or list(aaindex1.record_codes())
        pairs = [(i, c) for i in indices for c in _desc_combos()]
        if max_models:
            pairs = pairs[:max_models]
        for idx, combo in pairs:
            entry = combo if len(combo) > 1 else combo[0]
            X = encoding.build_features(feature_type="aai_descriptor", index=idx,
                                        descriptor_entry=entry, desc_instance=desc_instance)
            _record({"Index": idx, "Descriptor": "+".join(combo)}, X)

    if not rows:
        raise RuntimeError("Classification produced no results — check the selected encodings.")
    df = _pd.DataFrame(rows).sort_values("Accuracy", ascending=False).reset_index(drop=True)
    r = best.get("res", {})
    best_extras = {
        "confusion_matrix": r.get("confusion_matrix"),
        "classes": r.get("classes"),
        "y_test": r.get("y_test"),
        "y_pred": r.get("y_pred"),
        # Winning encoding id + fitted artifacts so the parent can persist a downloadable
        # model and enable /predict for classification (parity with regression). These are
        # stripped before the extras are stored on the (JSON-serialised) job dict.
        "id_fields": best.get("id_fields"),
        "_model": r.get("_model"),
        "_scaler": r.get("_scaler"),
        "_label_encoder": r.get("_label_encoder"),
    } if r else None
    return df, best_extras


# ── Subprocess encoding worker ─────────────────────────────────────────────────

def _pySAR_encode_worker(
    queue: Any,
    encoding: Any,
    strategy: str,
    aai_indices: Optional[List[str]],
    selected_descriptors: Optional[List[str]],
    desc_combo: int,
    common: Dict[str, Any],
    task_type: str = "regression",
    clf: Optional[Dict[str, Any]] = None,
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
        if task_type == "classification":
            # Parallel classifier path — pySAR itself is regression-only (feature 4).
            results_df, best_extras = _classification_grid(
                encoding, strategy, aai_indices, selected_descriptors, desc_combo, clf or {}
            )
            queue.put(("ok_clf", results_df, best_extras, None))
            return
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


# ── Best-model artifacts: export, feature importance, per-fold CV (features 2/3/6) ──

# sort_by metric -> sklearn scoring string for cross-validation (feature 6).
_SORT_TO_SCORER = {
    "R2": "r2", "RMSE": "neg_root_mean_squared_error", "MSE": "neg_mean_squared_error",
    "MAE": "neg_mean_absolute_error", "RPD": "r2", "Explained_Var": "explained_variance",
}


def _feature_importance_from_model(model: Any, feature_names: Optional[List[str]] = None,
                                   top_n: int = 25) -> Optional[Dict[str, Any]]:
    """Extract top-N feature importances from a fitted sklearn estimator.

    Prefers tree-based ``feature_importances_``; falls back to linear ``coef_`` magnitude.
    Returns None for estimators exposing neither (KNN, RBF-SVR, GPR) so the UI can hide
    the panel rather than show a fake ranking.
    """
    import numpy as _np
    kind = "importance"
    imp = getattr(model, "feature_importances_", None)
    if imp is None:
        coef = getattr(model, "coef_", None)
        if coef is None:
            return None
        imp = _np.abs(_np.ravel(_np.asarray(coef, dtype=float)))
        kind = "coefficient"
    imp = _np.ravel(_np.asarray(imp, dtype=float))
    if imp.size == 0:
        return None
    n = int(imp.size)
    names = feature_names if (feature_names and len(feature_names) == n) else [f"feature_{i}" for i in range(n)]
    order = _np.argsort(imp)[::-1][: min(top_n, n)]
    return {
        "kind": kind,
        "total_features": n,
        "top": [{"feature": str(names[i]), "importance": round(float(imp[i]), 6)} for i in order],
    }


def _capture_best_model_artifacts(encoding: Any, req: "EncodeRequest", model_dir: Path,
                                  job: Dict[str, Any], log_fn) -> None:
    """Load the pySAR-exported best_model.pkl and derive importance + CV (best-effort).

    pySAR's export_best_model=True (passed on the Phase-6 refit) has already refit the
    winning encoding and pickled {'model', 'scaler'} to ``model_dir/best_model.pkl``.
    Everything here is wrapped so a failure only drops the extra panels — the job's core
    results and predicted-vs-actual are unaffected.
    """
    import pickle as _pickle
    pkl = model_dir / "best_model.pkl"
    if not pkl.exists():
        return
    job["model_available"] = True
    job["model_path"] = str(pkl)

    try:
        with open(pkl, "rb") as fh:
            payload = _pickle.load(fh)
        model = payload.get("model") if isinstance(payload, dict) else payload
    except Exception as exc:  # noqa: BLE001
        logger.warning("[job:%s] Could not load exported model: %s", job.get("job_id", "?")[:8], exc)
        return

    # Feature importance (feature 3)
    try:
        fi = _feature_importance_from_model(model)
        if fi is not None:
            job["feature_importance"] = fi
            log_fn(f"Feature importance captured ({fi['kind']}, {fi['total_features']} features).")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[job:%s] Feature importance failed: %s", job.get("job_id", "?")[:8], exc)

    # Per-fold cross-validation (feature 6) — only when the user requested CV.
    if not req.use_cv:
        return
    try:
        from pySAR.model import Model as _PyModel
        import numpy as _np
        # Rebuild the winning feature matrix; only the AAI path is reconstructed cheaply.
        # Other strategies fall back to the pickled model's expected dimensionality via a
        # skip, keeping this best-effort rather than deeply coupling to pySAR internals.
        X = getattr(encoding, "_last_best_features", None)
        Y = getattr(encoding, "activity", None)
        if X is None or Y is None:
            return
        scorer = _SORT_TO_SCORER.get(req.sort_by, "r2")
        m = _PyModel(X=_np.asarray(X, dtype=float), Y=_np.asarray(Y, dtype=float),
                     algorithm=req.algorithm, parameters=req.model_parameters or {},
                     test_split=req.test_split)
        m.train_test_split(test_split=req.test_split, random_state=req.random_state)
        scores = m.cv_score(cv=req.cv_folds, metric=scorer, n_jobs=1)
        vals = [round(float(v), 6) for v in _np.ravel(scores)]
        # Report as positive values for the 'neg_*' scorers so the UI reads naturally.
        if scorer.startswith("neg_"):
            vals = [round(-v, 6) for v in vals]
        job["cv_scores"] = {
            "metric": req.sort_by, "folds": req.cv_folds, "scores": vals,
            "mean": round(sum(vals) / len(vals), 6) if vals else None,
            "std": round(float(_np.std(vals)), 6) if vals else None,
        }
        log_fn(f"Cross-validation captured: {req.cv_folds}-fold {req.sort_by}.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[job:%s] CV capture failed: %s", job.get("job_id", "?")[:8], exc)


def _persist_classification_best_model(job_id: str, req: "EncodeRequest",
                                       job: Dict[str, Any], extras: Dict[str, Any]) -> None:
    """Persist the classification grid's winning model + set best_config for /predict.

    The regression path refits & exports via pySAR (Phase 6); classification already
    fit its estimators in the grid, so we just pickle the best one here and record the
    winning encoding so _predict_sequences can rebuild the identical feature space.

    Mutates `extras` in place to drop the non-JSON-serialisable artifacts, since the
    remaining dict is stored on the job (which is JSON-persisted / returned by the API).
    """
    import pickle as _pickle
    model = extras.pop("_model", None)
    scaler = extras.pop("_scaler", None)
    label_encoder = extras.pop("_label_encoder", None)
    id_fields = extras.pop("id_fields", None) or {}
    if model is None:
        return
    model_dir = _MODELS_DIR / job_id
    model_dir.mkdir(parents=True, exist_ok=True)
    pkl = model_dir / "best_model.pkl"
    with open(pkl, "wb") as fh:
        _pickle.dump({"model": model, "scaler": scaler, "label_encoder": label_encoder}, fh)
    job["model_available"] = True
    job["model_path"] = str(pkl)

    fi = _feature_importance_from_model(model)
    if fi:
        job["feature_importance"] = fi

    # Winning encoding → best_config (same shape as the regression path).
    if req.strategy == "aai":
        best_id = str(id_fields.get("Index", ""))
        job["best_config"] = {"strategy": "aai", "aai_indices": [best_id],
                              "descriptors": None, "desc_combo": 1}
        job["best_model_name"] = best_id
    elif req.strategy == "descriptor":
        _bd = str(id_fields.get("Descriptor", "")).split("+")
        job["best_config"] = {"strategy": "descriptor", "aai_indices": None,
                              "descriptors": _bd, "desc_combo": len(_bd)}
        job["best_model_name"] = "+".join(_bd)
    else:  # aai_descriptor
        _ba = str(id_fields.get("Index", ""))
        _bd = str(id_fields.get("Descriptor", "")).split("+")
        job["best_config"] = {"strategy": "aai_descriptor", "aai_indices": [_ba],
                              "descriptors": _bd, "desc_combo": len(_bd)}
        job["best_model_name"] = f"{_ba}+{'+'.join(_bd)}"


# ── Completion webhook (feature 10) ──────────────────────────────────────────────

def _webhook_target_is_safe(url: str) -> bool:
    """SSRF guard: allow only public hosts, blocking private/loopback/link-local IPs."""
    import ipaddress
    import socket
    from urllib.parse import urlparse
    try:
        host = urlparse(url).hostname
        if not host:
            return False
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if (ip.is_private or ip.is_loopback or ip.is_link_local
                    or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
                return False
        return True
    except Exception:  # noqa: BLE001
        return False


def _fire_webhook(job: Dict[str, Any]) -> None:
    """POST a compact completion payload to the job's webhook, once, best-effort."""
    url = job.get("notify_webhook")
    if not url or job.get("webhook_fired"):
        return
    job["webhook_fired"] = True  # set first so a retry storm can't double-fire
    if not _webhook_target_is_safe(url):
        logger.warning("[job:%s] Webhook target blocked (private/unresolvable host)", job.get("job_id", "?")[:8])
        return

    def _send() -> None:
        try:
            import requests
            best = None
            if job.get("results"):
                best = job["results"][0]
            requests.post(url, json={
                "job_id": job.get("job_id"),
                "status": job.get("status"),
                "error_code": job.get("error_code"),
                "strategy": job.get("strategy"),
                "algorithm": job.get("algorithm"),
                "models_completed": job.get("models_completed"),
                "best_model": job.get("best_model_name"),
                "best_result": best,
                "completed_at": job.get("completed_at"),
            }, timeout=10, allow_redirects=False)  # don't let a public URL 302 past the SSRF guard to an internal host
            # ponytail: DNS-rebind window between _webhook_target_is_safe and here remains;
            # pin the resolved IP only if this webhook ever becomes a real attack target.
            logger.info("[job:%s] Completion webhook sent", job.get("job_id", "?")[:8])
        except Exception as exc:  # noqa: BLE001
            logger.warning("[job:%s] Webhook POST failed: %s", job.get("job_id", "?")[:8], exc)

    threading.Thread(target=_send, daemon=True, name="webhook").start()


# ── Embedding job runner (feature 5) ─────────────────────────────────────────────

def _run_embedding_job(job_id: str, req: "EncodeRequest", job: Dict[str, Any],
                       log_fn, cancelled_fn, job_start: float) -> None:
    """Self-contained PLM-embedding job: embed → train one model → metrics + export.

    Bypasses pySAR (which can't consume arbitrary embedding matrices). Regression uses
    pySAR's Model for a picklable estimator identical to the other strategies;
    classification uses the parallel sklearn layer. Any failure propagates to _run_job's
    handler, which marks the job failed with the message.
    """
    import numpy as _np
    import pandas as _pd
    import pickle as _pickle
    from backend.embeddings import embed_sequences, DEFAULT_MODEL

    df = _read_dataset(req.file_path)
    if req.sequence_col not in df.columns or req.activity_col not in df.columns:
        raise RuntimeError("Configured sequence/activity column not found in dataset.")
    valid = df[req.sequence_col].notna() & df[req.activity_col].notna()
    seqs = df.loc[valid, req.sequence_col].astype(str).str.upper().str.strip().tolist()
    y_raw = df.loc[valid, req.activity_col].tolist()
    model_name = req.embedding_model or DEFAULT_MODEL

    job["total_models"] = 1
    job["progress"] = 30
    log_fn(f"Embedding {len(seqs)} sequences with {model_name}…")
    X = embed_sequences(seqs, model_name)
    if cancelled_fn():
        log_fn("Cancelled during embedding.")
        return
    job["progress"] = 70
    model_dir = _MODELS_DIR / job_id
    model_dir.mkdir(parents=True, exist_ok=True)
    pkl = model_dir / "best_model.pkl"

    if req.task_type == "classification":
        from backend import classification as _clf
        res = _clf.evaluate_classifier(X, y_raw, req.algorithm, req.model_parameters or {},
                                       req.test_split, req.random_state)
        results = [{"Encoding": model_name, "Accuracy": res["Accuracy"], "F1": res["F1"],
                    "AUC": res["AUC"], "Precision": res["Precision"], "Recall": res["Recall"]}]
        job["classification"] = {k: res[k] for k in ("confusion_matrix", "classes", "y_test", "y_pred")}
        with open(pkl, "wb") as fh:
            _pickle.dump({"model": res["_model"], "scaler": res["_scaler"],
                          "label_encoder": res["_label_encoder"]}, fh)
        fi = _feature_importance_from_model(res["_model"])
    else:
        from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error, explained_variance_score
        from pySAR.model import Model as _PyModel
        m = _PyModel(X=X, Y=_np.asarray(y_raw, dtype=float), algorithm=req.algorithm,
                     parameters=req.model_parameters or {}, test_split=req.test_split)
        _, _, _, y_test = m.train_test_split(test_split=req.test_split, random_state=req.random_state)
        m.fit()
        y_pred = m.predict()
        yt, yp = _np.ravel(y_test), _np.ravel(y_pred)
        rmse = float(mean_squared_error(yt, yp)) ** 0.5
        std = float(_np.std(yt)) or 1.0
        results = [{"Encoding": model_name,
                    "R2": round(float(r2_score(yt, yp)), 4), "RMSE": round(rmse, 4),
                    "MSE": round(float(mean_squared_error(yt, yp)), 4),
                    "MAE": round(float(mean_absolute_error(yt, yp)), 4),
                    "RPD": round(std / rmse, 4) if rmse else 0.0,
                    "Explained_Var": round(float(explained_variance_score(yt, yp)), 4)}]
        job["best_model_predictions"] = {"model_name": model_name,
                                         "actual": [round(float(v), 6) for v in yt],
                                         "predicted": [round(float(v), 6) for v in yp]}
        m.save(str(model_dir), model_name="best_model.pkl")
        fi = _feature_importance_from_model(m.model)

    job["model_available"] = True
    job["model_path"] = str(pkl)
    job["best_model_name"] = model_name
    job["best_config"] = {"strategy": "embedding", "embedding_model": model_name}
    if fi:
        job["feature_importance"] = fi
    job["results"] = results
    job["partial_results"] = results
    job["columns"] = list(results[0].keys())
    job["models_completed"] = 1
    job["status"] = "completed"
    job["completed_at"] = datetime.now(timezone.utc).isoformat()
    job["progress"] = 100
    log_fn(f"Embedding job complete in {time.monotonic() - job_start:.1f}s — 1 model evaluated.")


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
            "[job:%s] ── ENCODING PROCESS STARTED ─────────────────────────────────────────\n"
            "  Job ID     : %s\n"
            "  Strategy   : %s\n"
            "  Algorithm  : %s\n"
            "  Seq col    : %s  →  Act col: %s\n"
            "  n_jobs     : %s  |  max_models: %s  |  sort_by: %s\n"
            "  Test split : %.0f%%  |  CV: %s%s",
            short_id, job_id,
            req.strategy, req.algorithm,
            req.sequence_col, req.activity_col,
            req.n_jobs, req.max_models or "unlimited", req.sort_by,
            req.test_split * 100,
            f"{req.cv_folds}-fold" if req.use_cv else "disabled",
            f"  |  random_state: {req.random_state}" if req.random_state is not None else "",
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
        # Persist the exact pySAR config so /predict can rebuild the identical feature
        # space (full pyDSP/descriptors shape), only swapping in the input sequences.
        job["encode_config"] = config

        # Embedding strategy bypasses pySAR entirely — it's a single self-contained
        # feature set (feature 5). Runs in this thread; the mean-pool + single fit are
        # fast relative to the model download, which is cached across jobs.
        if req.strategy == "embedding":
            _run_embedding_job(job_id, req, job, _log, _cancelled, job_start)
            return

        # Phase 2: load dataset via pySAR Encoding
        from pySAR.encoding import Encoding  # lazy import — pySAR may be heavy
        job["progress"] = 20
        _log("Initialising Encoding class…")
        t0 = time.monotonic()
        encoding = Encoding(config_file=str(config_path), verbose=False)
        _load_elapsed = time.monotonic() - t0
        _log(
            f"Dataset loaded — {encoding.num_seqs} sequences "
            f"× {encoding.sequence_length} residues "
            f"(took {_load_elapsed:.1f}s)"
        )
        logger.info(
            "[job:%s]   Dataset    : %s sequences, %s residues per sequence (load: %.1fs)",
            short_id, encoding.num_seqs, encoding.sequence_length, _load_elapsed,
        )

        # Phase 3: estimate model count
        total_models = _estimate_total_models(req)
        job["total_models"] = total_models
        job["progress"] = 35
        logger.info("[job:%s]   Est. models: %s", short_id, total_models if total_models else "unknown")

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

        # Log a preview of what will be encoded
        if req.strategy in ("aai", "aai_descriptor") and req.aai_indices:
            _n = len(req.aai_indices)
            _preview = ", ".join(req.aai_indices[:8])
            logger.info(
                "[job:%s]   AAI indices: %s selected — [%s%s]",
                short_id, _n, _preview, ", …" if _n > 8 else "",
            )
        elif req.strategy == "aai" and not req.aai_indices:
            logger.info("[job:%s]   AAI indices: all 566 (no filter applied)", short_id)
        if req.strategy in ("descriptor", "aai_descriptor") and req.selected_descriptors:
            _n = len(req.selected_descriptors)
            _preview = ", ".join(req.selected_descriptors[:8])
            logger.info(
                "[job:%s]   Descriptors: %s selected — [%s%s]  combo=%s",
                short_id, _n, _preview, ", …" if _n > 8 else "", req.desc_combo,
            )

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
        _clf_params = {
            "algorithm": req.algorithm, "parameters": req.model_parameters or {},
            "test_split": req.test_split, "random_state": req.random_state,
            "max_models": req.max_models,
        }
        _enc_queue = _MP_CTX.Queue()
        _enc_proc  = _MP_CTX.Process(
            target=_pySAR_encode_worker,
            args=(_enc_queue, encoding, req.strategy, req.aai_indices,
                  req.selected_descriptors, req.desc_combo, common,
                  req.task_type, _clf_params),
            daemon=True,
        )
        _CANCEL_PROCESSES[job_id] = _enc_proc
        t_enc = time.monotonic()
        logger.info(
            "[job:%s] Encoding subprocess starting — strategy=%s  pid=pending",
            short_id, req.strategy,
        )
        _enc_proc.start()
        logger.info("[job:%s]   Subprocess PID: %s", short_id, _enc_proc.pid)

        # Poll for the result while checking the cancel flag and wall-clock timeout every 2 s
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
            if time.monotonic() - job_start > _MAX_JOB_DURATION_SECS:
                _enc_proc.terminate()
                _enc_proc.join(timeout=3)
                if _enc_proc.is_alive():
                    _enc_proc.kill()
                _CANCEL_PROCESSES.pop(job_id, None)
                raise _JobError(
                    f"Job exceeded the maximum allowed duration of {_MAX_JOB_DURATION_SECS}s "
                    "and was terminated. Try lowering max_models, desc_combo, or n_jobs.",
                    code="timeout",
                )
            try:
                _enc_result = _enc_queue.get(timeout=2)
                break
            except _queue_mod.Empty:
                # Subprocess is still running — loop again
                if not _enc_proc.is_alive():
                    # multiprocessing.Queue.put() hands the item to a background feeder
                    # thread that flushes it to the pipe asynchronously; a fast-finishing
                    # child can exit right after put() before this get() observes it.
                    # By the time is_alive() is False the feeder thread has necessarily
                    # finished (process exit joins it), so any result is already sitting
                    # in the pipe — do one final non-blocking-ish drain before concluding
                    # the process actually died without sending a result.
                    try:
                        _enc_result = _enc_queue.get(timeout=2)
                        break
                    except _queue_mod.Empty:
                        _CANCEL_PROCESSES.pop(job_id, None)
                        raise _JobError(
                            _subprocess_exit_hint(_enc_proc.exitcode),
                            code=_subprocess_exit_code(_enc_proc.exitcode),
                        )

        _enc_proc.join(timeout=5)
        _CANCEL_PROCESSES.pop(job_id, None)

        # Unpack subprocess result
        _status_flag, *_payload = _enc_result
        if _status_flag == "error":
            # Re-raise the original error message from the subprocess
            raise _JobError(f"Encoding failed: {_payload[0]}", code="encoding_error")
        results_df = _payload[0]
        # Classification path carries the best model's confusion matrix + labels (feature 4).
        _clf_extras = _payload[1] if (_status_flag == "ok_clf" and len(_payload) > 1) else None
        if _clf_extras:
            # Persist the winning model + best_config (pops the fitted artifacts out of
            # _clf_extras) so the download and /predict endpoints work for classification.
            _persist_classification_best_model(job_id, req, job, _clf_extras)
            job["classification"] = _clf_extras

        enc_elapsed = time.monotonic() - t_enc

        if _cancelled():
            _log("Cancelled after encoding — results discarded.")
            return

        # Phase 5: finalise results
        n_models = len(results_df)
        total_elapsed = time.monotonic() - job_start
        _log(f"Complete — {n_models} model(s) evaluated in {total_elapsed:.1f}s total.")
        logger.info(
            "[job:%s] ── ENCODING PROCESS COMPLETE ───────────────────────────────────────\n"
            "  Models evaluated : %s\n"
            "  Encoding time    : %.1fs\n"
            "  Total job time   : %.1fs",
            short_id, n_models, enc_elapsed, total_elapsed,
        )
        job["status"] = "completed"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        job["progress"] = 100
        job["models_completed"] = n_models
        job["partial_results"] = results_df.head(10).to_dict(orient="records")  # top-10 preview
        job["results"] = results_df.to_dict(orient="records")
        job["columns"] = results_df.columns.tolist()

        # Phase 6: capture predicted vs actual for the best model (regression only —
        # the classification path already returned its confusion matrix + labels above).
        try:
            _metric_cols = {"R2", "RMSE", "MSE", "MAE", "RPD", "Explained_Var"}
            id_col = next((c for c in results_df.columns if c not in _metric_cols), None)
            if req.task_type == "regression" and id_col and len(results_df) > 0:
                _best_row = results_df.iloc[0].to_dict()
                best_id = str(_best_row[id_col])
                _metrics_str = "  ".join(
                    f"{k}={round(float(v), 4)}" for k, v in _best_row.items()
                    if k != id_col and isinstance(v, (int, float))
                )
                logger.info(
                    "[job:%s]   Best model : %s\n"
                    "  Metrics    : %s",
                    short_id, best_id, _metrics_str or "(no metrics)",
                )
                _log(f"Fitting best model ({best_id}) for predicted-vs-actual plot…")
                # Re-run encoding with only the best model — fast single fit.
                # Descriptor labels may be a '+'-joined combo (desc_combo > 1); split back
                # into individual descriptor names so the refit matches the exact feature
                # set that produced the reported metrics, not just the first descriptor.
                # export_best_model=True makes pySAR pickle {model, scaler} into model_dir
                # for the download + /predict endpoints (feature 2).
                model_dir = _MODELS_DIR / job_id
                model_dir.mkdir(parents=True, exist_ok=True)
                _ofolder = str(model_dir)
                model_name = best_id
                if req.strategy == "aai":
                    encoding.aai_encoding(aai_indices=[best_id], max_models=1, n_jobs=1, sort_by="R2",
                                          export_best_model=True, output_folder=_ofolder)
                    # Cheaply reconstruct the winning feature matrix for CV (feature 6).
                    try:
                        encoding._last_best_features = encoding.build_features(feature_type="aai", index=best_id)
                    except Exception:  # noqa: BLE001
                        encoding._last_best_features = None
                elif req.strategy == "descriptor":
                    best_descriptors = best_id.split("+")
                    encoding.descriptor_encoding(
                        descriptors=best_descriptors, desc_combo=len(best_descriptors),
                        max_models=1, n_jobs=1, sort_by="R2",
                        export_best_model=True, output_folder=_ofolder,
                    )
                elif req.strategy == "aai_descriptor":
                    # id_col resolves to "Index" (the first non-metric column); the
                    # descriptor half of the best pair lives in the "Descriptor" column
                    # and must be refit too, or the predictions reflect an AAI-only model.
                    best_aai = str(_best_row.get("Index", best_id))
                    best_descriptors = str(_best_row.get("Descriptor", "")).split("+")
                    encoding.aai_descriptor_encoding(
                        aai_indices=[best_aai], descriptors=best_descriptors,
                        desc_combo=len(best_descriptors), max_models=1, n_jobs=1, sort_by="R2",
                        export_best_model=True, output_folder=_ofolder,
                    )
                    model_name = f"{best_aai}+{'+'.join(best_descriptors)}"
                job["best_model_name"] = model_name
                # Structured winning config so /predict can rebuild the exact feature space.
                if req.strategy == "aai":
                    job["best_config"] = {"strategy": "aai", "aai_indices": [best_id],
                                          "descriptors": None, "desc_combo": 1}
                elif req.strategy == "descriptor":
                    _bd = best_id.split("+")
                    job["best_config"] = {"strategy": "descriptor", "aai_indices": None,
                                          "descriptors": _bd, "desc_combo": len(_bd)}
                else:
                    _ba = str(_best_row.get("Index", best_id))
                    _bd = str(_best_row.get("Descriptor", "")).split("+")
                    job["best_config"] = {"strategy": "aai_descriptor", "aai_indices": [_ba],
                                          "descriptors": _bd, "desc_combo": len(_bd)}
                y_test = getattr(encoding, "y_test", None)
                y_pred = getattr(encoding, "y_pred", None)
                if y_test is not None and y_pred is not None:
                    # Flatten to 1-D lists in case pySAR returns 2-D arrays
                    def _to_list(arr):
                        import numpy as _np
                        return [round(float(v), 6) for v in _np.ravel(arr)]
                    job["best_model_predictions"] = {
                        "model_name": model_name,
                        "actual":     _to_list(y_test),
                        "predicted":  _to_list(y_pred),
                    }
                    _log(f"Predictions captured: {len(job['best_model_predictions']['actual'])} test samples.")
                # Export pickle + feature importance + per-fold CV (features 2/3/6).
                _capture_best_model_artifacts(encoding, req, _MODELS_DIR / job_id, job, _log)
        except Exception as _pred_exc:
            logger.warning("[job:%s] Could not capture best-model predictions: %s", short_id, _pred_exc)

    except Exception as exc:  # noqa: BLE001
        elapsed = time.monotonic() - job_start
        job["status"] = "failed"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        job["error"] = str(exc)
        # Stable machine-readable code for the UI (see _JobError); unclassified failures
        # (bugs, unexpected library errors) fall back to 'internal'.
        job["error_code"] = getattr(exc, "code", None) or "internal"
        _log(f"ERROR: {exc}")
        logger.error(
            "[job:%s] ── ENCODING PROCESS FAILED ────────────────────────────────────────\n"
            "  Strategy   : %s\n"
            "  Algorithm  : %s\n"
            "  Elapsed    : %.1fs\n"
            "  Error      : %s",
            short_id, req.strategy, req.algorithm, elapsed, exc,
        )
        logger.exception("[job:%s] Stack trace:", short_id)
    finally:
        if config_path and config_path.exists():
            try:
                config_path.unlink()
                logger.info("[job:%s] Temp config cleaned up", short_id)
            except Exception:  # noqa: BLE001
                pass
        # Single choke point for all exit paths (normal completion, early cancellation
        # returns, and the exception/failed path above) — persists the final snapshot
        # once rather than at every individual status transition.
        _persist_job(job_id)
        # Fire the completion webhook on any terminal state (feature 10). Cancelled jobs
        # that returned early before reaching a terminal status are skipped by design.
        if job.get("status") in ("completed", "failed"):
            _fire_webhook(job)


# ── API routes ──────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    """Redirect browser visits to the frontend (or API docs when no frontend URL is set)."""
    frontend_url = os.environ.get("CORS_ORIGIN") or os.environ.get("VERCEL_URL")
    if frontend_url:
        # CORS_ORIGIN is the full URL (https://…); VERCEL_URL is host-only
        if not frontend_url.startswith("http"):
            frontend_url = f"https://{frontend_url}"
        return RedirectResponse(url=frontend_url, status_code=302)
    return RedirectResponse(url="/api/docs", status_code=302)


@app.get("/api/health")
def health() -> Dict[str, str]:
    """Liveness check."""
    # DEBUG, not INFO: platform liveness probes + the frontend's cold-start poller hit
    # this constantly and would otherwise flood Cloud Logging.
    logger.debug("Health check requested")
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
    # ── New descriptors added in pySAR v2.5.6 / protpy v1.3.0 ──────────────────
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


@app.get("/api/embeddings/status")
def get_embeddings_status() -> Dict[str, Any]:
    """Report whether the PLM-embedding strategy is available on this backend (feature 5)."""
    from backend.embeddings import status
    return status()


async def _save_upload_capped(file: UploadFile, dest: Path, max_bytes: int) -> None:
    """Stream an upload to disk in fixed-size chunks, aborting once max_bytes is exceeded.

    Bounds peak memory use to one chunk regardless of the (possibly oversized or
    unbounded) request body, rather than buffering the whole body before checking size.
    Disk writes are offloaded via run_in_threadpool so they don't block the event loop
    while other requests (health checks, job polling) are being served concurrently.
    """
    chunk_size = 1024 * 1024  # 1 MB
    total = 0
    out = await run_in_threadpool(dest.open, "wb")
    try:
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large. Maximum upload size is {_MAX_UPLOAD_MB} MB.",
                )
            await run_in_threadpool(out.write, chunk)
    finally:
        await run_in_threadpool(out.close)
        if total > max_bytes:
            dest.unlink(missing_ok=True)


@app.post("/api/upload")
async def upload_dataset(request: Request, response: Response, file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a dataset file and return column names, shape, and a row preview."""
    session_id = _get_or_create_session_id(request, response)
    ext = Path(file.filename or "data").suffix.lower()
    if ext not in {".txt", ".csv", ".tsv"}:
        raise HTTPException(
            status_code=400,
            detail="Only .txt, .csv, and .tsv files are supported.",
        )

    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{file_id}{ext}"
    await _save_upload_capped(file, file_path, _MAX_UPLOAD_BYTES)

    try:
        df = await run_in_threadpool(_read_dataset, str(file_path))
    except Exception as exc:  # noqa: BLE001
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}") from exc

    _register_dataset(file_id, session_id)
    return _build_dataset_response(df, file_id, file.filename or "data", str(file_path))


@app.post("/api/upload-descriptors")
async def upload_descriptors_csv(request: Request, response: Response, file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a pre-calculated descriptors CSV and return a preview."""
    session_id = _get_or_create_session_id(request, response)
    ext = Path(file.filename or "descriptors.csv").suffix.lower()
    if ext not in {".csv", ".tsv", ".txt"}:
        raise HTTPException(status_code=400, detail="Only .csv, .tsv, and .txt files are supported.")

    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"desc_{file_id}{ext}"
    await _save_upload_capped(file, file_path, _MAX_UPLOAD_BYTES)

    try:
        df = await run_in_threadpool(_read_dataset, str(file_path))
    except Exception as exc:  # noqa: BLE001
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse descriptors file: {exc}") from exc

    # Basic validation: must have numeric columns
    numeric_cols = df.select_dtypes(include="number").columns.tolist()
    if len(numeric_cols) == 0:
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Descriptors CSV must contain at least one numeric column.")

    _register_dataset(file_id, session_id)
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
def get_all_rows(file_id: str, request: Request, response: Response) -> Dict[str, Any]:
    """Return all rows for an uploaded dataset (no row cap)."""
    _validate_file_id(file_id)
    _check_dataset_owner(file_id, _get_or_create_session_id(request, response))
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
     "description": "Enzyme thermostability (T50) — 260 protein variants"},
    {"name": "absorption", "filename": "absorption.txt",
     "description": "UV absorption wavelength — 80 fluorescent protein variants"},
    {"name": "enantioselectivity", "filename": "enantioselectivity.txt",
     "description": "Enzyme enantioselectivity — 151 lipase variants"},
    {"name": "localization", "filename": "localization.txt",
     "description": "Subcellular localization score — 253 protein sequences"},
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
def load_example_dataset(name: str, request: Request, response: Response) -> Dict[str, Any]:
    """Load a built-in example dataset and return the same shape as /api/upload.

    Plain `def` (not `async def`): every step here is blocking file I/O with no
    `await`able work, so FastAPI runs the whole handler in its worker threadpool
    instead of it blocking the single-worker event loop directly.
    """
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
    _register_dataset(file_id, _get_or_create_session_id(request, response))
    return _build_dataset_response(df, file_id, entry["filename"], str(dest))


@app.post("/api/dataset/{file_id}/deduplicate")
def deduplicate_dataset(file_id: str, seq_col: str, request: Request, response: Response) -> Dict[str, Any]:
    """Remove duplicate sequences and return a fresh file_id + updated stats."""
    _validate_file_id(file_id)
    session_id = _get_or_create_session_id(request, response)
    _check_dataset_owner(file_id, session_id)
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
    _register_dataset(new_id, session_id)
    result = _build_dataset_response(deduped, new_id, matches[0].name, str(new_path))
    result["removed"] = len(df) - len(deduped)
    return result


@app.post("/api/dataset/{file_id}/fix-missing-sequences")
def fix_missing_sequences(file_id: str, seq_col: str, act_col: str, request: Request, response: Response) -> Dict[str, Any]:
    """Drop rows where the sequence column is null or empty and return a fresh dataset."""
    _validate_file_id(file_id)
    session_id = _get_or_create_session_id(request, response)
    _check_dataset_owner(file_id, session_id)
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
    _register_dataset(new_id, session_id)
    result = _build_dataset_response(fixed_df, new_id, matches[0].name, str(new_path))
    result["removed"] = removed
    result["fix_method"] = "remove_rows"
    return result


@app.post("/api/dataset/{file_id}/fix-missing-activity")
def fix_missing_activity(
    file_id: str,
    request: Request,
    response: Response,
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
    session_id = _get_or_create_session_id(request, response)
    _check_dataset_owner(file_id, session_id)
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
        fill_stat = numeric_col.mean() if method == "mean" else numeric_col.median()
        if pd.isna(fill_stat):
            # Every value is missing/non-numeric — there's no mean/median to fill with.
            raise HTTPException(
                status_code=400,
                detail=f"Column '{act_col}' has no numeric values to compute a {method} from.",
            )
        fixed_df[act_col] = numeric_col.fillna(float(fill_stat))

    new_id = str(uuid.uuid4())
    new_path = UPLOAD_DIR / f"{new_id}.csv"
    fixed_df.to_csv(str(new_path), index=False)
    _register_dataset(new_id, session_id)
    result = _build_dataset_response(fixed_df, new_id, matches[0].name, str(new_path))
    result["affected"] = affected
    result["fix_method"] = method
    return result


@app.post("/api/dataset/{file_id}/fix-outliers")
def fix_outliers(
    file_id: str,
    request: Request,
    response: Response,
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
    session_id = _get_or_create_session_id(request, response)
    _check_dataset_owner(file_id, session_id)
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
    _register_dataset(new_id, session_id)
    result = _build_dataset_response(fixed_df, new_id, matches[0].name, str(new_path))
    result["affected"] = affected
    result["fix_method"] = method
    return result


# Per-job cancel events; keyed by job_id
_CANCEL_EVENTS: Dict[str, threading.Event] = {}

# Per-job subprocess handles; used to forcefully terminate encoding on cancel
_CANCEL_PROCESSES: Dict[str, "_mp.Process"] = {}

# Multiprocessing context — fork inherits parent sys.path and loaded modules so pySAR
# does not need to be re-imported from scratch in every subprocess. This is also why
# "forkserver"/"spawn" aren't viable alternatives here: the live Encoding object (which
# holds a threading.Lock — see pySAR's Encoding.__init__) is passed to the child by
# relying on fork's copy-on-write memory sharing, not by pickling; a Lock isn't picklable,
# so any start method that pickles args to send to the child would break immediately.
# General fork-with-threads hazard (this server has several background threads running
# by the time a job starts) is mitigated above by forcing single-threaded BLAS, which
# removes the specific class of lock-held-at-fork-time deadlocks that library threads
# could otherwise cause.
# NOTE: on macOS, fork after numpy/BLAS/Objective-C initialisation can additionally cause
# SIGSEGV due to Apple's fork-safety mechanism. Set the env var before any Process.start()
# call so that child processes inherit it and the Objective-C fork-safety check is disabled.
# This is safe to set here because it only affects Objective-C runtime behaviour in
# forked children; it has no effect on Linux.
if sys.platform == "darwin":
    os.environ.setdefault("OBJC_DISABLE_INITIALIZE_FORK_SAFETY", "YES")

_MP_CTX = _mp.get_context("fork")


# Header carrying the per-browser session token used to scope job ownership (see
# _get_or_create_session_id). Not an auth mechanism — just avoids the IP-based
# ownership check colliding for legitimate users behind the same NAT/proxy, and stops
# a client from seeing into another client's jobs just by sharing a network.
_SESSION_HEADER = "X-Session-Id"


def _get_or_create_session_id(request: Request, response: Response) -> str:
    """Return the caller's session id, minting and echoing back a fresh one if absent/malformed.

    IP-based rate limiting and concurrent-job admission are unaffected by this and stay
    IP-scoped — session ids are trivial for a client to mint fresh copies of, so they're
    useless as an abuse-control signal, only as an ownership/visibility signal.
    """
    sid = request.headers.get(_SESSION_HEADER, "")
    if not _UUID_RE.match(sid):
        sid = str(uuid.uuid4())
    response.headers[_SESSION_HEADER] = sid
    return sid


@app.post("/api/encode")
def start_encoding(req: EncodeRequest, request: Request, response: Response) -> Dict[str, str]:
    """Submit an encoding job; returns a job_id for polling."""
    ip = _get_client_ip(request)
    session_id = _get_or_create_session_id(request, response)

    # Reject encoding a dataset owned by a different session (defense in depth; the
    # file_path was already validated to live inside UPLOAD_DIR by the Pydantic model).
    _fid = _file_id_from_path(req.file_path)
    if _fid:
        _check_dataset_owner(_fid, session_id)

    # Gate the embedding strategy on the optional torch/transformers deps (feature 5).
    if req.strategy == "embedding":
        from backend.embeddings import embeddings_available
        if not embeddings_available():
            raise HTTPException(
                status_code=422,
                detail=("The embedding strategy requires torch + transformers on the "
                        "backend, which are not installed on this deployment."),
            )

    # Hard ceiling on total models evaluated — prevents a combinatorial descriptor/AAI
    # selection from running unbounded on the single shared instance. Checked before
    # touching the per-IP slot below since it's a pure request-validation concern.
    raw_count = _raw_model_count(req)
    if raw_count > _MAX_ESTIMATED_MODELS and not req.max_models:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This configuration would evaluate an estimated {raw_count:,} models, "
                f"exceeding the server limit of {_MAX_ESTIMATED_MODELS:,}. Set max_models "
                "to cap the run, or narrow aai_indices / selected_descriptors / desc_combo."
            ),
        )
    if req.max_models and req.max_models > _MAX_ESTIMATED_MODELS:
        raise HTTPException(
            status_code=422,
            detail=f"max_models cannot exceed {_MAX_ESTIMATED_MODELS:,}.",
        )

    job_id = str(uuid.uuid4())
    cancel_event = threading.Event()

    # Per-IP concurrent job limit — count pending/running jobs for this client and
    # reserve this job's slot in the same critical section, so two simultaneous
    # requests from the same IP can't both pass the count check before either one
    # is actually recorded in JOBS (TOCTOU race).
    with _JOBS_ADMISSION_LOCK:
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
            "best_model_name": None,
            "model_available": False,   # set True once best_model.pkl is exported (feature 2)
            "feature_importance": None,  # top features from the best model (feature 3)
            "cv_scores": None,           # per-fold cross-validation scores (feature 6)
            "task_type": req.task_type,  # 'regression' or 'classification' (feature 4)
            "notify_webhook": req.notify_webhook,  # POSTed on completion (feature 10)
            "webhook_fired": False,
            "share_token": None,        # set when the user creates a share link (feature 10)
            "error": None,
            "error_code": None,         # stable machine-readable failure code (see _JobError)
            "strategy": req.strategy,
            "algorithm": req.algorithm,
            "ip": ip,                  # stored for concurrent job counting (abuse control)
            "session_id": session_id,  # stored for ownership scoping (privacy)
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": None,
            "completed_at": None,
        }
        _persist_job(job_id)

    logger.info(
        "[job:%s] Encode request received — strategy=%s algorithm=%s file=%s",
        job_id[:8], req.strategy, req.algorithm, req.file_path,
    )
    thread = threading.Thread(target=_run_job, args=(job_id, req, cancel_event), daemon=True)
    thread.start()
    logger.info("[job:%s] Background thread started", job_id[:8])
    return {"job_id": job_id}


def _job_owned_by(job: Dict[str, Any], session_id: str) -> bool:
    """Ownership check: jobs are scoped to the session token that created them.

    See _get_or_create_session_id — this is an unguessable per-browser token, not real
    user auth, but unlike IP it doesn't collide for multiple legitimate users behind
    the same NAT/proxy, and a client can't use it to see into another client's jobs.
    """
    return job.get("session_id") == session_id


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: Request, response: Response) -> Dict[str, str]:
    """Request cancellation of a running job. Only the job's owning session may cancel it.

    Returns 200 even if the job is unknown or not owned by the caller (e.g. it ran on
    a different Cloud Run instance) so the frontend always treats the click as
    successful, and so callers can't use the response to probe for others' job ids.
    """
    session_id = _get_or_create_session_id(request, response)
    job = JOBS.get(job_id)
    if job is None or not _job_owned_by(job, session_id):
        logger.info("[job:%s] Cancel requested but job not found/owned on this instance", job_id[:8])
        return {"cancelled": job_id}
    # Signal the cancel event so the thread detects it between phase boundaries
    if job_id in _CANCEL_EVENTS:
        _CANCEL_EVENTS[job_id].set()
    # Immediately terminate the encoding subprocess if it is running
    if job_id in _CANCEL_PROCESSES:
        proc = _CANCEL_PROCESSES.pop(job_id)
        proc.terminate()
        logger.info("[job:%s] Encoding subprocess terminated by cancel request", job_id[:8])
    if job["status"] in {"pending", "running"}:
        job["status"] = "cancelled"
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        job["log"].append("Cancelled by user.")
        logger.info("[job:%s] Cancelled by user", job_id[:8])
        _persist_job(job_id)
    return {"cancelled": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, request: Request, response: Response) -> Dict[str, Any]:
    """Return the current status and (when done) results for a job owned by the caller."""
    session_id = _get_or_create_session_id(request, response)
    job = JOBS.get(job_id)
    if job is None or not _job_owned_by(job, session_id):
        # Same 404 for "doesn't exist" and "not yours" so existence isn't leaked
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/api/jobs")
def list_jobs(request: Request, response: Response) -> List[Dict[str, Any]]:
    """List jobs owned by the caller's session (metadata only, no results payload)."""
    session_id = _get_or_create_session_id(request, response)
    return [
        {k: v for k, v in j.items() if k not in {"results"}}
        for j in JOBS.values()
        if _job_owned_by(j, session_id)
    ]


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str, request: Request, response: Response) -> Dict[str, str]:
    """Remove a job from the registry, if it is owned by the caller's session."""
    session_id = _get_or_create_session_id(request, response)
    job = JOBS.get(job_id)
    if job is not None and _job_owned_by(job, session_id):
        _tok = job.get("share_token")
        if _tok:
            _SHARE_TOKENS.pop(_tok, None)
        JOBS.pop(job_id, None)
        _delete_persisted_job(job_id)
        _delete_job_model_dir(job_id)
    return {"deleted": job_id}


def _delete_job_model_dir(job_id: str) -> None:
    """Remove a job's exported-model directory (best_model.pkl), if any."""
    import shutil as _shutil
    if not _UUID_RE.match(job_id):
        return
    _shutil.rmtree(_MODELS_DIR / job_id, ignore_errors=True)


# ── Shareable read-only results (feature 10) ─────────────────────────────────────
# token -> job_id. An unguessable token grants read-only access to one job's results
# without a session, so a link can be shared with collaborators who lack the session.
_SHARE_TOKENS: Dict[str, str] = {}
_SHARE_LOCK = threading.Lock()


@app.post("/api/jobs/{job_id}/share")
def create_share_link(job_id: str, request: Request, response: Response) -> Dict[str, str]:
    """Mint (or return the existing) read-only share token for a job the caller owns."""
    session_id = _get_or_create_session_id(request, response)
    job = JOBS.get(job_id)
    if job is None or not _job_owned_by(job, session_id):
        raise HTTPException(status_code=404, detail="Job not found.")
    with _SHARE_LOCK:
        token = job.get("share_token")
        if not token:
            token = uuid.uuid4().hex
            job["share_token"] = token
            _SHARE_TOKENS[token] = job_id
            _persist_job(job_id)
    return {"share_token": token}


@app.get("/api/share/{token}")
def get_shared_job(token: str) -> Dict[str, Any]:
    """Return a read-only view of a shared job — no session required, results included.

    Strips the owner's identifiers (session/ip/webhook) and any server-side filesystem
    paths from the shared payload — a public link shouldn't expose the upload/model
    layout on disk.
    """
    job_id = _SHARE_TOKENS.get(token)
    job = JOBS.get(job_id) if job_id else None
    if job is None or job.get("share_token") != token:
        raise HTTPException(status_code=404, detail="Shared results not found.")
    _redacted = {"session_id", "ip", "notify_webhook", "webhook_fired",
                 "file_path", "model_path", "encode_config", "best_config"}
    return {k: v for k, v in job.items() if k not in _redacted}


@app.get("/api/jobs/{job_id}/model")
def download_best_model(job_id: str, request: Request, response: Response):
    """Download the pickled best model ({'model','scaler'}) for a completed job (feature 2)."""
    from fastapi.responses import FileResponse
    session_id = _get_or_create_session_id(request, response)
    job = JOBS.get(job_id)
    if job is None or not _job_owned_by(job, session_id):
        raise HTTPException(status_code=404, detail="Job not found.")
    pkl = _MODELS_DIR / job_id / "best_model.pkl"
    if not pkl.exists():
        raise HTTPException(status_code=404, detail="No exported model available for this job.")
    return FileResponse(
        str(pkl),
        media_type="application/octet-stream",
        filename=f"pysar_best_model_{job_id[:8]}.pkl",
    )


class PredictRequest(BaseModel):
    sequences: List[str] = Field(..., min_length=1, max_length=1000)

    @field_validator("sequences")
    @classmethod
    def _validate_sequences(cls, v: List[str]) -> List[str]:
        cleaned = [s.strip().upper() for s in v if s and s.strip()]
        if not cleaned:
            raise ValueError("At least one non-empty sequence is required.")
        # Allow alignment gap / stop / unknown-position characters (-, ., *): the training
        # datasets contain aligned sequences with gaps that pySAR encodes fine, so predict
        # inputs must accept the same alphabet the model was trained on.
        allowed = _VALID_AA | set("-.*")
        for s in cleaned:
            if len(s) > 10000:
                raise ValueError("Sequences must be at most 10000 residues.")
            if any(c not in allowed for c in s):
                raise ValueError(f"Sequence contains non-amino-acid characters: '{s[:20]}…'")
        return cleaned


@app.post("/api/jobs/{job_id}/predict")
def predict_with_best_model(job_id: str, req: PredictRequest, request: Request, response: Response) -> Dict[str, Any]:
    """Score new sequences with a job's exported best model (feature 2).

    Rebuilds the winning feature space for the input sequences using pySAR's exact
    encoding pipeline (same AAI index / descriptor set), applies the saved scaler, and
    runs the pickled estimator. Reconstruction depends on pySAR at runtime; a failure
    returns 422 with the underlying reason rather than a silent wrong answer.
    """
    session_id = _get_or_create_session_id(request, response)
    job = JOBS.get(job_id)
    if job is None or not _job_owned_by(job, session_id):
        raise HTTPException(status_code=404, detail="Job not found.")
    pkl = _MODELS_DIR / job_id / "best_model.pkl"
    best_config = job.get("best_config")
    if not pkl.exists() or not best_config:
        raise HTTPException(status_code=404, detail="No exported model available for this job.")
    try:
        preds = _predict_sequences(pkl, best_config, job, req.sequences)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("[job:%s] Predict failed: %s", job_id[:8], exc)
        raise HTTPException(status_code=422, detail=f"Prediction failed: {exc}") from exc
    return {
        "job_id": job_id,
        "model_name": job.get("best_model_name"),
        "task_type": job.get("task_type", "regression"),
        "predictions": [
            {"sequence": s if len(s) <= 40 else s[:40] + "…", "prediction": p}
            for s, p in zip(req.sequences, preds)
        ],
    }


def _predict_sequences(pkl: Path, best_config: Dict[str, Any], job: Dict[str, Any],
                       sequences: List[str]) -> List[Any]:
    """Encode `sequences` in the job's winning feature space and run the pickled model."""
    import pickle as _pickle
    import numpy as _np
    import pandas as _pd

    with open(pkl, "rb") as fh:
        payload = _pickle.load(fh)
    model = payload.get("model") if isinstance(payload, dict) else payload
    scaler = payload.get("scaler") if isinstance(payload, dict) else None
    # Present for classification jobs — maps the model's integer output back to the
    # original class labels. Absent (None) for regression, where output stays numeric.
    label_encoder = payload.get("label_encoder") if isinstance(payload, dict) else None

    def _format(raw) -> List[Any]:
        raw = _np.ravel(raw)
        if label_encoder is not None:
            return [str(c) for c in label_encoder.inverse_transform(raw.astype(int))]
        return [round(float(v), 6) for v in raw]

    strategy = best_config["strategy"]

    # Embedding strategy needs no pySAR — embed the inputs directly (feature 5).
    if strategy == "embedding":
        from backend.embeddings import embed_sequences, DEFAULT_MODEL
        X = embed_sequences(sequences, best_config.get("embedding_model") or DEFAULT_MODEL)
        X_values = X if scaler is None else scaler.transform(X)
        return _format(model.predict(X_values))

    # Build a throwaway single-column dataset of the input sequences so pySAR's Encoding
    # computes features with the same config used at training time. Reuse the job's exact
    # training config (full pyDSP/descriptors shape) and only swap the dataset section, so
    # the feature pipeline matches the model — a hand-built minimal config trips pySAR's
    # required-key checks (e.g. pyDSP 'filter').
    import copy as _copy
    from pySAR.encoding import Encoding
    tmp_ds = _MODELS_DIR / job["job_id"] / "predict_input.csv"
    _pd.DataFrame({"sequence": sequences, "activity": [0.0] * len(sequences)}).to_csv(tmp_ds, index=False)
    base_cfg = job.get("encode_config") or {
        "model": {"algorithm": job.get("algorithm", "plsregression"), "parameters": {}, "test_split": 0.2},
        "descriptors": {}, "pyDSP": {"use_dsp": 0},
    }
    cfg = _copy.deepcopy(base_cfg)
    cfg["dataset"] = {"dataset": str(tmp_ds), "sequence_col": "sequence", "activity": "activity"}
    cfg_path = _MODELS_DIR / job["job_id"] / "predict_config.json"
    cfg_path.write_text(json.dumps(cfg))
    enc = Encoding(config_file=str(cfg_path), verbose=False)

    if strategy == "aai":
        X = enc.build_features(feature_type="aai", index=best_config["aai_indices"][0])
    elif strategy == "descriptor":
        descs = tuple(best_config["descriptors"])
        from pySAR.descriptors import Descriptors
        desc_instance = Descriptors(config_file=str(cfg_path))
        X = enc.build_features(feature_type="descriptor",
                               descriptor_entry=descs if len(descs) > 1 else descs[0],
                               desc_instance=desc_instance)
    else:
        descs = tuple(best_config["descriptors"])
        from pySAR.descriptors import Descriptors
        desc_instance = Descriptors(config_file=str(cfg_path))
        X = enc.build_features(feature_type="aai_descriptor",
                               index=best_config["aai_indices"][0],
                               descriptor_entry=descs if len(descs) > 1 else descs[0],
                               desc_instance=desc_instance)

    X_values = X.to_numpy(dtype=float) if hasattr(X, "to_numpy") else _np.asarray(X, dtype=float)
    # AAI encodings are position-wise (one feature per residue), so the model only accepts
    # sequences aligned to the exact training length. Give an actionable message instead of
    # a raw sklearn shape error when the input's feature count doesn't match.
    expected = getattr(scaler, "n_features_in_", None) or getattr(model, "n_features_in_", None)
    if expected is not None and X_values.shape[1] != expected:
        if strategy in ("aai", "aai_descriptor"):
            raise HTTPException(status_code=422, detail=(
                f"This sequence encodes to {X_values.shape[1]} features but the AAI model "
                f"expects {expected}. AAI encoding is position-wise — provide sequences "
                f"aligned to the same length/coordinates as the training set."
            ))
        raise HTTPException(status_code=422, detail=(
            f"Feature count mismatch ({X_values.shape[1]} vs {expected} expected)."
        ))
    if scaler is not None:
        X_values = scaler.transform(X_values)
    return _format(model.predict(X_values))


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
        "backend_version": BACKEND_VERSION,
        "pysar_version": pysar_version,
        "python_version": _sys.version,
    }
