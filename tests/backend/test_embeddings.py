"""Tests for the embedding strategy gate + status endpoint (feature 5).

The numeric embedding path needs torch/transformers (optional, absent in the default
backend), so these verify the availability gate and graceful rejection rather than real
embedding — exactly the contract that keeps the lightweight deploy working.
"""
import pytest

from backend.embeddings import SUPPORTED_MODELS, embeddings_available, status
from tests.backend.conftest import make_encode_payload

pytestmark = pytest.mark.unit


class TestEmbeddingStatus:
    def test_status_endpoint_shape(self, client):
        r = client.get("/api/embeddings/status")
        assert r.status_code == 200
        body = r.json()
        assert set(body) >= {"available", "default_model", "models", "reason"}
        assert body["models"] == SUPPORTED_MODELS

    def test_status_reflects_availability(self):
        s = status()
        assert s["available"] is embeddings_available()
        # When unavailable a human-readable reason is present.
        assert s["available"] or s["reason"]


class TestEmbeddingGate:
    @pytest.mark.skipif(embeddings_available(), reason="torch installed — gate would allow it")
    def test_encode_rejected_when_deps_missing(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id, strategy="embedding")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 422
        assert "torch" in r.json()["detail"].lower()
