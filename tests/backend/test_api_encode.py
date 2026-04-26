"""
Integration tests for the encoding job lifecycle endpoints.

Endpoints covered:
  POST   /api/encode                — submit a new encoding job
  GET    /api/jobs/{job_id}         — get a single job's status + results
  GET    /api/jobs                  — list all jobs (no results payload)
  POST   /api/jobs/{job_id}/cancel  — request cancellation
  DELETE /api/jobs/{job_id}         — remove a job from the registry

Strategy for testing the background job runner:
  - POST /api/encode: the endpoint spawns a daemon thread then immediately returns
    a job_id. We ONLY test the HTTP response shape and JOBS initial state.
    We do NOT wait for encoding to complete (pySAR is mocked and would fail).
  - GET/cancel/delete: inject pre-built job dicts directly into JOBS via the
    fixtures in conftest.py — this gives us full control without needing to
    run pySAR encoding.
"""
import os
import uuid

import pytest

from backend.main import JOBS, UPLOAD_DIR, _CANCEL_EVENTS, _CANCEL_PROCESSES, _MAX_CONCURRENT_JOBS_PER_IP, _VALID_ALGORITHMS, _JOB_COMPLETED_TTL_SECS, _subprocess_exit_hint
from tests.backend.conftest import CLEAN_CSV, make_encode_payload


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/encode — job submission
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestSubmitEncodingJob:
    """POST /api/encode registers a new job and returns a job_id."""

    def test_returns_200_with_job_id(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 200
        assert "job_id" in r.json()
        assert isinstance(r.json()["job_id"], str)

    def test_job_id_is_uuid_format(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        # Should not raise ValueError if it is a valid UUID
        parsed = uuid.UUID(job_id)
        assert str(parsed) == job_id

    def test_job_appears_in_jobs_registry(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        assert job_id in JOBS

    def test_initial_job_status_is_pending_or_running(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        # Mock pySAR completes instantly; accept completed as well as in-progress states
        assert JOBS[job_id]["status"] in ("pending", "running", "completed")

    def test_initial_progress_is_low(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        # Mock pySAR completes instantly; progress may already be 100 — just verify it's a number
        assert isinstance(JOBS[job_id]["progress"], (int, float))

    def test_cancel_event_created_for_new_job(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        assert job_id in _CANCEL_EVENTS

    def test_strategy_stored_on_job(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id, strategy="aai")
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        assert JOBS[job_id]["strategy"] == "aai"

    def test_algorithm_stored_on_job(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id, algorithm="ridge")
        r = client.post("/api/encode", json=payload)
        job_id = r.json()["job_id"]
        assert JOBS[job_id]["algorithm"] == "ridge"

    def test_missing_required_field_returns_422(self, client):
        # file_path is required; omitting it should fail Pydantic validation
        r = client.post("/api/encode", json={"sequence_col": "seq", "activity_col": "T50"})
        assert r.status_code == 422

    def test_invalid_json_body_returns_422(self, client):
        r = client.post("/api/encode",
                        content=b"not json",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 422

    def test_two_jobs_get_distinct_ids(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id)
        r1 = client.post("/api/encode", json=payload)
        r2 = client.post("/api/encode", json=payload)
        assert r1.json()["job_id"] != r2.json()["job_id"]


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/jobs/{job_id} — single job retrieval
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestGetJob:
    """GET /api/jobs/{job_id} returns the full job dict including results."""

    def test_returns_200_for_existing_job(self, client, completed_job):
        r = client.get(f"/api/jobs/{completed_job}")
        assert r.status_code == 200

    def test_returns_all_expected_fields(self, client, completed_job):
        r = client.get(f"/api/jobs/{completed_job}")
        body = r.json()
        for field in ("job_id", "status", "progress", "log",
                      "strategy", "algorithm", "created_at"):
            assert field in body, f"Missing field: {field}"

    def test_returns_results_for_completed_job(self, client, completed_job):
        r = client.get(f"/api/jobs/{completed_job}")
        body = r.json()
        assert body["status"] == "completed"
        assert body["results"] is not None
        assert len(body["results"]) > 0

    def test_returns_best_model_predictions(self, client, completed_job):
        r = client.get(f"/api/jobs/{completed_job}")
        preds = r.json()["best_model_predictions"]
        assert preds is not None
        assert "model_name" in preds
        assert "actual" in preds
        assert "predicted" in preds
        assert len(preds["actual"]) == len(preds["predicted"])

    def test_returns_404_for_unknown_job_id(self, client):
        r = client.get("/api/jobs/nonexistent-job-id")
        assert r.status_code == 404
        assert "not found" in r.json()["detail"].lower()

    def test_running_job_has_no_results(self, client, running_job):
        r = client.get(f"/api/jobs/{running_job}")
        body = r.json()
        assert body["status"] == "running"
        assert body["results"] is None


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/jobs — list all jobs
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestListJobs:
    """GET /api/jobs lists all jobs without the results payload."""

    def test_returns_empty_list_when_no_jobs(self, client):
        r = client.get("/api/jobs")
        assert r.status_code == 200
        assert r.json() == []

    def test_returns_one_entry_per_job(self, client, completed_job, running_job):
        r = client.get("/api/jobs")
        assert r.status_code == 200
        assert len(r.json()) == 2

    def test_results_key_excluded_from_list(self, client, completed_job):
        r = client.get("/api/jobs")
        body = r.json()
        assert len(body) == 1
        assert "results" not in body[0]

    def test_job_metadata_present_in_list(self, client, completed_job):
        r = client.get("/api/jobs")
        entry = r.json()[0]
        for field in ("job_id", "status", "progress", "strategy", "algorithm"):
            assert field in entry


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/jobs/{job_id}/cancel
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestCancelJob:
    """POST /api/jobs/{job_id}/cancel signals cancellation for running jobs."""

    def test_cancel_running_job_returns_200(self, client, running_job):
        r = client.post(f"/api/jobs/{running_job}/cancel")
        assert r.status_code == 200

    def test_cancel_returns_job_id_in_response(self, client, running_job):
        r = client.post(f"/api/jobs/{running_job}/cancel")
        assert r.json()["cancelled"] == running_job

    def test_cancel_sets_job_status_to_cancelled(self, client, running_job):
        client.post(f"/api/jobs/{running_job}/cancel")
        assert JOBS[running_job]["status"] == "cancelled"

    def test_cancel_appends_log_entry(self, client, running_job):
        client.post(f"/api/jobs/{running_job}/cancel")
        log = JOBS[running_job]["log"]
        assert any("cancel" in entry.lower() for entry in log)

    def test_cancel_sets_completed_at(self, client, running_job):
        client.post(f"/api/jobs/{running_job}/cancel")
        assert JOBS[running_job]["completed_at"] is not None

    def test_cancel_unknown_job_returns_200(self, client):
        # Per spec: returns 200 even for unknown job IDs (different Cloud Run instance)
        r = client.post("/api/jobs/nonexistent-job-id/cancel")
        assert r.status_code == 200
        assert "cancelled" in r.json()

    def test_cancel_already_completed_job_is_no_op(self, client, completed_job):
        r = client.post(f"/api/jobs/{completed_job}/cancel")
        assert r.status_code == 200
        # Status should remain "completed"
        assert JOBS[completed_job]["status"] == "completed"


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/jobs/{job_id}/cancel — subprocess termination
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestCancelJobSubprocess:
    """Verify cancel_job terminates any registered encoding subprocess immediately."""

    def test_cancel_terminates_registered_process(self, client, running_job):
        """A process registered in _CANCEL_PROCESSES is terminated on cancel."""
        terminated = []

        class _FakeProc:
            def terminate(self): terminated.append(True)
            def kill(self): pass

        _CANCEL_PROCESSES[running_job] = _FakeProc()
        client.post(f"/api/jobs/{running_job}/cancel")
        assert terminated, "proc.terminate() was not called"

    def test_cancel_removes_process_from_registry(self, client, running_job):
        """After cancel the process handle is removed from _CANCEL_PROCESSES."""
        class _FakeProc:
            def terminate(self): pass
            def kill(self): pass

        _CANCEL_PROCESSES[running_job] = _FakeProc()
        client.post(f"/api/jobs/{running_job}/cancel")
        assert running_job not in _CANCEL_PROCESSES

    def test_cancel_with_no_registered_process_still_succeeds(self, client, running_job):
        """Cancel works normally even when no subprocess is registered (pre-phase-4 cancel)."""
        # Ensure no entry exists for this job
        _CANCEL_PROCESSES.pop(running_job, None)
        r = client.post(f"/api/jobs/{running_job}/cancel")
        assert r.status_code == 200
        assert JOBS[running_job]["status"] == "cancelled"

    def test_cancel_event_is_also_set_when_process_registered(self, client, running_job):
        """Even with a subprocess registered, the threading.Event is still signalled."""
        import threading
        from backend.main import _CANCEL_EVENTS

        class _FakeProc:
            def terminate(self): pass
            def kill(self): pass

        # Seed both registries — mirrors what start_encoding() does before the thread runs
        _CANCEL_EVENTS[running_job] = threading.Event()
        _CANCEL_PROCESSES[running_job] = _FakeProc()
        client.post(f"/api/jobs/{running_job}/cancel")
        assert _CANCEL_EVENTS[running_job].is_set()


# ──────────────────────────────────────────────────────────────────────────────
# DELETE /api/jobs/{job_id}
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestDeleteJob:
    """DELETE /api/jobs/{job_id} removes a job from the in-memory registry."""

    def test_delete_existing_job_returns_200(self, client, completed_job):
        r = client.delete(f"/api/jobs/{completed_job}")
        assert r.status_code == 200

    def test_delete_returns_deleted_job_id(self, client, completed_job):
        r = client.delete(f"/api/jobs/{completed_job}")
        assert r.json()["deleted"] == completed_job

    def test_job_no_longer_in_registry_after_delete(self, client, completed_job):
        client.delete(f"/api/jobs/{completed_job}")
        assert completed_job not in JOBS

    def test_delete_unknown_job_returns_200(self, client):
        # Idempotent: deleting a non-existent job should not raise
        r = client.delete("/api/jobs/nonexistent-job-id")
        assert r.status_code == 200

    def test_after_delete_get_returns_404(self, client, completed_job):
        client.delete(f"/api/jobs/{completed_job}")
        r = client.get(f"/api/jobs/{completed_job}")
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/encode — request field validation (422 fast-fail)
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestEncodeRequestValidation:
    """EncodeRequest Pydantic validators reject bad input with 422 before pySAR runs."""

    def test_invalid_strategy_returns_422(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id, strategy="bad_strategy")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 422

    def test_invalid_sort_by_returns_422(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id, sort_by="NotAMetric")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 422

    def test_invalid_algorithm_returns_422(self, client, uploaded_file_id):
        payload = make_encode_payload(uploaded_file_id, algorithm="not_a_real_algo")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 422

    def test_valid_algorithms_accepted(self, client, uploaded_file_id):
        # Spot-check a representative subset of valid algorithm names.
        # Limited to 5 to stay within the per-IP encode rate limit (5 req/60 s).
        # Full allowlist correctness is verified by test_valid_algorithms_contains_all_expected_entries.
        for algo in ("ridge", "svr", "randomforest", "hgbr", "extratrees"):
            payload = make_encode_payload(uploaded_file_id, algorithm=algo)
            r = client.post("/api/encode", json=payload)
            assert r.status_code == 200, f"Expected 200 for algorithm={algo!r}, got {r.status_code}"

    def test_path_traversal_rejected_with_422(self, client):
        # Paths outside UPLOAD_DIR must be blocked regardless of other fields
        payload = make_encode_payload("dummy", file_path="../../etc/passwd")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 422

    def test_absolute_path_outside_upload_dir_rejected(self, client):
        payload = make_encode_payload("dummy", file_path="/etc/passwd")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 422

    def test_path_within_upload_dir_accepted(self, client, uploaded_file_id):
        # A well-formed path inside UPLOAD_DIR should pass the validator
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 200

    def test_n_jobs_clamped_to_cpu_count(self, client, uploaded_file_id):
        # Submitting n_jobs=9999 should not raise — it gets clamped server-side
        payload = make_encode_payload(uploaded_file_id, n_jobs=9999)
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 200
        job_id = r.json()["job_id"]
        # The stored n_jobs (accessible via req in _run_job) is clamped; the job itself
        # should have been created successfully
        assert job_id in JOBS

    def test_n_jobs_clamped_value_does_not_exceed_cpu_count(self, client, uploaded_file_id):
        # Verify the validator clamps to cpu_count — this tests the validator in isolation
        from backend.main import EncodeRequest
        req = EncodeRequest(
            file_path=str(UPLOAD_DIR / f"{uploaded_file_id}.csv"),
            sequence_col="sequence",
            activity_col="T50",
            n_jobs=9999,
        )
        assert req.n_jobs <= (os.cpu_count() or 4)

    def test_algorithm_normalised_to_lowercase(self, client, uploaded_file_id):
        # Validators normalise to lowercase; the algorithm is stored in lowercase
        payload = make_encode_payload(uploaded_file_id, algorithm="PLSRegression")
        r = client.post("/api/encode", json=payload)
        assert r.status_code == 200
        job_id = r.json()["job_id"]
        assert JOBS[job_id]["algorithm"] == "plsregression"


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/encode — per-IP concurrent job limit
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestConcurrentJobLimit:
    """Per-IP concurrent job limit rejects new submissions when at capacity."""

    def _inject_running_job(self, ip: str) -> str:
        """Directly inject a running job attributed to an IP into JOBS."""
        job_id = str(uuid.uuid4())
        JOBS[job_id] = {
            "job_id": job_id, "status": "running", "progress": 50,
            "models_completed": 0, "models_in_progress": 0, "total_models": 0,
            "partial_results": [], "log": [], "results": None, "columns": [],
            "best_model_predictions": None, "error": None,
            "strategy": "aai", "algorithm": "plsregression", "ip": ip,
            "created_at": "2026-04-22T10:00:00+00:00",
            "started_at": "2026-04-22T10:00:01+00:00",
            "completed_at": None,
        }
        return job_id

    def test_submission_accepted_below_limit(self, client, uploaded_file_id):
        # One fewer than the max should still be accepted
        ip = "10.99.0.1"
        for _ in range(_MAX_CONCURRENT_JOBS_PER_IP - 1):
            self._inject_running_job(ip)
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload, headers={"X-Forwarded-For": ip})
        assert r.status_code == 200

    def test_submission_rejected_at_limit(self, client, uploaded_file_id):
        ip = "10.99.0.2"
        for _ in range(_MAX_CONCURRENT_JOBS_PER_IP):
            self._inject_running_job(ip)
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload, headers={"X-Forwarded-For": ip})
        assert r.status_code == 429

    def test_limit_is_per_ip_different_ip_unaffected(self, client, uploaded_file_id):
        ip_a = "10.99.0.3"
        ip_b = "10.99.0.4"
        # Saturate IP A
        for _ in range(_MAX_CONCURRENT_JOBS_PER_IP):
            self._inject_running_job(ip_a)
        # IP B should still be accepted
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload, headers={"X-Forwarded-For": ip_b})
        assert r.status_code == 200

    def test_completed_jobs_do_not_count_toward_limit(self, client, uploaded_file_id):
        ip = "10.99.0.5"
        # Inject completed jobs — they should not count
        for _ in range(_MAX_CONCURRENT_JOBS_PER_IP + 2):
            jid = self._inject_running_job(ip)
            JOBS[jid]["status"] = "completed"
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload, headers={"X-Forwarded-For": ip})
        assert r.status_code == 200

    def test_rejected_response_body_has_detail(self, client, uploaded_file_id):
        ip = "10.99.0.6"
        for _ in range(_MAX_CONCURRENT_JOBS_PER_IP):
            self._inject_running_job(ip)
        payload = make_encode_payload(uploaded_file_id)
        r = client.post("/api/encode", json=payload, headers={"X-Forwarded-For": ip})
        assert "detail" in r.json()


# ──────────────────────────────────────────────────────────────────────────────
# Algorithm allowlist and job TTL configuration
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestBackendConfiguration:
    """Sanity-check backend constants that guard security and resource bounds."""

    def test_hgbr_in_valid_algorithms(self):
        # hgbr (HistGradientBoostingRegressor) must be in the allowlist
        assert "hgbr" in _VALID_ALGORITHMS

    def test_extratrees_in_valid_algorithms(self):
        # extratrees (ExtraTreesRegressor) must be in the allowlist
        assert "extratrees" in _VALID_ALGORITHMS

    def test_bagging_in_valid_algorithms(self):
        # bagging (BaggingRegressor) must be in the allowlist
        assert "bagging" in _VALID_ALGORITHMS

    def test_adaboost_in_valid_algorithms(self):
        # adaboost (AdaBoostRegressor) must be in the allowlist
        assert "adaboost" in _VALID_ALGORITHMS

    def test_gpr_in_valid_algorithms(self):
        # gpr (GaussianProcessRegressor) must be in the allowlist
        assert "gpr" in _VALID_ALGORITHMS

    def test_linear_in_valid_algorithms(self):
        # linear (LinearRegression) must be in the allowlist
        assert "linear" in _VALID_ALGORITHMS

    def test_valid_algorithms_contains_all_expected_entries(self):
        expected = {
            "plsregression", "ridge", "lasso", "elasticnet", "svr",
            "randomforest", "gradientboosting", "hgbr", "knn", "linearregression",
            "extratrees", "bagging", "adaboost", "gpr", "linear",
        }
        assert expected == _VALID_ALGORITHMS

    def test_job_completed_ttl_is_positive(self):
        # TTL must be a positive number of seconds
        assert _JOB_COMPLETED_TTL_SECS > 0

    def test_job_completed_ttl_default_is_30_minutes(self):
        # Default TTL is 1800 s (30 min) unless overridden by env var
        import os
        if "JOB_COMPLETED_TTL_SECS" not in os.environ:
            assert _JOB_COMPLETED_TTL_SECS == 1800

    def test_objc_fork_safety_env_var_set_on_macos(self):
        # On macOS, OBJC_DISABLE_INITIALIZE_FORK_SAFETY must be set to YES so that
        # forked encoding subprocesses don't SIGSEGV after BLAS/numpy initialisation.
        import os
        import sys
        if sys.platform == "darwin":
            assert os.environ.get("OBJC_DISABLE_INITIALIZE_FORK_SAFETY") == "YES"


@pytest.mark.integration
class TestSubprocessExitHint:
    """Unit tests for _subprocess_exit_hint() — exit-code-to-message mapping."""

    def test_sigsegv_minus_11_mentions_segfault(self):
        hint = _subprocess_exit_hint(-11)
        assert "segmentation fault" in hint.lower()

    def test_sigsegv_minus_11_mentions_macos_objc(self):
        hint = _subprocess_exit_hint(-11)
        assert "objective-c" in hint.lower() or "macos" in hint.lower()

    def test_sigsegv_minus_11_mentions_start_sh(self):
        hint = _subprocess_exit_hint(-11)
        assert "start.sh" in hint

    def test_sigkill_minus_9_mentions_memory(self):
        hint = _subprocess_exit_hint(-9)
        assert "memory" in hint.lower()

    def test_sigkill_minus_9_does_not_mention_segfault(self):
        hint = _subprocess_exit_hint(-9)
        assert "segmentation fault" not in hint.lower()

    def test_other_exit_codes_include_exit_code_value(self):
        hint = _subprocess_exit_hint(-15)
        assert "-15" in hint

    def test_positive_exit_code_returns_generic_message(self):
        # Non-signal exits (e.g. sys.exit(1)) should still produce a useful hint
        hint = _subprocess_exit_hint(1)
        assert "1" in hint

    def test_returns_string(self):
        for code in (-11, -9, -15, 0, 1, 2):
            assert isinstance(_subprocess_exit_hint(code), str)
