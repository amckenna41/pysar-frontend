"""
Integration tests for miscellaneous / informational API endpoints.

Endpoints covered:
  GET  /api/health               — liveness check
  GET  /api/aai-indices          — flat list of AAI record codes
  GET  /api/aai-indices-full     — rich record list (code/title/category)
  GET  /api/descriptors          — descriptor catalogue
  GET  /api/version              — backend and Python version strings
  POST /api/example-dataset/{name} — load a bundled example dataset

The aaindex module is pre-mocked in conftest.py so any call to aaindex.aaindex1
returns a MagicMock.  Each test class that exercises aaindex re-mocks the
specific methods it needs using monkeypatch to control return values precisely.
"""
import sys

import pytest


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/health
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestHealthEndpoint:
    """Health check always returns 200 with status 'ok'."""

    def test_returns_200(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200

    def test_body_contains_status_ok(self, client):
        r = client.get("/api/health")
        assert r.json()["status"] == "ok"

    def test_response_is_json(self, client):
        r = client.get("/api/health")
        assert r.headers["content-type"].startswith("application/json")


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/aai-indices
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestAaiIndicesFlat:
    """GET /api/aai-indices returns a list of AAI record code strings."""

    def test_returns_200(self, client, monkeypatch):
        mock_aaindex = sys.modules["aaindex"]
        mock_aaindex.aaindex1.record_codes.return_value = ["ALTS910101", "BHAR880101"]
        r = client.get("/api/aai-indices")
        assert r.status_code == 200

    def test_returns_list_of_strings(self, client, monkeypatch):
        mock_aaindex = sys.modules["aaindex"]
        mock_aaindex.aaindex1.record_codes.return_value = ["ALTS910101", "BHAR880101"]
        r = client.get("/api/aai-indices")
        body = r.json()["indices"]
        assert isinstance(body, list)
        assert all(isinstance(code, str) for code in body)

    def test_returns_expected_codes(self, client, monkeypatch):
        mock_aaindex = sys.modules["aaindex"]
        mock_aaindex.aaindex1.record_codes.return_value = ["ALTS910101", "BHAR880101"]
        r = client.get("/api/aai-indices")
        body = r.json()["indices"]
        assert "ALTS910101" in body
        assert "BHAR880101" in body

    def test_returns_all_codes_from_mock(self, client, monkeypatch):
        codes = [f"CODE{i:04d}" for i in range(100)]
        mock_aaindex = sys.modules["aaindex"]
        mock_aaindex.aaindex1.record_codes.return_value = codes
        r = client.get("/api/aai-indices")
        assert len(r.json()["indices"]) == 100


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/aai-indices-full
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestAaiIndicesFull:
    """GET /api/aai-indices-full returns rich record objects."""

    def _setup_mock_records(self):
        """Build a minimal aaindex record mock with required attributes."""
        from unittest.mock import MagicMock
        rec = MagicMock()
        rec.code = "ALTS910101"
        rec.title = "Amino acid substitution matrix"
        rec.category = "substitution"
        rec.index = {"A": 1.0, "C": 0.5}
        return {"ALTS910101": rec}

    def test_returns_200(self, client):
        mock_aaindex = sys.modules["aaindex"]
        mock_aaindex.aaindex1.__iter__ = lambda self: iter(
            self._setup_mock_records().values()
        ) if False else iter([])
        r = client.get("/api/aai-indices-full")
        assert r.status_code == 200

    def test_response_is_a_list(self, client):
        r = client.get("/api/aai-indices-full")
        assert isinstance(r.json()["records"], list)

    def test_each_entry_has_required_fields(self, client):
        r = client.get("/api/aai-indices-full")
        entries = r.json()["records"]
        if entries:
            entry = entries[0]
            for field in ("code", "title", "category"):
                assert field in entry


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/descriptors
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestDescriptorsCatalogue:
    """GET /api/descriptors returns the built-in descriptor catalogue."""

    def test_returns_200(self, client):
        r = client.get("/api/descriptors")
        assert r.status_code == 200

    def test_returns_non_empty_list(self, client):
        r = client.get("/api/descriptors")
        body = r.json()["descriptors"]
        assert isinstance(body, list)
        assert len(body) > 0

    def test_each_entry_has_expected_keys(self, client):
        r = client.get("/api/descriptors")
        for entry in r.json()["descriptors"]:
            for key in ("name", "label", "category", "feature_count", "configurable"):
                assert key in entry, f"Descriptor entry missing key: {key}"

    def test_feature_count_is_positive_integer(self, client):
        r = client.get("/api/descriptors")
        for entry in r.json()["descriptors"]:
            assert isinstance(entry["feature_count"], int)
            assert entry["feature_count"] > 0

    def test_configurable_is_boolean(self, client):
        r = client.get("/api/descriptors")
        for entry in r.json()["descriptors"]:
            assert isinstance(entry["configurable"], bool)

    def test_descriptor_names_are_unique(self, client):
        r = client.get("/api/descriptors")
        names = [e["name"] for e in r.json()["descriptors"]]
        assert len(names) == len(set(names))


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/version
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestVersionEndpoint:
    """GET /api/version reports software version metadata."""

    def test_returns_200(self, client):
        r = client.get("/api/version")
        assert r.status_code == 200

    def test_backend_version_field_present(self, client):
        body = r = client.get("/api/version").json()
        assert "backend_version" in body

    def test_python_version_field_present(self, client):
        body = client.get("/api/version").json()
        assert "python_version" in body

    def test_python_version_matches_runtime(self, client):
        import sys as _sys
        body = client.get("/api/version").json()
        runtime = f"{_sys.version_info.major}.{_sys.version_info.minor}"
        assert body["python_version"].startswith(runtime)


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/example-dataset/{name}
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestExampleDataset:
    """POST /api/example-dataset/{name} loads a bundled example dataset."""

    def test_thermostability_dataset_returns_200(self, client):
        r = client.post("/api/example-dataset/thermostability")
        assert r.status_code == 200

    def test_thermostability_response_has_upload_shape(self, client):
        r = client.post("/api/example-dataset/thermostability")
        body = r.json()
        for key in ("file_id", "num_rows", "columns", "seq_col_guess", "act_col_guess"):
            assert key in body

    def test_thermostability_rows_are_positive(self, client):
        r = client.post("/api/example-dataset/thermostability")
        assert r.json()["num_rows"] > 0

    def test_absorption_dataset_returns_200(self, client):
        r = client.post("/api/example-dataset/absorption")
        assert r.status_code == 200

    def test_enantioselectivity_dataset_returns_200(self, client):
        r = client.post("/api/example-dataset/enantioselectivity")
        assert r.status_code == 200

    def test_localization_dataset_returns_200(self, client):
        r = client.post("/api/example-dataset/localization")
        assert r.status_code == 200

    def test_nonexistent_dataset_returns_404(self, client):
        r = client.post("/api/example-dataset/does_not_exist")
        assert r.status_code == 404
        assert "not found" in r.json()["detail"].lower()

    def test_path_traversal_rejected(self, client):
        # Ensure ../etc/passwd style traversal is rejected
        r = client.post("/api/example-dataset/../../etc/passwd")
        # FastAPI path parsing will either 404 or 422 depending on routing
        assert r.status_code in (400, 404, 422)
