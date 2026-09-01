"""
The startup check that would have caught the outage.

summary-service used to boot clean against an endpoint that refused every
connection: no probe, no /health route, and `resolve_llm_model()` downgrading a
failed model listing to a warning. The only symptom was summaries, insights and
actions failing one job at a time, deep in the runner, where the error reads as
"that summary didn't work". Observed live 2026-08-30 with
`LLM_API_BASE=http://localhost:11434/v1` inside the container.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from ci.summary import llm_health


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code

    @property
    def is_error(self) -> bool:
        return self.status_code >= 400


def _answers(status_code: int):
    def _get(url, **kwargs):
        return _Response(status_code)

    return _get


def _refuses(url, **kwargs):
    raise httpx.ConnectError("[Errno 111] Connection refused")


# ── The probe ───────────────────────────────────────────────────────────────


def test_a_refused_connection_is_unreachable(monkeypatch):
    monkeypatch.setattr(llm_health.httpx, "get", _refuses)

    status = llm_health.probe_endpoint("http://localhost:11434/v1", "ollama")

    assert status.reachable is False
    assert "Connection refused" in status.detail


def test_an_http_error_counts_as_reachable(monkeypatch):
    """
    A 401/404 means a server answered. Matching HBPE's probe on purpose: calling
    a live endpoint dead over a missing /models route would be worse than the
    failure this exists to catch.
    """
    monkeypatch.setattr(llm_health.httpx, "get", _answers(404))

    assert llm_health.probe_endpoint("http://ollama:11434/v1", "k").reachable is True


def test_a_success_is_reachable(monkeypatch):
    monkeypatch.setattr(llm_health.httpx, "get", _answers(200))

    assert llm_health.probe_endpoint("http://ollama:11434/v1", "k").reachable is True


def test_the_probe_asks_the_models_route(monkeypatch):
    seen: list[str] = []

    def _get(url, **kwargs):
        seen.append(url)
        return _Response(200)

    monkeypatch.setattr(llm_health.httpx, "get", _get)
    llm_health.probe_endpoint("http://ollama:11434/v1/", "k")

    assert seen == ["http://ollama:11434/v1/models"]


def test_no_endpoint_configured_is_unreachable(monkeypatch):
    status = llm_health.probe_endpoint("", "k")

    assert status.reachable is False
    assert "LLM_API_BASE" in status.detail


# ── Loudness ────────────────────────────────────────────────────────────────


def test_an_unreachable_endpoint_is_logged_at_error(monkeypatch, caplog):
    """WARNING is not enough: nothing this service does works until it is fixed."""
    monkeypatch.setattr(llm_health.httpx, "get", _refuses)

    with caplog.at_level("ERROR"):
        status = llm_health.check_endpoint_at_startup()

    assert status.reachable is False
    assert "UNREACHABLE" in caplog.text
    assert any(record.levelname == "ERROR" for record in caplog.records)


def test_the_container_hint_names_the_gateway(monkeypatch, caplog):
    """The one line that would have saved the run."""
    monkeypatch.setattr(llm_health.httpx, "get", _refuses)
    monkeypatch.setattr(llm_health, "running_in_container", lambda: True)

    with caplog.at_level("ERROR"):
        llm_health.check_endpoint_at_startup()

    assert "host.docker.internal" in caplog.text
    assert "LLM_API_BASE" in caplog.text


def test_a_container_hint_matches_the_url_it_is_about(monkeypatch):
    """
    Don't explain localhost when the URL does not say localhost — a hint about
    the wrong thing sends the reader down the wrong path.
    """
    monkeypatch.setattr(llm_health.httpx, "get", _refuses)
    monkeypatch.setattr(llm_health, "running_in_container", lambda: True)

    loopback = llm_health.probe_endpoint("http://localhost:11434/v1", "k").detail
    routed = llm_health.probe_endpoint("http://host.docker.internal:9/v1", "k").detail

    assert "localhost is the container itself" in loopback
    assert "localhost is the container itself" not in routed
    assert "extra_hosts" in routed


def test_a_reachable_endpoint_does_not_shout(monkeypatch, caplog):
    monkeypatch.setattr(llm_health.httpx, "get", _answers(200))

    with caplog.at_level("INFO"):
        assert llm_health.check_endpoint_at_startup().reachable is True

    assert "UNREACHABLE" not in caplog.text


def test_startup_never_raises(monkeypatch):
    """A model that is down is a degraded service, not a crashed one."""

    def _explode(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(llm_health, "probe_endpoint", _explode)

    assert llm_health.check_endpoint_at_startup().reachable is False


# ── /health ─────────────────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    from ci.summary import api

    # The boot probe is exercised directly above; stub it here so building the
    # client does not reach the network before a test has said what it wants the
    # endpoint to do.
    monkeypatch.setattr(api, "check_endpoint_at_startup", lambda: None)

    with TestClient(api.app) as test_client:
        yield test_client


def test_health_reports_degraded_when_the_endpoint_is_down(monkeypatch, client):
    monkeypatch.setattr(llm_health.httpx, "get", _refuses)

    body = client.get("/health").json()

    assert body["status"] == "degraded"
    assert body["llm"]["reachable"] is False
    assert body["llm"]["url"]


def test_health_reports_ok_when_the_endpoint_answers(monkeypatch, client):
    monkeypatch.setattr(llm_health.httpx, "get", _answers(200))

    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert body["llm"]["reachable"] is True


def test_health_stays_200_either_way(monkeypatch, client):
    """
    Liveness, not readiness: the process is up and serving. A non-200 here would
    make any healthcheck added later restart-loop the container over a model
    outage it cannot fix.
    """
    monkeypatch.setattr(llm_health.httpx, "get", _refuses)

    assert client.get("/health").status_code == 200
