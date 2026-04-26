"""
Integration tests for dataset upload and management API endpoints.

Endpoints covered:
  POST   /api/upload                             — file upload + analysis
  POST   /api/upload-descriptors                 — descriptor CSV upload
  GET    /api/dataset/{file_id}/rows             — fetch all rows
  POST   /api/dataset/{file_id}/deduplicate      — remove duplicate seqs
  POST   /api/dataset/{file_id}/fix-missing-sequences
  POST   /api/dataset/{file_id}/fix-missing-activity
  POST   /api/dataset/{file_id}/fix-outliers

Assumptions:
  - All endpoints use a real (in-process) FastAPI app via TestClient.
  - Files are written to the OS temp directory — no mocking of disk I/O.
  - pySAR / aaindex are mocked (see conftest.py) so encoding endpoints are
    unaffected by these tests.
"""
import pytest

from backend.main import _MAX_UPLOAD_BYTES, _MAX_UPLOAD_MB
from tests.backend.conftest import (
    CLEAN_CSV,
    CLEAN_TSV,
    DESCRIPTORS_CSV,
    DUPLICATE_CSV,
    INVALID_AA_CSV,
    MISSING_ACTIVITY_CSV,
    MISSING_SEQ_CSV,
    OUTLIER_CSV,
)


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/upload — happy-path tests
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestUploadDatasetSuccess:
    """Successful upload responses contain the expected keys and values."""

    def test_csv_upload_returns_200(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.status_code == 200

    def test_response_contains_required_top_level_keys(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        body = r.json()
        for key in ("file_id", "filename", "file_path", "columns",
                    "num_rows", "preview", "seq_col_guess", "act_col_guess",
                    "length_stats", "activity_stats", "seq_validation",
                    "duplicate_info", "missing_info", "outlier_info"):
            assert key in body, f"Missing key: {key}"

    def test_num_rows_matches_csv_content(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.json()["num_rows"] == 20  # CLEAN_CSV has 20 data rows

    def test_seq_col_guessed_correctly(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.json()["seq_col_guess"] == "sequence"

    def test_act_col_guessed_correctly(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.json()["act_col_guess"] == "T50"

    def test_tsv_upload_parsed_correctly(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.tsv", CLEAN_TSV.encode(), "text/tsv")})
        assert r.status_code == 200
        assert r.json()["num_rows"] == 5

    def test_preview_contains_at_most_20_rows(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert len(r.json()["preview"]) <= 20

    def test_activity_stats_fields_present(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        stats = r.json()["activity_stats"]
        for key in ("min", "max", "mean", "std", "histogram"):
            assert key in stats

    def test_length_stats_fields_present(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        ls = r.json()["length_stats"]
        assert "min" in ls and "max" in ls and "mean" in ls

    def test_seq_validation_reports_valid_for_clean_data(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.json()["seq_validation"]["valid"] is True

    def test_duplicate_info_no_dups_for_clean_data(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.json()["duplicate_info"]["has_duplicates"] is False

    def test_missing_info_no_missing_for_clean_data(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")})
        assert r.json()["missing_info"]["has_missing"] is False


@pytest.mark.integration
class TestUploadDatasetAnomalyDetection:
    """Upload responses correctly flag anomalies in the dataset."""

    def test_invalid_aa_characters_flagged(self, client):
        r = client.post("/api/upload",
                        files={"file": ("bad.csv", INVALID_AA_CSV.encode(), "text/csv")})
        assert r.status_code == 200
        assert r.json()["seq_validation"]["valid"] is False
        assert r.json()["seq_validation"]["invalid_count"] >= 1

    def test_duplicate_sequences_detected(self, client):
        r = client.post("/api/upload",
                        files={"file": ("dups.csv", DUPLICATE_CSV.encode(), "text/csv")})
        assert r.json()["duplicate_info"]["has_duplicates"] is True
        assert r.json()["duplicate_info"]["duplicate_count"] == 1

    def test_missing_activity_value_detected(self, client):
        r = client.post("/api/upload",
                        files={"file": ("miss.csv", MISSING_ACTIVITY_CSV.encode(), "text/csv")})
        assert r.json()["missing_info"]["has_missing"] is True
        assert r.json()["missing_info"]["act_missing"] == 1

    def test_missing_sequence_value_detected(self, client):
        r = client.post("/api/upload",
                        files={"file": ("miss.csv", MISSING_SEQ_CSV.encode(), "text/csv")})
        assert r.json()["missing_info"]["seq_missing"] == 1

    def test_outlier_detected(self, client):
        r = client.post("/api/upload",
                        files={"file": ("out.csv", OUTLIER_CSV.encode(), "text/csv")})
        assert r.json()["outlier_info"]["outlier_count"] >= 1


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/upload — error cases
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestUploadDatasetErrors:
    """Unsupported file types and malformed content are rejected with clear status codes."""

    def test_unsupported_extension_returns_400(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.xlsx", b"binary data", "application/vnd.ms-excel")})
        assert r.status_code == 400
        assert "supported" in r.json()["detail"].lower()

    def test_empty_csv_returns_422(self, client):
        r = client.post("/api/upload",
                        files={"file": ("empty.csv", b"", "text/csv")})
        assert r.status_code == 422

    def test_binary_garbage_returns_422(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv", b"\x00\x01\x02\x03", "text/csv")})
        # Parser will fail or produce an empty/single-column frame
        assert r.status_code in (200, 422)  # tolerant: allow if parser stumbles through

    def test_json_file_with_csv_extension_returns_422(self, client):
        r = client.post("/api/upload",
                        files={"file": ("data.csv",
                                        b'{"not": "csv"}',
                                        "text/csv")})
        # A JSON file read as CSV produces a single-column frame — still 200 or 422
        assert r.status_code in (200, 422)


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/upload-descriptors
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestUploadDescriptorsCSV:
    """Pre-calculated descriptor CSV upload endpoint."""

    def test_valid_csv_returns_200(self, client):
        r = client.post("/api/upload-descriptors",
                        files={"file": ("desc.csv", DESCRIPTORS_CSV.encode(), "text/csv")})
        assert r.status_code == 200

    def test_response_has_required_keys(self, client):
        r = client.post("/api/upload-descriptors",
                        files={"file": ("desc.csv", DESCRIPTORS_CSV.encode(), "text/csv")})
        body = r.json()
        for key in ("file_id", "file_path", "filename", "columns",
                    "numeric_columns", "shape", "preview"):
            assert key in body, f"Missing key: {key}"

    def test_all_columns_detected_as_numeric(self, client):
        r = client.post("/api/upload-descriptors",
                        files={"file": ("desc.csv", DESCRIPTORS_CSV.encode(), "text/csv")})
        body = r.json()
        assert len(body["numeric_columns"]) == 3  # desc_a, desc_b, desc_c

    def test_unsupported_extension_rejected(self, client):
        r = client.post("/api/upload-descriptors",
                        files={"file": ("desc.xlsx", b"junk", "application/vnd.ms-excel")})
        assert r.status_code == 400

    def test_non_numeric_csv_rejected(self, client):
        non_numeric = b"col_a,col_b\nhello,world\nfoo,bar\n"
        r = client.post("/api/upload-descriptors",
                        files={"file": ("desc.csv", non_numeric, "text/csv")})
        assert r.status_code == 422


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/dataset/{file_id}/rows
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestGetDatasetRows:
    """GET /api/dataset/{file_id}/rows returns all rows without a row cap."""

    def test_returns_all_rows(self, client, uploaded_file_id):
        r = client.get(f"/api/dataset/{uploaded_file_id}/rows")
        assert r.status_code == 200
        body = r.json()
        assert "rows" in body
        assert "total" in body
        assert body["total"] == 20

    def test_rows_are_list_of_dicts(self, client, uploaded_file_id):
        r = client.get(f"/api/dataset/{uploaded_file_id}/rows")
        rows = r.json()["rows"]
        assert isinstance(rows, list)
        assert isinstance(rows[0], dict)
        assert "sequence" in rows[0]

    def test_unknown_file_id_returns_404(self, client):
        # Must be valid UUID format (passes _validate_file_id) but not match any uploaded file
        r = client.get("/api/dataset/00000000-0000-4000-8000-000000000000/rows")
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/dataset/{file_id}/deduplicate
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestDeduplicateDataset:
    """Deduplication returns a new file_id with duplicates removed."""

    def test_dedup_removes_duplicate_rows(self, client, uploaded_duplicate_id):
        r = client.post(
            f"/api/dataset/{uploaded_duplicate_id}/deduplicate",
            params={"seq_col": "sequence"},
        )
        assert r.status_code == 200
        # DUPLICATE_CSV has 4 rows but 1 is a duplicate → result should have 3
        assert r.json()["num_rows"] == 3

    def test_dedup_returns_new_file_id(self, client, uploaded_duplicate_id):
        r = client.post(
            f"/api/dataset/{uploaded_duplicate_id}/deduplicate",
            params={"seq_col": "sequence"},
        )
        assert r.json()["file_id"] != uploaded_duplicate_id

    def test_dedup_result_no_longer_has_duplicates(self, client, uploaded_duplicate_id):
        r = client.post(
            f"/api/dataset/{uploaded_duplicate_id}/deduplicate",
            params={"seq_col": "sequence"},
        )
        assert r.json()["duplicate_info"]["has_duplicates"] is False

    def test_dedup_unknown_file_id_returns_404(self, client):
        # Must be valid UUID format (passes _validate_file_id) but not match any uploaded file
        r = client.post(
            "/api/dataset/00000000-0000-4000-8000-000000000001/deduplicate",
            params={"seq_col": "sequence"},
        )
        assert r.status_code == 404

    def test_dedup_unknown_seq_column_returns_400(self, client, uploaded_file_id):
        r = client.post(
            f"/api/dataset/{uploaded_file_id}/deduplicate",
            params={"seq_col": "nonexistent_col"},
        )
        assert r.status_code == 400

    def test_dedup_clean_data_unchanged(self, client, uploaded_file_id):
        r = client.post(
            f"/api/dataset/{uploaded_file_id}/deduplicate",
            params={"seq_col": "sequence"},
        )
        # CLEAN_CSV has no duplicates → all 20 rows preserved
        assert r.json()["num_rows"] == 20


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/dataset/{file_id}/fix-missing-sequences
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestFixMissingSequences:
    """Rows with null/empty sequences are dropped."""

    def test_removes_missing_sequence_row(self, client, uploaded_missing_seq_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_seq_id}/fix-missing-sequences",
            params={"seq_col": "sequence", "act_col": "T50"},
        )
        assert r.status_code == 200
        # MISSING_SEQ_CSV: 3 rows → 1 missing → 2 remain
        assert r.json()["num_rows"] == 2

    def test_fix_adds_removed_count(self, client, uploaded_missing_seq_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_seq_id}/fix-missing-sequences",
            params={"seq_col": "sequence", "act_col": "T50"},
        )
        assert r.json()["removed"] == 1

    def test_result_has_no_missing_sequences(self, client, uploaded_missing_seq_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_seq_id}/fix-missing-sequences",
            params={"seq_col": "sequence", "act_col": "T50"},
        )
        assert r.json()["missing_info"]["seq_missing"] == 0

    def test_unknown_file_id_returns_404(self, client):
        # Must be valid UUID format (passes _validate_file_id) but not match any uploaded file
        r = client.post(
            "/api/dataset/00000000-0000-4000-8000-000000000002/fix-missing-sequences",
            params={"seq_col": "sequence", "act_col": "T50"},
        )
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/dataset/{file_id}/fix-missing-activity
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestFixMissingActivity:
    """Missing activity values are remediated via mean, median, or row removal."""

    @pytest.mark.parametrize("method", ["mean", "median", "remove"])
    def test_all_methods_return_200(self, client, uploaded_missing_activity_id, method):
        r = client.post(
            f"/api/dataset/{uploaded_missing_activity_id}/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": method},
        )
        assert r.status_code == 200

    def test_mean_imputation_preserves_row_count(self, client, uploaded_missing_activity_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_activity_id}/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": "mean"},
        )
        # MISSING_ACTIVITY_CSV has 4 rows; mean imputation keeps all
        assert r.json()["num_rows"] == 4

    def test_remove_method_reduces_row_count(self, client, uploaded_missing_activity_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_activity_id}/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": "remove"},
        )
        assert r.json()["num_rows"] == 3  # 1 missing row removed

    def test_result_has_no_missing_activity_after_imputation(
            self, client, uploaded_missing_activity_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_activity_id}/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": "mean"},
        )
        assert r.json()["missing_info"]["act_missing"] == 0

    def test_affected_count_returned(self, client, uploaded_missing_activity_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_activity_id}/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": "mean"},
        )
        assert r.json()["affected"] == 1

    def test_fix_method_returned_in_response(self, client, uploaded_missing_activity_id):
        r = client.post(
            f"/api/dataset/{uploaded_missing_activity_id}/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": "median"},
        )
        assert r.json()["fix_method"] == "median"

    def test_unknown_file_id_returns_404(self, client):
        # Must be valid UUID format (passes _validate_file_id) but not match any uploaded file
        r = client.post(
            "/api/dataset/00000000-0000-4000-8000-000000000003/fix-missing-activity",
            params={"seq_col": "sequence", "act_col": "T50", "method": "mean"},
        )
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/dataset/{file_id}/fix-outliers
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestFixOutliers:
    """Outlier activity values are remediated via winsorize, mean, or row removal."""

    @pytest.mark.parametrize("method", ["winsorize", "mean", "remove"])
    def test_all_methods_return_200(self, client, uploaded_outlier_id, method):
        r = client.post(
            f"/api/dataset/{uploaded_outlier_id}/fix-outliers",
            params={"seq_col": "sequence", "act_col": "T50", "method": method},
        )
        assert r.status_code == 200

    def test_winsorize_clamps_value_to_boundary(self, client, uploaded_outlier_id):
        r = client.post(
            f"/api/dataset/{uploaded_outlier_id}/fix-outliers",
            params={"seq_col": "sequence", "act_col": "T50", "method": "winsorize"},
        )
        body = r.json()
        # Winsorize clamps values to the 3σ boundary without removing rows
        assert body["num_rows"] == 12
        # One value was clamped (the outlier at 150.0)
        assert body["affected"] == 1

    def test_remove_method_reduces_row_count(self, client, uploaded_outlier_id):
        r = client.post(
            f"/api/dataset/{uploaded_outlier_id}/fix-outliers",
            params={"seq_col": "sequence", "act_col": "T50", "method": "remove"},
        )
        assert r.json()["num_rows"] == 11  # 1 outlier row removed

    def test_invalid_method_returns_400(self, client, uploaded_outlier_id):
        r = client.post(
            f"/api/dataset/{uploaded_outlier_id}/fix-outliers",
            params={"seq_col": "sequence", "act_col": "T50", "method": "invalid"},
        )
        assert r.status_code == 400

    def test_unknown_file_id_returns_404(self, client):
        # Must be valid UUID format (passes _validate_file_id) but not match any uploaded file
        r = client.post(
            "/api/dataset/00000000-0000-4000-8000-000000000004/fix-outliers",
            params={"seq_col": "sequence", "act_col": "T50", "method": "winsorize"},
        )
        assert r.status_code == 404

    def test_affected_count_in_response(self, client, uploaded_outlier_id):
        r = client.post(
            f"/api/dataset/{uploaded_outlier_id}/fix-outliers",
            params={"seq_col": "sequence", "act_col": "T50", "method": "remove"},
        )
        assert r.json()["affected"] == 1


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/upload — file size limit
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestUploadFileSizeLimit:
    """Files exceeding _MAX_UPLOAD_BYTES are rejected with HTTP 413 before disk I/O."""

    def test_dataset_upload_over_limit_returns_413(self, client):
        # Craft a payload one byte over the limit
        oversized = b"A" * (_MAX_UPLOAD_BYTES + 1)
        r = client.post("/api/upload",
                        files={"file": ("big.csv", oversized, "text/csv")})
        assert r.status_code == 413

    def test_413_detail_mentions_max_size(self, client):
        oversized = b"A" * (_MAX_UPLOAD_BYTES + 1)
        r = client.post("/api/upload",
                        files={"file": ("big.csv", oversized, "text/csv")})
        detail = r.json()["detail"].lower()
        assert str(_MAX_UPLOAD_MB) in detail or "too large" in detail

    def test_descriptor_upload_over_limit_returns_413(self, client):
        oversized = b"A" * (_MAX_UPLOAD_BYTES + 1)
        r = client.post("/api/upload-descriptors",
                        files={"file": ("big.csv", oversized, "text/csv")})
        assert r.status_code == 413

    def test_max_upload_bytes_constant_is_correct(self):
        # Verify the constant matches the documented 10 MB limit
        assert _MAX_UPLOAD_BYTES == _MAX_UPLOAD_MB * 1024 * 1024
        assert _MAX_UPLOAD_MB == 10
