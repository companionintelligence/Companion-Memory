"""
Generic background function runner for the summary service.

``POST /functions/run`` accepts a named function from the registry
(ci.summary.functions.FUNCTIONS), enqueues it into a bounded asyncio worker
pool, and returns immediately. When the run finishes, the runner POSTs a
completion callback to the main API (``{api_url}/function-runs/callback``),
authenticated with a self-signed service JWT — that callback completes or fails
the pg-boss job the NestJS dispatcher left ``active``. If the callback is
undeliverable the job recovers via pg-boss queue expiration, so callback
delivery is best-effort-with-retries, never silently dropped.
"""

import asyncio
import time
import traceback
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

import httpx
import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .config import settings
from .functions import FUNCTIONS

logger = structlog.get_logger()

# Callback retry schedule (seconds between attempts).
CALLBACK_RETRY_DELAYS = (1, 5, 15, 60)

# Completed run records kept for GET /runs/{id} observability.
MAX_RUN_RECORDS = 500


class RunRequest(BaseModel):
    function: str = Field(description="Registry name of the function to run")
    args: dict[str, Any] = Field(default_factory=dict, description="Keyword arguments")
    job_id: str | None = Field(
        default=None, description="pg-boss job id — completion is reported back for it"
    )
    queue: str | None = Field(default=None, description="pg-boss queue holding job_id")
    access_token: str | None = Field(
        default=None,
        repr=False,
        description=(
            "Per-run API token the dispatcher issued for this job's user; presented on "
            "the completion callback. Never stored on the run record."
        ),
    )


class RunRecord(BaseModel):
    run_id: str
    function: str
    status: str  # queued | running | completed | failed
    job_id: str | None = None
    queue: str | None = None
    queued_at: float
    started_at: float | None = None
    finished_at: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


class FunctionRunner:
    """Bounded asyncio worker pool with per-run records and API callbacks."""

    def __init__(
        self,
        registry: dict[str, Callable[..., Awaitable[dict[str, Any]]]],
        concurrency: int,
    ) -> None:
        self.registry = registry
        self.concurrency = max(1, concurrency)
        # Bounded so a scheduler bug cannot queue unbounded work; the NestJS
        # dispatcher treats a 429 as a retriable dispatch failure.
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self.concurrency * 32)
        self.runs: OrderedDict[str, RunRecord] = OrderedDict()
        self._workers: list[asyncio.Task] = []
        # Args are held out of RunRecord so GET /runs never leaks payloads.
        self._pending_args: dict[str, dict[str, Any]] = {}
        self._pending_tokens: dict[str, str | None] = {}

    def _ensure_workers(self) -> None:
        # Lazy start on the running loop (uvicorn's), so the runner needs no
        # lifespan hook and stays trivially testable.
        alive = [w for w in self._workers if not w.done()]
        missing = self.concurrency - len(alive)
        for _ in range(missing):
            alive.append(asyncio.create_task(self._worker()))
        self._workers = alive

    def submit(self, request: RunRequest) -> RunRecord:
        if request.function not in self.registry:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown function '{request.function}'. "
                f"Known: {sorted(self.registry)}",
            )

        record = RunRecord(
            run_id=str(uuid.uuid4()),
            function=request.function,
            status="queued",
            job_id=request.job_id,
            queue=request.queue,
            queued_at=time.time(),
        )

        try:
            self.queue.put_nowait(record.run_id)
        except asyncio.QueueFull as exc:
            raise HTTPException(
                status_code=429, detail="Function runner queue is full; retry later"
            ) from exc

        self._remember(record)
        self._pending_args[record.run_id] = request.args
        self._pending_tokens[record.run_id] = request.access_token
        self._ensure_workers()

        logger.info(
            "function_run_queued",
            run_id=record.run_id,
            function=record.function,
            job_id=record.job_id,
        )

        return record

    def _remember(self, record: RunRecord) -> None:
        self.runs[record.run_id] = record
        while len(self.runs) > MAX_RUN_RECORDS:
            self.runs.popitem(last=False)

    async def _worker(self) -> None:
        while True:
            run_id = await self.queue.get()
            record = self.runs.get(run_id)
            args = self._pending_args.pop(run_id, {})
            token = self._pending_tokens.pop(run_id, None)

            if record is None:  # evicted before it ran — should not happen
                self.queue.task_done()
                continue

            record.status = "running"
            record.started_at = time.time()

            try:
                result = await self.registry[record.function](**args)
                record.status = "completed"
                record.result = (
                    result if isinstance(result, dict) else {"value": result}
                )
                logger.info(
                    "function_run_completed",
                    run_id=run_id,
                    function=record.function,
                    duration_s=round(time.time() - record.started_at, 1),
                )
            except Exception as exc:
                record.status = "failed"
                record.error = f"{type(exc).__name__}: {exc}"
                logger.error(
                    "function_run_failed",
                    run_id=run_id,
                    function=record.function,
                    error=str(exc),
                    traceback=traceback.format_exc(),
                )
            finally:
                record.finished_at = time.time()
                self.queue.task_done()

            if record.job_id and record.queue:
                await self._deliver_callback(record, token=token)

    async def _deliver_callback(self, record: RunRecord, token: str | None) -> None:
        url = f"{settings.api_url.rstrip('/')}/function-runs/callback"
        body: dict[str, Any] = {
            "job_id": record.job_id,
            "queue": record.queue,
            "status": record.status,
        }
        if record.status == "completed":
            body["result"] = record.result
        else:
            body["error"] = record.error

        for attempt, delay in enumerate((0, *CALLBACK_RETRY_DELAYS)):
            if delay:
                await asyncio.sleep(delay)
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    response = await client.post(
                        url, json=body, headers=self._auth_headers(token)
                    )
                if response.status_code < 300:
                    logger.info(
                        "function_run_callback_delivered",
                        run_id=record.run_id,
                        job_id=record.job_id,
                        status=record.status,
                    )
                    return
                logger.warning(
                    "function_run_callback_rejected",
                    run_id=record.run_id,
                    attempt=attempt,
                    http_status=response.status_code,
                    body=response.text[:300],
                )
            except Exception as exc:
                logger.warning(
                    "function_run_callback_error",
                    run_id=record.run_id,
                    attempt=attempt,
                    url=url,
                    error=describe_transport_error(exc),
                )

        # Loud on purpose: the pg-boss job now recovers only via queue
        # expiration, which re-runs the whole function.
        logger.error(
            "function_run_callback_undeliverable",
            run_id=record.run_id,
            job_id=record.job_id,
            queue=record.queue,
            url=url,
            hint=callback_unreachable_hint(url),
        )

    def _auth_headers(self, token: str | None) -> dict[str, str]:
        """The per-run token the API issued, echoed back. Nothing is signed here."""
        if not token:
            logger.warning("run_token_missing_callback_will_be_unauthenticated")
            return {}
        return {"Authorization": f"Bearer {token}"}


