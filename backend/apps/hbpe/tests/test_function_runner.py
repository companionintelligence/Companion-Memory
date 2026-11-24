"""
HBPE's use of the shared function runner (ci.sidecar.runner).

The pool, the registry gate and the callback path are tested with the runner
itself (backend/packages/sidecar-core/tests/test_runner.py). What is tested
here is HBPE's own: that its registry matches the NestJS allowlist, and that a
run's token is what the GraphQL client presents, for that run only.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ci.hbpe.runner import FunctionRunner, RunRequest


async def _wait_for(predicate) -> None:
    # Deliberate poll: the condition is a side effect of the worker task, not
    # something that can signal an asyncio.Event without changing the runner.
    async with asyncio.timeout(5.0):
        while not predicate():  # noqa: ASYNC110
            await asyncio.sleep(0.01)


def _stop_workers(runner: FunctionRunner) -> None:
    for worker in runner._workers:
        worker.cancel()


def test_registry_names_match_the_nest_allowlist():
    from ci.hbpe.functions import FUNCTIONS

    # Must stay in sync with PYTHON_FUNCTIONS.hbpe in the NestJS
    # python-functions domain.
    assert sorted(FUNCTIONS) == ["bootstrap", "ensure_bootstrap", "nightly"]


@pytest.mark.asyncio
async def test_run_token_is_registered_for_graphql_then_cleared():
    """The run's token is what data_client's GraphQL calls present — for that run only."""
    from ci.hbpe import graphql_client

    seen: list[str | None] = []

    async def peek(**kwargs: Any) -> dict:
        seen.append(graphql_client._get_token(kwargs["user_id"]))
        return {"ok": True}

    # No job id, so no callback leaves the process.
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
