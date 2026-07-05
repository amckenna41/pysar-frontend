"""Unit tests for the self-contained classification layer (feature 4)."""
import numpy as np
import pytest
from sklearn.datasets import make_classification

from backend.classification import (
    CLASSIFICATION_METRICS,
    VALID_CLASSIFIERS,
    cross_val_accuracy,
    evaluate_classifier,
)

pytestmark = pytest.mark.unit


def _binary():
    return make_classification(n_samples=120, n_features=8, n_informative=5,
                               n_classes=2, random_state=0)


def _multiclass():
    return make_classification(n_samples=180, n_features=10, n_informative=6,
                               n_classes=3, n_clusters_per_class=1, random_state=0)


class TestEvaluateClassifier:
    def test_binary_metrics_present_and_ranged(self):
        X, y = _binary()
        r = evaluate_classifier(X, y, "randomforest", random_state=0)
        for k in CLASSIFICATION_METRICS:
            assert k in r
        assert 0.0 <= r["Accuracy"] <= 1.0
        assert r["AUC"] is None or 0.0 <= r["AUC"] <= 1.0
        # informative synthetic data → a usable classifier
        assert r["Accuracy"] > 0.6

    def test_confusion_matrix_shape_matches_classes(self):
        X, y = _multiclass()
        r = evaluate_classifier(X, y, "logisticregression", random_state=0)
        n = len(r["classes"])
        assert n == 3
        cm = np.array(r["confusion_matrix"])
        assert cm.shape == (n, n)

    def test_string_labels_supported(self):
        X, y = _binary()
        y_str = np.where(y == 1, "binder", "non_binder")
        r = evaluate_classifier(X, y_str, "knn", random_state=0)
        assert set(r["classes"]) == {"binder", "non_binder"}

    def test_multiclass_auc_ovr(self):
        X, y = _multiclass()
        r = evaluate_classifier(X, y, "randomforest", random_state=0)
        assert r["AUC"] is None or 0.0 <= r["AUC"] <= 1.0

    def test_invalid_algorithm_raises(self):
        X, y = _binary()
        with pytest.raises(ValueError):
            evaluate_classifier(X, y, "not_a_classifier")

    def test_fitted_artifacts_returned(self):
        X, y = _binary()
        r = evaluate_classifier(X, y, "randomforest", random_state=0)
        assert r["_model"] is not None and r["_label_encoder"] is not None


class TestCrossValAccuracy:
    def test_returns_one_score_per_fold(self):
        X, y = _binary()
        scores = cross_val_accuracy(X, y, "randomforest", cv=5, random_state=0)
        assert len(scores) == 5
        assert all(0.0 <= s <= 1.0 for s in scores)


def test_classifier_whitelist_nonempty():
    assert "randomforest" in VALID_CLASSIFIERS and "logisticregression" in VALID_CLASSIFIERS


class TestClassificationRequestValidation:
    """The /api/encode task-aware algorithm whitelist (regression vs classification)."""

    def test_classification_accepts_classifier_algorithm(self, client, uploaded_file_id):
        from tests.backend.conftest import make_encode_payload
        payload = make_encode_payload(uploaded_file_id, task_type="classification", algorithm="randomforest")
        # 200 = request accepted (the mocked worker returns regression-shaped data, but
        # request validation — the point of this test — passed).
        assert client.post("/api/encode", json=payload).status_code == 200

    def test_classification_rejects_regression_only_algorithm(self, client, uploaded_file_id):
        from tests.backend.conftest import make_encode_payload
        payload = make_encode_payload(uploaded_file_id, task_type="classification", algorithm="plsregression")
        assert client.post("/api/encode", json=payload).status_code == 422

    def test_regression_rejects_classifier_algorithm(self, client, uploaded_file_id):
        from tests.backend.conftest import make_encode_payload
        payload = make_encode_payload(uploaded_file_id, task_type="regression", algorithm="logisticregression")
        assert client.post("/api/encode", json=payload).status_code == 422
