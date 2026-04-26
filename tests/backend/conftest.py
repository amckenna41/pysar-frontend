"""
Shared fixtures and helpers for the pySAR backend test suite.

Strategy
--------
* pySAR and aaindex are **lazy** imports (inside route/job bodies). We pre-populate
  sys.modules with MagicMock objects *before* importing backend.main so those lazy
  imports resolve to controlled mocks rather than the real (heavy) libraries.
* The TestClient uses Starlette's synchronous ASGI transport — no real HTTP sockets.
* JOBS and _CANCEL_EVENTS are module-level dicts; the `clean_jobs` autouse fixture
  resets them before every test so tests are fully isolated.
* Rate-limit state (_RATE_LIMIT_STORE) is similarly cleared by the `clean_rate_limits`
  autouse fixture.
"""
import os
import sys
import textwrap
import uuid
from typing import Generator
from unittest.mock import MagicMock

import pytest

# ── Pre-mock heavy optional dependencies ──────────────────────────────────────
# Must happen before `from backend.main import ...` below.
_PYSAR_MOCK   = MagicMock()
_AAINDEX_MOCK = MagicMock()

sys.modules.setdefault("pySAR",          _PYSAR_MOCK)
sys.modules.setdefault("pySAR.encoding", _PYSAR_MOCK)
sys.modules.setdefault("aaindex",        _AAINDEX_MOCK)

# Trust X-Forwarded-For in all tests so rate-limiting/concurrent-job tests can
# fake per-IP isolation via that header (matches production reverse-proxy setup).
os.environ["TRUST_PROXY"] = "true"

# ── Now safe to import the application ────────────────────────────────────────
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import (  # noqa: E402
    JOBS,
    _CANCEL_EVENTS,
    _CANCEL_PROCESSES,
    _RATE_LIMIT_STORE,
    UPLOAD_DIR,
    app,
)

# ── Sample dataset content (CSV/TSV) ──────────────────────────────────────────

CLEAN_CSV = textwrap.dedent("""\
    sequence,T50
    ACDEFGHIKLMNPQRSTVWY,55.0
    ACDEFGHIKLMNPQRSTVWA,61.3
    ACDEFGHIKLMNPQRSTVWC,48.7
    ACDEFGHIKLMNPQRSTVWD,53.1
    ACDEFGHIKLMNPQRSTVWE,57.9
    ACDEFGHIKLMNPQRSTVWF,52.4
    ACDEFGHIKLMNPQRSTVWG,59.6
    ACDEFGHIKLMNPQRSTVWH,54.2
    ACDEFGHIKLMNPQRSTVWI,56.8
    ACDEFGHIKLMNPQRSTVWK,50.3
    ACDEFGHIKLMNPQRSTVWL,58.1
    ACDEFGHIKLMNPQRSTVWM,53.7
    ACDEFGHIKLMNPQRSTVWN,60.4
    ACDEFGHIKLMNPQRSTVWP,47.9
    ACDEFGHIKLMNPQRSTVWQ,55.5
    ACDEFGHIKLMNPQRSTVWR,62.0
    ACDEFGHIKLMNPQRSTVWS,49.8
    ACDEFGHIKLMNPQRSTVWT,57.3
    ACDEFGHIKLMNPQRSTVWV,51.6
    ACDEFGHIKLMNPQRSTVWW,63.1
""")

CLEAN_TSV = textwrap.dedent("""\
    sequence\tT50
    ACDEFGHIKLMNPQRSTVWY\t55.0
    ACDEFGHIKLMNPQRSTVWA\t61.3
    ACDEFGHIKLMNPQRSTVWC\t48.7
    ACDEFGHIKLMNPQRSTVWD\t53.1
    ACDEFGHIKLMNPQRSTVWE\t57.9
""")

