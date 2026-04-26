"""
Rate-limiting middleware integration tests.

The backend applies a sliding-window rate limit per IP address:
  - /api/encode  POST — 5 requests per 60 seconds
  - /api/upload  POST — 20 requests per 60 seconds

Strategy:
  1. Each test uses `X-Forwarded-For` to supply a unique fake IP, isolating
     counter buckets from other tests.
  2. The `clean_rate_limits` fixture (autouse in conftest.py) clears
     `_RATE_LIMIT_STORE` between every test for independence.
  3. We only call up to the limit on encode (5 calls) to keep tests fast.
     The limit on /api/upload is exercised by patching the internal dict
     directly to simulate near-exhaustion.
"""
import uuid

import pytest

from backend.main import _RATE_LIMIT_STORE
from tests.backend.conftest import make_encode_payload


# ── helpers ────────────────────────────────────────────────────────────────────

def _fresh_ip() -> str:
    """Generate a unique fake IP per test run to avoid shared counter state."""
    return f"10.{uuid.uuid4().int % 256}.{uuid.uuid4().int % 256}.1"


def _post_encode(client, ip: str, file_id: str) -> list:
    """Fire a single POST /api/encode with the given IP header."""
    payload = make_encode_payload(file_id)
    return client.post(
        "/api/encode",
        json=payload,
        headers={"X-Forwarded-For": ip},
    )


# ──────────────────────────────────────────────────────────────────────────────
# /api/encode  — limit: 5 per 60 s
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestEncodeRateLimit:
    """Encode endpoint enforces 5 requests / 60 s per IP."""

    def test_first_five_requests_succeed(self, client, uploaded_file_id):
        ip = _fresh_ip()
        for _ in range(5):
            r = _post_encode(client, ip, uploaded_file_id)
            assert r.status_code == 200, f"Expected 200, got {r.status_code}"

    def test_sixth_request_is_rejected_with_429(self, client, uploaded_file_id):
        ip = _fresh_ip()
        for _ in range(5):
            _post_encode(client, ip, uploaded_file_id)
        r = _post_encode(client, ip, uploaded_file_id)
        assert r.status_code == 429

    def test_429_response_contains_retry_after_header(self, client, uploaded_file_id):
        ip = _fresh_ip()
        for _ in range(5):
            _post_encode(client, ip, uploaded_file_id)
        r = _post_encode(client, ip, uploaded_file_id)
        assert "retry-after" in {k.lower() for k in r.headers}

    def test_retry_after_value_is_positive_integer(self, client, uploaded_file_id):
        ip = _fresh_ip()
        for _ in range(5):
            _post_encode(client, ip, uploaded_file_id)
        r = _post_encode(client, ip, uploaded_file_id)
        retry_after = int(r.headers.get("retry-after", "0"))
        assert retry_after > 0

    def test_different_ips_have_independent_counters(self, client, uploaded_file_id):
        ip_a = _fresh_ip()
        ip_b = _fresh_ip()
        # Exhaust IP A's limit
        for _ in range(5):
            _post_encode(client, ip_a, uploaded_file_id)
        # IP A's 6th request is rejected
        r_a = _post_encode(client, ip_a, uploaded_file_id)
        assert r_a.status_code == 429
        # IP B is unaffected — 5 requests should still succeed
        for _ in range(5):
            r_b = _post_encode(client, ip_b, uploaded_file_id)
            assert r_b.status_code == 200

    def test_429_body_has_detail_message(self, client, uploaded_file_id):
        ip = _fresh_ip()
        for _ in range(5):
            _post_encode(client, ip, uploaded_file_id)
        r = _post_encode(client, ip, uploaded_file_id)
        body = r.json()
        assert "detail" in body
        assert len(body["detail"]) > 0

    def test_rate_limit_counter_increments_in_store(self, client, uploaded_file_id):
        ip = _fresh_ip()
        _post_encode(client, ip, uploaded_file_id)
        # There should be at least one counter entry for this IP in the store
        assert any(ip in str(k) for k in _RATE_LIMIT_STORE)


# ──────────────────────────────────────────────────────────────────────────────
# /api/upload — limit: 20 per 60 s
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestUploadRateLimit:
    """Upload endpoint enforces 20 requests / 60 s per IP."""

    def _post_upload(self, client, ip: str) -> object:
        from tests.backend.conftest import CLEAN_CSV
        return client.post(
            "/api/upload",
            files={"file": ("data.csv", CLEAN_CSV.encode(), "text/csv")},
            headers={"X-Forwarded-For": ip},
        )

    def test_first_twenty_requests_succeed(self, client):
        ip = _fresh_ip()
        for _ in range(20):
            r = self._post_upload(client, ip)
            assert r.status_code == 200

    def test_twenty_first_request_is_rejected(self, client):
        ip = _fresh_ip()
        for _ in range(20):
            self._post_upload(client, ip)
        r = self._post_upload(client, ip)
        assert r.status_code == 429

    def test_upload_limit_independent_from_encode_limit(self, client, uploaded_file_id):
        # Rate limiter now uses per-endpoint keys (f"{ip}:{path_prefix}"),
        # so exhausting the upload bucket (20 req) does not consume encode capacity.
        ip = _fresh_ip()
        for _ in range(20):
            self._post_upload(client, ip)
        # Encode limit for the same IP is a separate bucket — should still succeed
        r = _post_encode(client, ip, uploaded_file_id)
        assert r.status_code == 200


# ──────────────────────────────────────────────────────────────────────────────
# GET endpoints are NOT rate-limited
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestGetRequestsNotRateLimited:
    """Read-only GET requests bypass the rate limiter."""

    def test_health_endpoint_never_rate_limited(self, client):
        ip = _fresh_ip()
        # Fire 100 GET requests — none should be 429
        for _ in range(100):
            r = client.get("/api/health", headers={"X-Forwarded-For": ip})
            assert r.status_code == 200

    def test_aai_indices_never_rate_limited(self, client):
        ip = _fresh_ip()
        for _ in range(30):
            r = client.get("/api/aai-indices", headers={"X-Forwarded-For": ip})
            assert r.status_code == 200

    def test_descriptors_never_rate_limited(self, client):
        ip = _fresh_ip()
        for _ in range(30):
            r = client.get("/api/descriptors", headers={"X-Forwarded-For": ip})
            assert r.status_code == 200

    def test_job_list_never_rate_limited(self, client):
        ip = _fresh_ip()
        for _ in range(30):
            r = client.get("/api/jobs", headers={"X-Forwarded-For": ip})
            assert r.status_code == 200


# ──────────────────────────────────────────────────────────────────────────────
# Rate limit state isolation
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestRateLimitStateIsolation:
    """Verify that the clean_rate_limits fixture provides per-test isolation."""

    def test_store_is_empty_at_test_start(self, client):
        # clean_rate_limits clears the dict before each test
        # This test ONLY checks; it does not make encode requests
        assert len(_RATE_LIMIT_STORE) == 0

    def test_store_populated_after_request(self, client, uploaded_file_id):
        ip = _fresh_ip()
        _post_encode(client, ip, uploaded_file_id)
        assert len(_RATE_LIMIT_STORE) > 0
