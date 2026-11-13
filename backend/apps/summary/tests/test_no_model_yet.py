"""
Memory on a Hub with no AI engine, or with an engine and no model pulled.

The service used to work out its model while being imported, so with nothing to
find it raised and never started: Memory couldn't reach Running. It now starts,
says so on /health and finds a model that appears later without a restart. The
API holds summary jobs in the queue meanwhile (SummaryServiceYieldGate), so a run
only gets here with no model in a race. That has to be a failed run the queue can
retry rather than a dead worker.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from ci.summary import activities, config, llm_config, llm_health
from ci.summary import summarizer as summarizer_module
from ci.summary.runner import FunctionRunner, RunRequest
from ci.summary.summarizer import Summarizer

BASE = "http://engine.test:11434/v1"
EMBEDDER_ONLY = [{"id": "nomic-embed-text"}]
A_CHAT_MODEL = [{"id": "nomic-embed-text"}, {"id": "small-chat:latest"}]


class _Endpoint:
    """What GET /models answers. `None` refuses the connection."""

    rows: list[dict[str, str]] | None = None
    status_code = 200
    listings = 0
    null_data = False

    def get(self, url: str, **_: Any) -> httpx.Response:
        self.listings += 1
        if self.null_data:
            # What Ollama answers with no models pulled.
            return httpx.Response(
                200,
                json={"object": "list", "data": None},
                request=httpx.Request("GET", url),
            )
        if self.rows is None:
            raise httpx.ConnectError("[Errno 111] Connection refused")
        return httpx.Response(
            self.status_code,
            json={"data": self.rows},
            request=httpx.Request("GET", url),
        )


def _forget_the_model() -> None:
    config.resolve_llm_model.cache_clear()
    llm_config.get_llm_config.cache_clear()
    summarizer_module.summarizer.dossier_agent = None


@pytest.fixture
def endpoint(monkeypatch) -> Iterator[_Endpoint]:
    """A service with no model configured, in front of an endpoint the test controls."""
    stub = _Endpoint()
    monkeypatch.setattr(httpx, "get", stub.get)
    monkeypatch.setattr(config.settings, "llm_model", "")
    monkeypatch.setattr(config.settings, "llm_api_base", BASE)
    monkeypatch.setattr(config, "_resolved_output_mode", None)
    _forget_the_model()
    yield stub
    _forget_the_model()


@pytest.fixture
def client(monkeypatch) -> Iterator[TestClient]:
    from ci.summary import api

    with TestClient(api.app) as test_client:
        yield test_client


# ── Starting ────────────────────────────────────────────────────────────────


def _import_the_service(llm_api_base: str) -> subprocess.CompletedProcess[str]:
    """What each uvicorn does first, in a process with no model configured."""
    unset = {"SUMMARY_LLM_MODEL", "LLM_DEFAULT_CHAT_MODEL", "LLM_MODEL"}
    env = {key: value for key, value in os.environ.items() if key not in unset}
    env.update(
        DATABASE_URL="postgresql://test:test@localhost:5432/test",
        LLM_API_BASE=llm_api_base,
        LLM_ENDPOINT_CONFIG_PATH="/nonexistent/llm-endpoint.json",
        CI_LLM_HOST_REWRITE="off",
    )
    return subprocess.run(
        [sys.executable, "-c", "import ci.summary.api, ci.summary.parser"],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_the_service_starts_when_the_endpoint_refuses_connections():
    """The ticket's case: a Hub with no AI engine."""
    result = _import_the_service("http://127.0.0.1:1/v1")

    assert result.returncode == 0, result.stderr


