"""
Classification support (feature 4).

pySAR's Model class is regression-only, so classification lives here as a small,
self-contained sklearn layer. The worker builds a feature matrix X (via pySAR's
Encoding.build_features, exactly as for regression) and a label vector, then calls
:func:`evaluate_classifier` per candidate encoding. Nothing here depends on pySAR, so
it is directly unit-testable with synthetic data.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np
from sklearn.ensemble import (
    AdaBoostClassifier,
    BaggingClassifier,
    ExtraTreesClassifier,
    GradientBoostingClassifier,
    HistGradientBoostingClassifier,
    RandomForestClassifier,
)
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    roc_auc_score,
)
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.svm import SVC

# Mirrors the regression whitelist naming where sensible so the UI can share labels.
CLASSIFIER_CONSTRUCTORS = {
    "logisticregression": LogisticRegression,
    "logistic": LogisticRegression,
    "randomforest": RandomForestClassifier,
    "gradientboosting": GradientBoostingClassifier,
    "hgbr": HistGradientBoostingClassifier,
    "histgradientboosting": HistGradientBoostingClassifier,
    "svc": SVC,
    "svm": SVC,
    "knn": KNeighborsClassifier,
    "extratrees": ExtraTreesClassifier,
    "adaboost": AdaBoostClassifier,
    "bagging": BaggingClassifier,
}

VALID_CLASSIFIERS = frozenset(CLASSIFIER_CONSTRUCTORS)

# Metric columns the frontend results table renders for classification jobs.
CLASSIFICATION_METRICS = ["Accuracy", "F1", "AUC", "Precision", "Recall"]


def _build_classifier(algorithm: str, parameters: Optional[Dict[str, Any]]):
    constructor = CLASSIFIER_CONSTRUCTORS.get(algorithm.strip().lower())
    if constructor is None:
        raise ValueError(
            f"Classifier '{algorithm}' is not supported. Valid: {sorted(VALID_CLASSIFIERS)}"
        )
    params = parameters or {}
    valid = set(constructor().get_params().keys())
    params = {k: v for k, v in params.items() if k in valid}
    # SVC needs probability=True for AUC; enable unless the caller overrode it.
    if constructor is SVC and "probability" not in params:
        params["probability"] = True
    return constructor(**params) if params else constructor()


def _auc(model, X_test, y_test, classes) -> Optional[float]:
    """ROC-AUC for binary (positive-class proba) or multiclass (one-vs-rest, macro)."""
    try:
        if hasattr(model, "predict_proba"):
            proba = model.predict_proba(X_test)
        elif hasattr(model, "decision_function"):
            proba = model.decision_function(X_test)
        else:
            return None
        if len(classes) == 2:
            col = proba[:, 1] if getattr(proba, "ndim", 1) == 2 else proba
            return float(roc_auc_score(y_test, col))
        return float(roc_auc_score(y_test, proba, multi_class="ovr", average="macro"))
    except Exception:
        return None


def evaluate_classifier(
    X: np.ndarray,
    y: Any,
    algorithm: str,
    parameters: Optional[Dict[str, Any]] = None,
    test_split: float = 0.2,
    random_state: Optional[int] = None,
    scale: bool = True,
) -> Dict[str, Any]:
    """Train one classifier and return metrics + confusion matrix.

    Returns a dict with Accuracy/F1/AUC/Precision/Recall (rounded), the confusion
    matrix, class labels, and the fitted model + scaler + label-encoder for export.
    """
    from sklearn.metrics import precision_score, recall_score

    X = np.asarray(X, dtype=float)
    le = LabelEncoder()
    y_enc = le.fit_transform(np.asarray(y).ravel())
    classes = le.classes_

    stratify = y_enc if np.min(np.bincount(y_enc)) >= 2 else None
    X_train, X_test, y_train, y_test = train_test_split(
        X, y_enc, test_size=test_split, random_state=random_state, stratify=stratify
    )

    scaler = None
    if scale:
        scaler = StandardScaler()
        X_train = scaler.fit_transform(X_train)
        X_test = scaler.transform(X_test)

    model = _build_classifier(algorithm, parameters)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    avg = "binary" if len(classes) == 2 else "macro"
    return {
        "Accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
        "F1": round(float(f1_score(y_test, y_pred, average=avg, zero_division=0)), 4),
        "AUC": (lambda a: round(a, 4) if a is not None else None)(_auc(model, X_test, y_test, classes)),
        "Precision": round(float(precision_score(y_test, y_pred, average=avg, zero_division=0)), 4),
        "Recall": round(float(recall_score(y_test, y_pred, average=avg, zero_division=0)), 4),
        "confusion_matrix": confusion_matrix(y_test, y_pred).tolist(),
        "classes": [str(c) for c in classes],
        "y_test": [int(v) for v in y_test],
        "y_pred": [int(v) for v in y_pred],
        "_model": model,
        "_scaler": scaler,
        "_label_encoder": le,
    }


def cross_val_accuracy(
    X: np.ndarray, y: Any, algorithm: str, parameters: Optional[Dict[str, Any]] = None,
    cv: int = 5, random_state: Optional[int] = None,
) -> List[float]:
    """Per-fold accuracy for the classification CV panel (feature 6, classification path)."""
    X = np.asarray(X, dtype=float)
    y_enc = LabelEncoder().fit_transform(np.asarray(y).ravel())
    model = _build_classifier(algorithm, parameters)
    scores = cross_val_score(model, X, y_enc, cv=cv, scoring="accuracy")
    return [round(float(v), 6) for v in scores]