# Outlier dataset: 11 normal values + 1 extreme outlier.
# n=12 is required for the 3σ rule to reliably flag a single outlier
# (with n<12, the outlier inflates mean/std enough to escape detection).
OUTLIER_CSV = textwrap.dedent("""\
    sequence,T50
    ACDEFGHIKLMNPQRSTVWY,55.0
    ACDEFGHIKLMNPQRSTVWA,61.3
    ACDEFGHIKLMNPQRSTVWC,48.7
    ACDEFGHIKLMNPQRSTVWD,53.1
    ACDEFGHIKLMNPQRSTVWE,57.9
    ACDEFGHIKLMNPQRSTVWF,52.4
    ACDEFGHIKLMNPQRSTVWG,59.6
    ACDEFGHIKLMNPQRSTVWH,54.2
    ACDEFGHIKLMNPQRSTVWI,56.8
    ACDEFGHIKLMNPQRSTVWL,54.5
    ACDEFGHIKLMNPQRSTVWM,57.2
    OUTLIER_SEQ_KLMNPQRS,150.0
""")

DUPLICATE_CSV = textwrap.dedent("""\
    sequence,T50
    ACDEFGHIKLMNPQRSTVWY,55.0
    ACDEFGHIKLMNPQRSTVWY,61.3
    ACDEFGHIKLMNPQRSTVWC,48.7
    ACDEFGHIKLMNPQRSTVWD,53.1
""")

MISSING_ACTIVITY_CSV = textwrap.dedent("""\
    sequence,T50
    ACDEFGHIKLMNPQRSTVWY,55.0
    ACDEFGHIKLMNPQRSTVWA,
    ACDEFGHIKLMNPQRSTVWC,48.7
    ACDEFGHIKLMNPQRSTVWD,53.1
""")

MISSING_SEQ_CSV = textwrap.dedent("""\
    sequence,T50
    ACDEFGHIKLMNPQRSTVWY,55.0
    ,61.3
    ACDEFGHIKLMNPQRSTVWC,48.7
""")

INVALID_AA_CSV = textwrap.dedent("""\
    sequence,T50
    ACDEFGHIKLMNPQRSTVWY,55.0
    12345678901234567890,61.3
    ACDEFGHIKLMNPQRSTVWC,48.7
""")

DESCRIPTORS_CSV = textwrap.dedent("""\
    desc_a,desc_b,desc_c
    0.1,0.2,0.3
    0.4,0.5,0.6
    0.7,0.8,0.9
""")


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def client() -> Generator:
    """
    Session-scoped TestClient.
    Starlette's TestClient runs startup/shutdown events once per session.
    JOBS and rate-limit state are cleared per-test by autouse fixtures.
    """
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clean_jobs():
    """Ensure JOBS, _CANCEL_EVENTS, and _CANCEL_PROCESSES are empty before and after each test."""
    JOBS.clear()
    _CANCEL_EVENTS.clear()
    _CANCEL_PROCESSES.clear()
    yield
    JOBS.clear()
    _CANCEL_EVENTS.clear()
    _CANCEL_PROCESSES.clear()


@pytest.fixture(autouse=True)
def clean_rate_limits():
    """Reset per-IP sliding-window counters before each test."""
    _RATE_LIMIT_STORE.clear()
    yield
    _RATE_LIMIT_STORE.clear()


@pytest.fixture(autouse=True)
def inline_encoding(monkeypatch):
    """Stub out the multiprocessing subprocess with a synchronous queue+stub.

    Forking from a large pytest process on macOS introduces enough latency that
    multiple jobs pile up as 'running' before any complete, spuriously hitting
    _MAX_CONCURRENT_JOBS_PER_IP.  This fixture replaces _MP_CTX with a fake
    whose Process.start() puts a minimal DataFrame result into a stdlib Queue
    immediately — no fork, no IPC, no timing dependency.
    """
    import queue as _stdlib_q
    import pandas as pd
    import backend.main as _m

    # Minimal result that satisfies Phase 5 (len, head, to_dict, .columns)
    _STUB_DF = pd.DataFrame([{
        "AAI_Index": "CIDH920105",
        "R2": 0.9, "RMSE": 0.05, "MSE": 0.0025,
        "MAE": 0.04, "RPD": 3.2, "Explained_Var": 0.89,
    }])

    class _FakeProcess:
        """Synchronous stub — puts result in queue on start(), terminatable no-op."""
        def __init__(self, target, args=(), daemon=False):
            self._q = args[0]  # queue is always the first positional arg

        def start(self):
            self._q.put(("ok", _STUB_DF, None, None))

        def terminate(self): pass
        def kill(self): pass
        def join(self, timeout=None): pass
        def is_alive(self): return False

    class _FakeMPCtx:
        """Minimal multiprocessing-context shim used inside _run_job."""
        @staticmethod
        def Queue():
            return _stdlib_q.Queue()  # stdlib Queue — supports get(timeout=...)

        Process = _FakeProcess

    monkeypatch.setattr(_m, "_MP_CTX", _FakeMPCtx())


