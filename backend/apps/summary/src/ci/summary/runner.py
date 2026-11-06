"""
The summary service's function runner: the shared pool (``ci.sidecar.runner``)
pointed at this service's API.

``POST /functions/run`` takes a name from ``ci.summary.functions.FUNCTIONS``.
"""

from __future__ import annotations

from ci.sidecar.runner import FunctionRunner as _FunctionRunner
from ci.sidecar.runner import Registry, RunRecord, RunRequest, build_router

from .config import settings
from .functions import FUNCTIONS

# Completed run records kept for GET /runs/{id} observability.
MAX_RUN_RECORDS = 500


class FunctionRunner(_FunctionRunner):
    def __init__(self, registry: Registry, concurrency: int) -> None:
        super().__init__(
            registry,
            concurrency,
            api_url=lambda: settings.api_url,
            max_run_records=MAX_RUN_RECORDS,
        )


runner = FunctionRunner(FUNCTIONS, settings.function_runner_concurrency)

router = build_router(runner)

__all__ = ["FunctionRunner", "RunRecord", "RunRequest", "router", "runner"]
