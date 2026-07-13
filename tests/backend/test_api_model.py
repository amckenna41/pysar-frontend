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


# ── Classification best-model export + label-decoding predict (bugs #4/#5) ────────

def _fit_classifier():
    """Return (model, scaler, label_encoder) trained on tiny 4-feature data with
    string class labels 'lo'/'hi'."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import LabelEncoder, StandardScaler

    rng = np.random.RandomState(0)
    X = rng.rand(24, 4)
    y_raw = np.array(["lo", "hi"] * 12)
    le = LabelEncoder()
    y = le.fit_transform(y_raw)
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)
    from sklearn.linear_model import LogisticRegression as _LR
    model = _LR(max_iter=500).fit(Xs, y)
    return model, scaler, le


class TestClassificationExport:
    def test_persist_sets_best_config_and_pickles_label_encoder(self):
        import types
        import pickle
        model, scaler, le = _fit_classifier()
        job_id = "11111111-1111-4111-8111-111111111111"
        job = {"job_id": job_id}
        extras = {
            "confusion_matrix": [[1, 0], [0, 1]], "classes": ["hi", "lo"],
            "y_test": [0, 1], "y_pred": [0, 1],
            "id_fields": {"Descriptor": "amino_acid_composition+gravy"},
            "_model": model, "_scaler": scaler, "_label_encoder": le,
        }
        req = types.SimpleNamespace(strategy="descriptor")
        m._persist_classification_best_model(job_id, req, job, extras)

        assert job["model_available"] is True
        assert job["best_config"]["strategy"] == "descriptor"
        assert job["best_config"]["descriptors"] == ["amino_acid_composition", "gravy"]
        # Internal artifacts are stripped from extras so the job stays JSON-serialisable.
        for k in ("_model", "_scaler", "_label_encoder", "id_fields"):
            assert k not in extras
        # The pickle carries the label encoder needed to decode predictions.
        pkl = _MODELS_DIR / job_id / "best_model.pkl"
        assert pkl.exists()
        with open(pkl, "rb") as fh:
            payload = pickle.load(fh)
        assert set(payload) == {"model", "scaler", "label_encoder"}


class TestClassificationPredictDecoding:
    def test_predict_returns_original_class_labels(self, monkeypatch):
        import pickle
        model, scaler, le = _fit_classifier()
        job_id = "22222222-2222-4222-8222-222222222222"
        d = _MODELS_DIR / job_id
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "best_model.pkl", "wb") as fh:
            pickle.dump({"model": model, "scaler": scaler, "label_encoder": le}, fh)

        # Embedding strategy path: bypass pySAR by stubbing the embedder to return
        # a fixed 4-feature matrix for the two input sequences.
        import backend.embeddings as _emb
        monkeypatch.setattr(_emb, "embed_sequences",
                            lambda seqs, model_name=None: np.random.RandomState(1).rand(len(seqs), 4))

        best_config = {"strategy": "embedding", "embedding_model": "stub"}
        preds = m._predict_sequences(d / "best_model.pkl", best_config,
                                     {"job_id": job_id}, ["ACDEF", "GHIKL"])
        assert len(preds) == 2
        # Decoded back to the original string labels — never raw integer codes.
        assert all(p in ("lo", "hi") for p in preds)
