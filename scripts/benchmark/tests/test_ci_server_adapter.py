"""CIServerAdapter — drives the real HTTP code path against a stubbed transport."""

from __future__ import annotations

import json
import urllib.error

import pytest
from benchmark.adapters.ci_server import CIServerAdapter


def _stub_transport():
    """Build a (post, get) pair plus a call log captured for assertions."""
    calls: list[dict] = []

    def post(url, body, headers, timeout):
        calls.append(
            {
                "method": "POST",
                "url": url,
                "headers": dict(headers),
                "body": json.loads(body),
            }
        )
        return b'{"block": "ok"}'

    def get(url, headers, timeout):
        calls.append({"method": "GET", "url": url, "headers": dict(headers)})
        return b'{"block": "profile"}'

    return calls, post, get


def _adapter(post, get):
    return CIServerAdapter(
        url="http://ci-server:8642", token="tok", http_post=post, http_get=get
    )


# ── transport contract ───────────────────────────────────────────────────────


def test_setup_requires_token():
    a = CIServerAdapter(url="http://x", token="")
    with pytest.raises(RuntimeError):
        a.setup("u1")


def test_ingest_posts_to_memory_write_with_x_api_key_and_session():
    calls, post, get = _stub_transport()
    a = _adapter(post, get)
    a.setup("u1")
    a.ingest("a fact", "s1")
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"].endswith("/api/memory/write")
    assert calls[0]["headers"]["x-api-key"] == "tok"
    assert calls[0]["headers"]["Content-Type"] == "application/json"
    assert calls[0]["body"]["sessionId"] == "s1"
    assert calls[0]["body"]["source"] == "benchmark"


def test_search_recall_extracts_block_text_or_context_fallback():
    payloads = iter([b'{"text": "T"}', b'{"context": "C"}', b"{}"])

    def post(url, body, headers, timeout):
        return next(payloads)

    def get(*a):
        return b"{}"

    a = _adapter(post, get)
    a.setup("u1")
    assert a.search("q1") == "T"
    assert a.search("q2") == "C"
    assert a.search("q3") == ""


def test_empty_query_falls_back_to_memory_context_get():
    calls, post, get = _stub_transport()
    a = _adapter(post, get)
    a.setup("u1")
    out = a.search("   ")
    assert out == "profile"
    assert calls[-1]["method"] == "GET"
    assert calls[-1]["url"].endswith("/api/memory/context")


# ── 404 fallback (matches the harness plugins) ───────────────────────────────


def test_ingest_falls_back_to_memory_note_on_404():
    seen: list[str] = []

    def post(url, body, headers, timeout):
        seen.append(url)
        if url.endswith("/api/memory/write"):
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
        return b"{}"

    def get(*a):
        return b"{}"

    a = _adapter(post, get)
    a.setup("u1")
    a.ingest("text", "s")
    assert seen[0].endswith("/api/memory/write")
    assert seen[1].endswith("/api/memory/note")


def test_ingest_propagates_non_404_errors():
    def post(url, body, headers, timeout):
        raise urllib.error.HTTPError(url, 500, "Server", None, None)

    a = _adapter(post, lambda *a: b"{}")
    a.setup("u1")
    with pytest.raises(urllib.error.HTTPError):
        a.ingest("text", "s")


# ── url normalization (matches the harness plugins) ──────────────────────────


def test_strips_trailing_slash_and_legacy_api_mcp_suffix():
    assert CIServerAdapter(url="http://x:1/", token="t")._base == "http://x:1"
    assert CIServerAdapter(url="http://x:1/api/mcp/", token="t")._base == "http://x:1"
    # but a legitimate sub-path is left alone
    assert (
        CIServerAdapter(url="http://x:1/api/memory", token="t")._base
        == "http://x:1/api/memory"
    )
