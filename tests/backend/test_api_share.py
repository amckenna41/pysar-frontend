"""Tests for shareable read-only results and the completion-webhook SSRF guard (feature 10)."""
import uuid

import pytest

from backend.main import JOBS, _SHARE_TOKENS, _webhook_target_is_safe

pytestmark = pytest.mark.unit


class TestShareLinks:
    def test_owner_can_mint_and_anyone_can_read(self, client, completed_job):
        r = client.post(f"/api/jobs/{completed_job}/share")
        assert r.status_code == 200
        token = r.json()["share_token"]
        # No session header — a shared link works without the owning session.
        anon = client.get(f"/api/share/{token}", headers={"X-Session-Id": str(uuid.uuid4())})
        assert anon.status_code == 200
        body = anon.json()
        assert body["job_id"] == completed_job
        assert "results" in body
        # Owner identifiers are stripped from the shared payload.
        assert "session_id" not in body and "ip" not in body

    def test_mint_is_idempotent(self, client, completed_job):
        t1 = client.post(f"/api/jobs/{completed_job}/share").json()["share_token"]
        t2 = client.post(f"/api/jobs/{completed_job}/share").json()["share_token"]
        assert t1 == t2

    def test_unknown_token_404(self, client):
        assert client.get("/api/share/deadbeef").status_code == 404

    def test_foreign_session_cannot_mint(self, client, completed_job):
        r = client.post(f"/api/jobs/{completed_job}/share", headers={"X-Session-Id": str(uuid.uuid4())})
        assert r.status_code == 404


class TestWebhookSSRFGuard:
    def test_blocks_loopback(self):
        assert _webhook_target_is_safe("http://127.0.0.1/hook") is False
        assert _webhook_target_is_safe("http://localhost/hook") is False

    def test_blocks_private_ranges(self):
        assert _webhook_target_is_safe("http://10.0.0.5/x") is False
        assert _webhook_target_is_safe("http://192.168.1.1/x") is False
        assert _webhook_target_is_safe("http://169.254.169.254/latest/meta-data") is False

    def test_allows_public_host(self):
        # A well-known public IP literal should pass the guard.
        assert _webhook_target_is_safe("https://8.8.8.8/hook") is True

    def test_rejects_webhook_field_non_http(self, client, uploaded_file_id):
        from tests.backend.conftest import make_encode_payload
        payload = make_encode_payload(uploaded_file_id)
        payload["notify_webhook"] = "ftp://evil/x"
        assert client.post("/api/encode", json=payload).status_code == 422
