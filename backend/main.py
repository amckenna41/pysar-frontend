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
import os
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pysar_api")

app = FastAPI(title="pySAR API", version="1.0.0", docs_url="/api/docs")

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

# Temp directory shared by all jobs
UPLOAD_DIR = Path(tempfile.gettempdir()) / "pysar_frontend"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# In-memory job registry
JOBS: Dict[str, Dict[str, Any]] = {}


# ── Pydantic request models ─────────────────────────────────────────────────────

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
    # Encoding strategy
    strategy: str = "aai"
    aai_indices: Optional[List[str]] = None
    selected_descriptors: Optional[List[str]] = None
    desc_combo: int = 1
    # Encoding tuning
    sort_by: str = "R2"
    n_jobs: int = 1
    max_models: Optional[int] = None
    sample_mode: bool = False
    random_state: Optional[int] = None
    resume: bool = False
    resume_file: str = ""


# ── Dataset helpers ─────────────────────────────────────────────────────────────

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
        },
        "descriptors": req.descriptors_config or {},
        "pyDSP": req.dsp_config or {"use_dsp": 0},
    }


# ── Model count estimator ──────────────────────────────────────────────────────

_DEFAULT_DESC_COUNT = 33  # matches ALL_DESCRIPTORS in the frontend UI (pySAR v2.5.0)


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


# ── Job runner ──────────────────────────────────────────────────────────────────

def _run_job(job_id: str, req: EncodeRequest, cancel_event: Optional[threading.Event] = None) -> None:
    """Execute pySAR encoding in a background thread and update JOBS."""
    job = JOBS[job_id]

    def _log(msg: str) -> None:
        job["log"].append(msg)
        logger.info("[%s] %s", job_id[:8], msg)

    def _cancelled() -> bool:
        """Return True if a cancel was requested (checks event + status flag)."""
        return (cancel_event is not None and cancel_event.is_set()) or job.get("status") == "cancelled"

    config_path: Optional[Path] = None
    try:
        if _cancelled():
            return
        job["status"] = "running"
        job["progress"] = 10  # Phase 1: preparing config
        _log("Preparing configuration…")

        config = _build_config(req)
        config_path = UPLOAD_DIR / f"{job_id}_config.json"
        config_path.write_text(json.dumps(config, indent=2))

        from pySAR.encoding import Encoding  # lazy import — pySAR may be heavy

        job["progress"] = 20  # Phase 2: loading dataset
        _log("Initialising Encoding class…")
        encoding = Encoding(config_file=str(config_path), verbose=False)
        _log(
            f"Dataset loaded: {encoding.num_seqs} sequences "
            f"× {encoding.sequence_length} residues"
        )

        # Estimate and record total models before encoding starts
        total_models = _estimate_total_models(req)
        job["total_models"] = total_models
        job["progress"] = 35  # Phase 3: estimation done

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
        job["progress"] = 45  # Phase 4: encoding started

        if _cancelled():
            _log("Cancelled before encoding started.")
            return

        if req.strategy == "aai":
            results_df = encoding.aai_encoding(
                aai_indices=req.aai_indices or None,
                **common,
            )
        elif req.strategy == "descriptor":
            results_df = encoding.descriptor_encoding(
                descriptors=req.selected_descriptors or None,
                desc_combo=req.desc_combo,
                **common,
            )
        elif req.strategy == "aai_descriptor":
            results_df = encoding.aai_descriptor_encoding(
                aai_indices=req.aai_indices or None,
                descriptors=req.selected_descriptors or None,
                desc_combo=req.desc_combo,
                **common,
            )
        else:
            raise ValueError(f"Unknown strategy: {req.strategy!r}")

        if _cancelled():
            _log("Cancelled after encoding — results discarded.")
            return

        n_models = len(results_df)
        _log(f"Complete — {n_models} model(s) evaluated.")
        job["status"] = "completed"
        job["progress"] = 100
        job["models_completed"] = n_models  # final count after encoding
        job["partial_results"] = results_df.head(10).to_dict(orient="records")  # top-10 preview
        job["results"] = results_df.to_dict(orient="records")
        job["columns"] = results_df.columns.tolist()

    except Exception as exc:  # noqa: BLE001
        job["status"] = "failed"
        job["error"] = str(exc)
        _log(f"ERROR: {exc}")
    finally:
        if config_path and config_path.exists():
            try:
                config_path.unlink()
            except Exception:  # noqa: BLE001
                pass


# ── API routes ──────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health() -> Dict[str, str]:
    """Liveness check."""
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
    # ── New descriptors added in pySAR v2.5.0 / protpy v1.3.0 ──────────────────
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
    act_guess = next(
        (c for c in df.columns if c.lower() not in _ACT_EXCLUDE),
        df.columns[-1],
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


@app.post("/api/encode")
def start_encoding(req: EncodeRequest) -> Dict[str, str]:
    """Submit an encoding job; returns a job_id for polling."""
    job_id = str(uuid.uuid4())
    cancel_event = threading.Event()
    _CANCEL_EVENTS[job_id] = cancel_event
    JOBS[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": 0,
        "models_completed": 0,    # updated after encoding completes
        "total_models": 0,         # estimated before encoding starts
        "partial_results": [],     # top-10 rows populated on completion
        "log": [],
        "results": None,
        "columns": [],
        "error": None,
        "strategy": req.strategy,
        "algorithm": req.algorithm,
    }
    thread = threading.Thread(target=_run_job, args=(job_id, req, cancel_event), daemon=True)
    thread.start()
    return {"job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> Dict[str, str]:
    """Request cancellation of a running job."""
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    # Signal the cancel event so the thread can detect it between phase boundaries
    if job_id in _CANCEL_EVENTS:
        _CANCEL_EVENTS[job_id].set()
    job = JOBS[job_id]
    if job["status"] in {"pending", "running"}:
        job["status"] = "cancelled"
        job["log"].append("Cancelled by user.")
    return {"cancelled": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    """Return the current status and (when done) results for a job."""
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
    JOBS.pop(job_id, None)
    return {"deleted": job_id}