def test_the_service_starts_when_the_endpoint_serves_no_chat_model():
    """An engine with nothing pulled, or only the embedder."""

    class Models(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = json.dumps({"data": EMBEDDER_ONLY}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Models)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = _import_the_service(f"http://127.0.0.1:{server.server_port}/v1")
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    assert result.returncode == 0, result.stderr


def test_the_summarizer_only_needs_a_model_when_it_is_used(endpoint):
    summarizer = Summarizer()

    with pytest.raises(config.NoChatModelError):
        summarizer._get_dossier_agent()

    endpoint.rows = A_CHAT_MODEL

    assert summarizer._get_dossier_agent() is summarizer.dossier_agent
    assert summarizer.dossier_agent is not None


def test_startup_says_the_work_is_waiting_and_is_not_an_error(endpoint, caplog):
    """Nobody has done anything wrong yet, so this can't read as a failure."""
    with caplog.at_level("INFO"):
        status = llm_health.check_endpoint_at_startup()

    assert status.reachable is False
    assert "waiting" in caplog.text
    assert not [r for r in caplog.records if r.levelname == "ERROR"]


# ── A model showing up later ────────────────────────────────────────────────


def test_a_model_that_appears_later_is_found_without_a_restart(endpoint):
    with pytest.raises(config.NoChatModelError):
        config.resolve_llm_model()

    endpoint.rows = EMBEDDER_ONLY
    with pytest.raises(config.NoChatModelError):
        config.resolve_llm_model()

    endpoint.rows = A_CHAT_MODEL

    assert config.resolve_llm_model() == "small-chat:latest"
    assert llm_config.get_llm_config().model.model_name == "small-chat:latest"


def test_failing_to_find_a_model_settles_nothing_about_the_endpoint(endpoint):
    """Output mode is cached once decided. An empty listing can't decide it."""
    endpoint.rows = []

    with pytest.raises(config.NoChatModelError):
        llm_config.get_llm_config()

    assert config._resolved_output_mode is None


# ── /health ─────────────────────────────────────────────────────────────────


def test_health_says_when_this_process_started(endpoint, client):
    """The API's gate stops counting queue rows older than this as in flight."""
    from ci.summary import api

    before = api.STARTED_AT

    assert client.get("/health").json()["started_at"] == before
    assert datetime.fromisoformat(before).tzinfo is not None
    assert datetime.fromisoformat(before) <= datetime.now(UTC)


def test_health_says_no_model_when_the_endpoint_refuses(endpoint, client):
    response = client.get("/health")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "degraded"
    assert body["llm"]["reachable"] is False
    assert body["llm"]["model"] is None
    assert "waiting" in body["llm"]["detail"]


def test_health_is_degraded_when_a_reachable_endpoint_has_no_chat_model(
    endpoint, client
):
    """It used to answer `ok` here, with every job about to fail."""
    endpoint.rows = EMBEDDER_ONLY

    response = client.get("/health")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "degraded"
    assert body["llm"]["reachable"] is True
    assert body["llm"]["model"] is None


def test_health_names_the_model_once_there_is_one(endpoint, client):
    assert client.get("/health").json()["llm"]["model"] is None

    endpoint.rows = A_CHAT_MODEL
    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert body["llm"]["model"] == "small-chat:latest"
    assert "waiting" not in body["llm"]["detail"]


def test_health_waits_again_when_the_engine_behind_a_discovered_model_stops(
    endpoint, client
):
    endpoint.rows = A_CHAT_MODEL
    assert client.get("/health").json()["llm"]["model"] == "small-chat:latest"

    endpoint.rows = None
    assert client.get("/health").json()["llm"]["model"] is None

    endpoint.rows = A_CHAT_MODEL
    assert client.get("/health").json()["llm"]["model"] == "small-chat:latest"


def test_a_configured_model_waits_while_the_endpoint_is_down(
    endpoint, client, monkeypatch
):
    """
    A configured model used to be named here whatever the endpoint said, so the
    API's gate stayed open and every summary job timed out against an endpoint
    that was not there, spending its retries.
    """
    monkeypatch.setattr(config.settings, "llm_model", "configured:model")

    body = client.get("/health").json()

    assert body["status"] == "degraded"
    assert body["llm"]["reachable"] is False
    assert body["llm"]["model"] is None
    assert "waiting" in body["llm"]["detail"]
    with pytest.raises(config.NoChatModelError):
        config.resolve_llm_model()


def test_a_configured_model_that_goes_away_is_waited_for_and_found_again(
    endpoint, client, monkeypatch
):
    """
    The failure seen on Memory Desktop: the model was served, remembered, then
    removed while the server kept answering. /health went on naming it and the
    hourly job failed with "model not found" and retried.
    """
    monkeypatch.setattr(config.settings, "llm_model", "gemma4:e4b")
    with_model = [{"id": "nomic-embed-text"}, {"id": "gemma4:e4b"}]
    endpoint.rows = with_model
    assert llm_config.get_llm_config().model.model_name == "gemma4:e4b"

    endpoint.rows = EMBEDDER_ONLY
    body = client.get("/health").json()

    assert body["llm"]["reachable"] is True
    assert body["llm"]["model"] is None
    assert "waiting" in body["llm"]["detail"]
    with pytest.raises(config.NoChatModelError):
        llm_config.get_llm_config()

    endpoint.rows = with_model

    assert client.get("/health").json()["llm"]["model"] == "gemma4:e4b"
    assert llm_config.get_llm_config().model.model_name == "gemma4:e4b"


def test_a_remembered_model_is_waited_for_while_its_endpoint_is_down(
    endpoint, client, monkeypatch
):
    monkeypatch.setattr(config.settings, "llm_model", "gemma4:e4b")
    endpoint.rows = [{"id": "gemma4:e4b"}]
    assert config.resolve_llm_model() == "gemma4:e4b"

    endpoint.rows = None
    assert client.get("/health").json()["llm"]["model"] is None
    with pytest.raises(config.NoChatModelError):
        config.resolve_llm_model()

    endpoint.rows = [{"id": "gemma4:e4b"}]
    assert client.get("/health").json()["llm"]["model"] == "gemma4:e4b"


def test_a_server_that_refuses_the_model_list_does_not_stop_a_configured_model(
    endpoint, client, monkeypatch
):
    """
    A 401 or 404 on /models is a server answering: the probe counts it reachable,
    and nothing in it says the configured model is gone.
    """
    monkeypatch.setattr(config.settings, "llm_model", "configured:model")

    def guarded(url: str, **_: Any) -> httpx.Response:
        return httpx.Response(401, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", guarded)

    body = client.get("/health").json()

    assert body["llm"]["reachable"] is True
    assert body["llm"]["model"] == "configured:model"


def test_a_configured_model_waits_while_the_hub_pool_has_no_engine_behind_it(
    endpoint, client, monkeypatch
):
    """
    CI-Hub's pool answers 502 on /models when the engine behind it is down, and
    502 again on every chat request. That is no model to run on, not a server
    guarding its list.
    """
    monkeypatch.setattr(config.settings, "llm_model", "gemma4:e4b")
    endpoint.rows = [{"id": "gemma4:e4b"}]
    assert client.get("/health").json()["llm"]["model"] == "gemma4:e4b"

    endpoint.status_code = 502
    body = client.get("/health").json()

    assert body["llm"]["reachable"] is True
    assert body["llm"]["model"] is None
    with pytest.raises(config.NoChatModelError):
        config.resolve_llm_model()

    endpoint.status_code = 200
    assert client.get("/health").json()["llm"]["model"] == "gemma4:e4b"


def test_the_configured_model_takes_over_from_its_stand_in_when_it_is_back(
    endpoint, client, monkeypatch
):
    monkeypatch.setattr(config.settings, "llm_model", "gemma4:e4b")
    endpoint.rows = A_CHAT_MODEL
    assert client.get("/health").json()["llm"]["model"] == "small-chat:latest"

    endpoint.rows = [*A_CHAT_MODEL, {"id": "gemma4:e4b"}]

    assert client.get("/health").json()["llm"]["model"] == "gemma4:e4b"
    assert llm_config.get_llm_config().model.model_name == "gemma4:e4b"


def test_the_dossier_agent_moves_to_the_model_that_replaced_a_gone_one(
    endpoint, client, monkeypatch
):
    """It is built once per process, so it kept asking for the model that went."""
    monkeypatch.setattr(config.settings, "llm_model", "gemma4:e4b")
    endpoint.rows = [{"id": "gemma4:e4b"}]
    summarizer = summarizer_module.summarizer
    assert summarizer._get_dossier_agent().model.model_name == "gemma4:e4b"

    endpoint.rows = A_CHAT_MODEL
    assert client.get("/health").json()["llm"]["model"] == "small-chat:latest"

    assert summarizer._get_dossier_agent().model.model_name == "small-chat:latest"


def test_a_configured_model_waits_while_ollama_has_no_models_at_all(
    endpoint, client, monkeypatch
):
    """
    Ollama with nothing pulled lists `"data": null`, not an empty list. Read as
    a malformed answer, that kept the configured model and every run then got
    a 404 for it.
    """
    monkeypatch.setattr(config.settings, "llm_model", "gemma4:e4b")
    endpoint.rows = [{"id": "gemma4:e4b"}]
    assert client.get("/health").json()["llm"]["model"] == "gemma4:e4b"

    endpoint.null_data = True
    body = client.get("/health").json()

    assert body["llm"]["reachable"] is True
    assert body["llm"]["model"] is None
    with pytest.raises(config.NoChatModelError):
        config.resolve_llm_model()


def test_health_lists_the_models_once_while_the_model_holds(endpoint, client):
    """The probe's listing is the one the remembered model is checked against."""
    endpoint.rows = A_CHAT_MODEL
    assert client.get("/health").json()["llm"]["model"] == "small-chat:latest"

    endpoint.listings = 0
    assert client.get("/health").json()["llm"]["model"] == "small-chat:latest"

    assert endpoint.listings == 1


# ── A run that gets here anyway ─────────────────────────────────────────────


@pytest.mark.parametrize(
    ("generate", "args"),
    [
        (activities.generate_hourly_summary_activity, ({},)),
        (activities.generate_rollup_summary_activity, ("daily", [])),
        (activities.generate_single_insight_activity, ({}, [])),
        (activities.generate_actions_activity, ({},)),
    ],
    ids=["hourly", "rollup", "insight", "actions"],
)
@pytest.mark.asyncio
async def test_generating_without_a_model_says_why(endpoint, generate, args):
    with pytest.raises(config.NoChatModelError):
        await generate(*args)


@pytest.mark.asyncio
async def test_a_run_without_a_model_fails_and_leaves_the_worker_alive(
    endpoint, monkeypatch
):
    async def needs_a_model(**_: Any) -> dict[str, str]:
        return {"model": llm_config.get_llm_config().model.model_name}

    async def no_callback(*_: Any, **__: Any) -> None:
        return None

    runner = FunctionRunner({"needs_a_model": needs_a_model}, concurrency=1)
    monkeypatch.setattr(runner, "_deliver_callback", no_callback)

    try:
        first = runner.submit(RunRequest(function="needs_a_model"))
        await runner.queue.join()

        assert runner.runs[first.run_id].status == "failed"
        assert "NoChatModelError" in (runner.runs[first.run_id].error or "")

        endpoint.rows = A_CHAT_MODEL
        second = runner.submit(RunRequest(function="needs_a_model"))
        await runner.queue.join()

        assert runner.runs[second.run_id].status == "completed"
        assert runner.runs[second.run_id].result == {"model": "small-chat:latest"}
    finally:
        for worker in runner._workers:
            worker.cancel()
