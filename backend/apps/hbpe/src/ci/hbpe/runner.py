"""
HBPE's function runner: the shared pool (``ci.sidecar.runner``) pointed at this
service's API, with the one thing a run needs around it here — the per-run token
registered for ``graphql_client`` while the function runs, and cleared after.

``POST /functions/run`` takes a name from ``ci.hbpe.functions.FUNCTIONS``.
"""

from __future__ import annotations

from typing import Any

from ci.hbpe import graphql_client
from ci.hbpe.config import settings
from ci.hbpe.functions import FUNCTIONS
from ci.sidecar.runner import FunctionRunner as _FunctionRunner
from ci.sidecar.runner import Registry, RunRecord, RunRequest, build_router

# Completed run records kept for GET /runs/{id} observability.
MAX_RUN_RECORDS = 200


class FunctionRunner(_FunctionRunner):
    def __init__(self, registry: Registry, concurrency: int) -> None:
        super().__init__(
            registry,
            concurrency,
            api_url=lambda: settings.api_url,
            max_run_records=MAX_RUN_RECORDS,
        )

    def run_started(self, args: dict[str, Any], token: str | None) -> None:
        user_id = str(args.get("user_id", ""))
        if token and user_id:
            # The run's credential for anything it asks the API (see graphql_client).
            graphql_client.register_token(user_id, token)

    def run_finished(self, args: dict[str, Any]) -> None:
        user_id = str(args.get("user_id", ""))
        if user_id:
            graphql_client.clear_token(user_id)


runner = FunctionRunner(FUNCTIONS, settings.function_runner_concurrency)

router = build_router(runner)

__all__ = ["FunctionRunner", "RunRecord", "RunRequest", "router", "runner"]
