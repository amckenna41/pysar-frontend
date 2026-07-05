"""Tests for X-Forwarded-For hop handling in _get_client_ip (security fix #1)."""
import pytest

import backend.main as m

pytestmark = pytest.mark.unit


class _Req:
    def __init__(self, xff=None, peer="203.0.113.9"):
        self.headers = {"x-forwarded-for": xff} if xff else {}

        class _C:
            host = peer
        self.client = _C()


def test_no_proxy_uses_socket_peer(monkeypatch):
    monkeypatch.setattr(m, "_TRUST_PROXY_HOPS", 0)
    # Even with a spoofed header, direct exposure must ignore XFF entirely.
    assert m._get_client_ip(_Req(xff="1.1.1.1", peer="203.0.113.9")) == "203.0.113.9"


def test_one_hop_reads_rightmost_entry(monkeypatch):
    monkeypatch.setattr(m, "_TRUST_PROXY_HOPS", 1)
    # Client forges the left entries; the trusted proxy appends the real IP on the right.
    assert m._get_client_ip(_Req(xff="1.1.1.1, 2.2.2.2, 198.51.100.7")) == "198.51.100.7"


def test_spoofed_leftmost_is_ignored(monkeypatch):
    monkeypatch.setattr(m, "_TRUST_PROXY_HOPS", 1)
    real = m._get_client_ip(_Req(xff="evil-spoof, 198.51.100.7"))
    assert real == "198.51.100.7"  # not "evil-spoof"


def test_two_hops(monkeypatch):
    monkeypatch.setattr(m, "_TRUST_PROXY_HOPS", 2)
    assert m._get_client_ip(_Req(xff="1.1.1.1, 198.51.100.7, 10.0.0.1")) == "198.51.100.7"


def test_falls_back_when_fewer_hops_than_expected(monkeypatch):
    monkeypatch.setattr(m, "_TRUST_PROXY_HOPS", 2)
    # Only one XFF entry but two hops expected → fall back to the socket peer.
    assert m._get_client_ip(_Req(xff="1.1.1.1", peer="203.0.113.9")) == "203.0.113.9"


def test_hop_count_parsing():
    import os
    os.environ["TRUST_PROXY_HOPS"] = "3"
    try:
        assert m._trust_proxy_hops() == 3
    finally:
        del os.environ["TRUST_PROXY_HOPS"]
    os.environ["TRUST_PROXY"] = "true"
    try:
        assert m._trust_proxy_hops() == 1  # legacy flag → one hop
    finally:
        del os.environ["TRUST_PROXY"]