@pytest.fixture
def uploaded_file_id(client):
    """Upload a clean 20-row CSV; return the resulting file_id."""
    resp = client.post(
        "/api/upload",
        files={"file": ("test.csv", CLEAN_CSV.encode(), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["file_id"]


@pytest.fixture
def uploaded_duplicate_id(client):
    """Upload a CSV that contains a duplicate sequence."""
    resp = client.post(
        "/api/upload",
        files={"file": ("dups.csv", DUPLICATE_CSV.encode(), "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["file_id"]


@pytest.fixture
def uploaded_outlier_id(client):
    """Upload a CSV that contains an activity outlier (value = 150)."""
    resp = client.post(
        "/api/upload",
        files={"file": ("outliers.csv", OUTLIER_CSV.encode(), "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["file_id"]


@pytest.fixture
def uploaded_missing_activity_id(client):
    """Upload a CSV with one missing activity value."""
    resp = client.post(
        "/api/upload",
        files={"file": ("missing.csv", MISSING_ACTIVITY_CSV.encode(), "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["file_id"]


@pytest.fixture
def uploaded_missing_seq_id(client):
    """Upload a CSV with one missing sequence value."""
    resp = client.post(
        "/api/upload",
        files={"file": ("miss_seq.csv", MISSING_SEQ_CSV.encode(), "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["file_id"]


@pytest.fixture
def completed_job():
    """Inject a pre-built completed job into JOBS. Returns the job_id."""
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "job_id": job_id,
        "status": "completed",
        "progress": 100,
        "models_completed": 5,
        "models_in_progress": 0,
        "total_models": 5,
        "partial_results": [{"AAIndex": "ALTS910101", "R2": 0.9}],
        "log": ["Strategy: aai…", "Complete — 5 model(s) evaluated in 1.2s total."],
        "results": [{"AAIndex": "ALTS910101", "R2": 0.9, "RMSE": 1.1, "MAE": 0.9}],
        "columns": ["AAIndex", "R2", "RMSE", "MAE"],
        "best_model_predictions": {
            "model_name": "ALTS910101",
            "actual": [1.0, 2.0],
            "predicted": [1.1, 1.9],
        },
        "error": None,
        "strategy": "aai",
        "algorithm": "plsregression",
        "created_at": "2026-04-21T12:00:00+00:00",
        "started_at": "2026-04-21T12:00:01+00:00",
        "completed_at": "2026-04-21T12:01:15+00:00",
    }
    return job_id


@pytest.fixture
def running_job():
    """Inject a running job into JOBS. Returns the job_id."""
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "job_id": job_id,
        "status": "running",
        "progress": 55,
        "models_completed": 0,
        "models_in_progress": 120,
        "total_models": 566,
        "partial_results": [],
        "log": ["Preparing configuration…", "Initialising Encoding class…"],
        "results": None,
        "columns": [],
        "best_model_predictions": None,
        "error": None,
        "strategy": "aai",
        "algorithm": "plsregression",
        "created_at": "2026-04-21T12:00:00+00:00",
        "started_at": "2026-04-21T12:00:01+00:00",
        "completed_at": None,
    }
    return job_id


def make_encode_payload(uploaded_id: str, **overrides) -> dict:
    """Return a minimal valid EncodeRequest dict for testing the /api/encode endpoint."""
    base = {
        # Use the real UPLOAD_DIR so the path traversal validator always passes
        "file_path": str(UPLOAD_DIR / f"{uploaded_id}.csv"),
        "sequence_col": "sequence",
        "activity_col": "T50",
        "algorithm": "plsregression",
        "test_split": 0.2,
        "strategy": "aai",
        "aai_indices": ["ALTS910101"],  # single index for speed
        "n_jobs": 1,
        "sort_by": "R2",
    }
    base.update(overrides)
    return base
