"""
Unit tests for the HBPE function runner (ci.hbpe.runner).

The HBPE runner shares the summary runner's pool/registry semantics but
delivers callbacks through requests (in a thread) instead of httpx. These
tests pin the registry gate and the callback retry path on that transport.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import HTTPException

from ci.hbpe import runner as runner_module
from ci.hbpe.runner import FunctionRunner, RunRequest


class _FakeResponse:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


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


def test_registry_names_match_the_nest_allowlist():
    from ci.hbpe.functions import FUNCTIONS

    # Must stay in sync with PYTHON_FUNCTIONS.hbpe in the NestJS
    # python-functions domain.
    assert sorted(FUNCTIONS) == ["bootstrap", "ensure_bootstrap", "nightly"]


@pytest.mark.asyncio
async def test_callback_retries_then_delivers(monkeypatch):
    calls: list[dict[str, Any]] = []
    responses: list[Any] = [_FakeResponse(503, "starting"), _FakeResponse(204)]

    def fake_post(url: str, json: Any = None, headers: Any = None, timeout: Any = None):
        calls.append({"url": url, "json": json, "headers": headers})
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(runner_module.requests, "post", fake_post)
    monkeypatch.setattr(runner_module, "CALLBACK_RETRY_DELAYS", (0,))
    monkeypatch.setattr(runner_module.settings, "api_url", "http://api:3030")

    async def noop(**_: Any) -> dict:
        return {"ok": True}

    runner = FunctionRunner({"noop": noop}, concurrency=1)

    try:
        runner.submit(
            RunRequest(
                function="noop",
                args={"user_id": "user-1"},
                job_id="job-1",
                queue="py-fn-hbpe",
                access_token="run-token-from-the-api",
            )
        )

        await _wait_for(lambda: len(calls) == 2)

        assert calls[-1]["url"] == "http://api:3030/function-runs/callback"
        assert calls[-1]["json"]["status"] == "completed"
        assert calls[-1]["json"]["job_id"] == "job-1"
        # The callback presents the per-run token the API attached to the request —
        # echoed, never minted here: this service holds no signing secret any more.
        assert calls[-1]["headers"] == {
            "Authorization": "Bearer run-token-from-the-api"
        }
    finally:
        _stop_workers(runner)


@pytest.mark.asyncio
async def test_run_token_is_registered_for_graphql_then_cleared(monkeypatch):
    """The run's token is what data_client's GraphQL calls present — for that run only."""
    from ci.hbpe import graphql_client

    seen: list[str | None] = []

    async def peek(**kwargs: Any) -> dict:
        seen.append(graphql_client._get_token(kwargs["user_id"]))
        return {"ok": True}

    monkeypatch.setattr(
        runner_module.requests, "post", lambda *a, **k: _FakeResponse(204)
    )
    monkeypatch.setattr(runner_module, "CALLBACK_RETRY_DELAYS", (0,))
    runner = FunctionRunner({"peek": peek}, concurrency=1)
    try:
        record = runner.submit(
            RunRequest(
                function="peek", args={"user_id": "user-9"}, access_token="tok-9"
            )
        )
        await _wait_for(lambda: runner.runs[record.run_id].status == "completed")
        assert seen == ["tok-9"]
        # Gone once the run ends: nothing lingers for a later, unrelated request to reuse.
        with pytest.raises(graphql_client.GraphQLUnavailable):
            graphql_client._get_token("user-9")
        # And the record handed out by /runs/{id} never carries it.
        assert "access_token" not in runner.runs[record.run_id].model_dump()
    finally:
        _stop_workers(runner)


def test_no_token_means_no_graphql():
    from ci.hbpe import graphql_client

    with pytest.raises(graphql_client.GraphQLUnavailable):
        graphql_client._get_token("nobody")
