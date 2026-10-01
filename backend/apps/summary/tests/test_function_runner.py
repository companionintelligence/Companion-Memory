"""
Unit tests for the summary function runner (ci.summary.runner).

Covers the registry gate, the bounded worker pool, and completion-callback
delivery (including retries on transient failures). No real HTTP or database
access: the callback transport is a fake httpx and functions are local stubs.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest
from fastapi import HTTPException

from ci.summary import runner as runner_module
from ci.summary.runner import FunctionRunner, RunRequest


class _FakeResponse:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient; pops canned responses per POST."""

    responses: ClassVar[list[Any]] = []
    calls: ClassVar[list[dict[str, Any]]] = []

    def __init__(self, timeout: float | None = None) -> None:
        pass

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    async def post(self, url: str, json: Any = None, headers: Any = None) -> Any:
        _FakeAsyncClient.calls.append({"url": url, "json": json, "headers": headers})
        response = _FakeAsyncClient.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.fixture()
def fake_httpx(monkeypatch):
    _FakeAsyncClient.responses = []
    _FakeAsyncClient.calls = []
    monkeypatch.setattr(
        runner_module, "httpx", SimpleNamespace(AsyncClient=_FakeAsyncClient)
    )
    # No sleeping between retries in tests.
    monkeypatch.setattr(runner_module, "CALLBACK_RETRY_DELAYS", (0, 0))
    return _FakeAsyncClient


async def _wait_for(predicate) -> None:
    # Deliberate poll: the condition is a side effect of the worker task, not
    # something that can signal an asyncio.Event without changing the runner.
    async with asyncio.timeout(5.0):
        while not predicate():  # noqa: ASYNC110
            await asyncio.sleep(0.01)


def _stop_workers(runner: FunctionRunner) -> None:
    for worker in runner._workers:
        worker.cancel()


def test_submit_rejects_unknown_functions():
    runner = FunctionRunner({}, concurrency=1)

    with pytest.raises(HTTPException) as exc_info:
        runner.submit(RunRequest(function="nope"))

    assert exc_info.value.status_code == 400


def test_submit_returns_429_when_pool_is_full():
    async def noop(**_: Any) -> dict:
        return {}

    runner = FunctionRunner({"noop": noop}, concurrency=1)
    runner.queue = asyncio.Queue(maxsize=1)
    runner.queue.put_nowait("occupier")

    with pytest.raises(HTTPException) as exc_info:
        runner.submit(RunRequest(function="noop"))

    assert exc_info.value.status_code == 429


@pytest.mark.asyncio
async def test_run_completes_and_delivers_callback(fake_httpx, monkeypatch):
    monkeypatch.setattr(runner_module.settings, "api_url", "http://api:3030")
    fake_httpx.responses = [_FakeResponse(204)]

    async def echo(**kwargs: Any) -> dict:
        return {"echoed": kwargs["user_id"]}

    runner = FunctionRunner({"echo": echo}, concurrency=1)

    try:
        record = runner.submit(
            RunRequest(
                function="echo",
                args={"user_id": "user-1"},
                job_id="job-1",
                queue="py-fn-summary",
                access_token="run-token-from-the-api",
            )
        )

        await _wait_for(lambda: len(fake_httpx.calls) == 1)

        assert runner.runs[record.run_id].status == "completed"
        assert runner.runs[record.run_id].result == {"echoed": "user-1"}

        call = fake_httpx.calls[0]
        assert call["url"] == "http://api:3030/function-runs/callback"
        assert call["json"] == {
            "job_id": "job-1",
            "queue": "py-fn-summary",
            "status": "completed",
            "result": {"echoed": "user-1"},
        }

        # The callback presents the per-run token the API attached to the request —
        # echoed, never minted here: this service holds no signing secret any more.
        assert call["headers"] == {"Authorization": "Bearer run-token-from-the-api"}
        # And the record handed out by /runs/{id} never carries it.
        assert "access_token" not in runner.runs[record.run_id].model_dump()
    finally:
        _stop_workers(runner)


@pytest.mark.asyncio
async def test_failed_run_reports_failed_status(fake_httpx, monkeypatch):
    fake_httpx.responses = [_FakeResponse(204)]

    async def boom(**_: Any) -> dict:
        raise RuntimeError("kaput")

    runner = FunctionRunner({"boom": boom}, concurrency=1)

    try:
        record = runner.submit(
            RunRequest(function="boom", job_id="job-2", queue="py-fn-summary")
        )

        await _wait_for(lambda: len(fake_httpx.calls) == 1)

        assert runner.runs[record.run_id].status == "failed"
        body = fake_httpx.calls[0]["json"]
        assert body["status"] == "failed"
        assert "kaput" in body["error"]
    finally:
        _stop_workers(runner)


@pytest.mark.asyncio
async def test_callback_retries_transient_failures(fake_httpx, monkeypatch):
    fake_httpx.responses = [
        ConnectionError("api restarting"),
        _FakeResponse(500, "flake"),
        _FakeResponse(204),
    ]

    async def noop(**_: Any) -> dict:
        return {"ok": True}

    runner = FunctionRunner({"noop": noop}, concurrency=1)

    try:
        runner.submit(
            RunRequest(function="noop", job_id="job-3", queue="py-fn-summary")
        )

        await _wait_for(lambda: len(fake_httpx.calls) == 3)

        assert fake_httpx.responses == []  # all canned responses consumed
    finally:
        _stop_workers(runner)


@pytest.mark.asyncio
async def test_no_callback_without_job_id(fake_httpx):
    async def noop(**_: Any) -> dict:
        return {}

    runner = FunctionRunner({"noop": noop}, concurrency=1)

    try:
        record = runner.submit(RunRequest(function="noop"))

        await _wait_for(lambda: runner.runs[record.run_id].status == "completed")
        await asyncio.sleep(0.05)

        assert fake_httpx.calls == []
    finally:
        _stop_workers(runner)


def test_transport_errors_are_named_even_when_their_message_is_empty():
    """A connect timeout's str() is "" in both httpx and requests; the log read `error=` for hours."""
    from ci.summary.runner import callback_unreachable_hint, describe_transport_error

    class ConnectTimeout(Exception):
        pass

    assert describe_transport_error(ConnectTimeout()) == "ConnectTimeout"
    assert describe_transport_error(ValueError("bad body")) == "ValueError: bad body"

    # The dev stack: API on the host, this sidecar in a container, a firewall between them.
    hint = callback_unreachable_hint(
        "http://host.docker.internal:3030/function-runs/callback"
    )
    assert "ufw allow" in hint and "port 3030" in hint
    # A compose/Hub install reaches the API inside one network; no firewall advice there.
    assert "ufw" not in callback_unreachable_hint(
        "http://api:3030/function-runs/callback"
    )
