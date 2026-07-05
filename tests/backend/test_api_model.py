"""
Tests for the best-model export, download, predict, importance, and CV endpoints
(features 2, 3, 6). Real pySAR encoding is mocked project-wide, so these exercise the
endpoint contracts and the pure feature-importance helper rather than numeric encoding.
"""
import pickle

import numpy as np
import pytest
from sklearn.linear_model import Ridge

import backend.main as m
from backend.main import JOBS, _MODELS_DIR, _feature_importance_from_model


pytestmark = pytest.mark.unit


def _write_pkl(job_id: str):
    """Fit a tiny Ridge model and pickle it the way pySAR's Model.save() does."""
    X = np.random.RandomState(0).rand(20, 6)
    y = X @ np.array([3.0, 0.0, -2.0, 0.0, 1.0, 0.0]) + 0.1
    model = Ridge().fit(X, y)
    d = _MODELS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "best_model.pkl", "wb") as fh:
        pickle.dump({"model": model, "scaler": None}, fh)


# ── Feature-importance helper (feature 3) ────────────────────────────────────────

class TestFeatureImportanceHelper:
    def test_linear_coef_ranks_strongest_feature_first(self):
        X = np.random.RandomState(1).rand(40, 4)
        y = X @ np.array([0.0, 5.0, 0.0, 0.0])
        model = Ridge().fit(X, y)
        fi = _feature_importance_from_model(model)
        assert fi["kind"] == "coefficient"
        assert fi["total_features"] == 4
        assert fi["top"][0]["feature"] == "feature_1"  # strongest signal

    def test_none_when_no_coef_or_importances(self):
        class Dummy:  # no coef_, no feature_importances_
            pass
        assert _feature_importance_from_model(Dummy()) is None

    def test_respects_top_n(self):
        model = Ridge().fit(np.random.rand(30, 12), np.random.rand(30))
        fi = _feature_importance_from_model(model, top_n=3)
        assert len(fi["top"]) == 3


# ── Model download endpoint (feature 2) ──────────────────────────────────────────

class TestModelDownload:
    def test_download_returns_pickle(self, client, completed_job):
        _write_pkl(completed_job)
        JOBS[completed_job]["model_available"] = True
        r = client.get(f"/api/jobs/{completed_job}/model")
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/octet-stream"
        assert isinstance(pickle.loads(r.content)["model"], Ridge)

    def test_404_when_no_model_exported(self, client, completed_job):
        r = client.get(f"/api/jobs/{completed_job}/model")
        assert r.status_code == 404

    def test_404_for_foreign_session(self, client, completed_job):
        _write_pkl(completed_job)
        r = client.get(f"/api/jobs/{completed_job}/model", headers={"X-Session-Id": str(__import__("uuid").uuid4())})
        assert r.status_code == 404


# ── Predict endpoint (feature 2) ─────────────────────────────────────────────────

class TestPredict:
    def test_404_without_model(self, client, completed_job):
        r = client.post(f"/api/jobs/{completed_job}/predict", json={"sequences": ["ACDEF"]})
        assert r.status_code == 404

    def test_validation_rejects_empty(self, client, completed_job):
        _write_pkl(completed_job)
        JOBS[completed_job]["best_config"] = {"strategy": "aai", "aai_indices": ["X"], "descriptors": None, "desc_combo": 1}
        r = client.post(f"/api/jobs/{completed_job}/predict", json={"sequences": []})
        assert r.status_code == 422

    def test_validation_rejects_bad_residues(self, client, completed_job):
        _write_pkl(completed_job)
        JOBS[completed_job]["best_config"] = {"strategy": "aai", "aai_indices": ["X"], "descriptors": None, "desc_combo": 1}
        r = client.post(f"/api/jobs/{completed_job}/predict", json={"sequences": ["ACDEF123"]})
        assert r.status_code == 422


class TestPredictSequenceValidator:
    """Directly exercise the PredictRequest alphabet rules (regression guard)."""

    def test_gap_and_stop_chars_accepted(self):
        from backend.main import PredictRequest
        # Aligned training sequences contain '-'; pySAR encodes them, so predict must too.
        req = PredictRequest(sequences=["ACD-EF.G*H"])
        assert req.sequences == ["ACD-EF.G*H"]

    def test_digits_rejected(self):
        import pytest as _pytest
        from pydantic import ValidationError
        from backend.main import PredictRequest
        with _pytest.raises(ValidationError):
            PredictRequest(sequences=["ACDEF123"])