runner = FunctionRunner(FUNCTIONS, settings.function_runner_concurrency)

router = APIRouter()


@router.post("/functions/run", status_code=202)
async def run_function(request: RunRequest) -> dict[str, Any]:
    """Accept a named function run into the worker pool (returns immediately)."""
    record = runner.submit(request)

    return {
        "run_id": record.run_id,
        "status": record.status,
        "function": record.function,
    }


@router.get("/runs/{run_id}")
async def get_run(run_id: str) -> RunRecord:
    record = runner.runs.get(run_id)

    if record is None:
        raise HTTPException(status_code=404, detail="Unknown run id")

    return record


@router.get("/functions")
async def list_functions() -> dict[str, Any]:
    return {"functions": sorted(FUNCTIONS), "concurrency": runner.concurrency}


__all__ = ["FunctionRunner", "RunRequest", "router", "runner"]


def describe_transport_error(exc: BaseException) -> str:
    """
    `str(exc)` for a connect timeout is the empty string in both httpx and requests, so the
    callback log read `error=` and said nothing for hours (2026-09-30: every callback to the dev
    stack's API was dropped by the host firewall). The exception's type is the message then.
    """
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def callback_unreachable_hint(url: str) -> str:
    """
    What an operator can do about a callback URL that never answers. Only the dev stack has
    the API on the host and this sidecar in a container (`make dev`); a Hub or compose install
    reaches it as `http://api:3030` inside one network, where no firewall sits in the way.
    """
    host = urlsplit(url).hostname or ""
    port = urlsplit(url).port or 80
    if host in {"host.docker.internal", "gateway.docker.internal"} or host.endswith(
        ".internal"
    ):
        return (
            f"The API runs on the host; allow this container's network to reach it, e.g. "
            f"`sudo ufw allow from 172.16.0.0/12 to any port {port} proto tcp`."
        )
    return "Check that the API is up and that API_URL names an address this container can reach."
