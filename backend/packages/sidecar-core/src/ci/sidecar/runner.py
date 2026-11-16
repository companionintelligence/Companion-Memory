"""
Generic background function runner shared by the sidecars.

``POST /functions/run`` accepts a named function from the service's registry,
enqueues it into a bounded asyncio worker pool, and returns immediately. When
the run finishes, the runner POSTs a completion callback to the main API
(``{api_url}/function-runs/callback``), presenting the per-run token the
dispatcher issued. That callback completes or fails the pg-boss job the NestJS
dispatcher left ``active``. If the callback is undeliverable the job recovers
via pg-boss queue expiration, so delivery is best-effort-with-retries, never
silently dropped.

When the request asks for it (``heartbeat_seconds``), the runner also tells the
API every so often that it still holds the run, queued or running
(``{api_url}/function-runs/heartbeat``). On a queue that expects those beats the
API lets a job go within minutes once they stop, when this service died with
the run, instead of at the queue's expiry hours later.

A service subclasses :class:`FunctionRunner` with where its API is and, if it
has any, what a run needs around it (HBPE registers the run's token for its
GraphQL client), then mounts :func:`build_router` on its app.
"""

from __future__ import annotations

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

logger = structlog.get_logger()

# Callback retry schedule (seconds between attempts).
CALLBACK_RETRY_DELAYS: tuple[int, ...] = (1, 5, 15, 60)

# Completed run records kept for GET /runs/{id} observability, unless the
# service says otherwise.
DEFAULT_MAX_RUN_RECORDS = 200

Registry = dict[str, Callable[..., Awaitable[dict[str, Any]]]]


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
            "Per-run API token the dispatcher issued for this job's user. Presented on "
            "the completion callback and on any API call the function makes; never "
            "stored on the run record, so /runs/{id} cannot leak it."
        ),
    )
    heartbeat_seconds: float | None = Field(
        default=None,
        gt=0,
        description=(
            "Seconds between heartbeats for job_id while this service holds the run, "
            "queued or running. The API asks for them on a queue that fails a job "
            "whose heartbeat stops, so a run lost with this service is let go soon."
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
        registry: Registry,
        concurrency: int,
        *,
        api_url: Callable[[], str],
        max_run_records: int = DEFAULT_MAX_RUN_RECORDS,
    ) -> None:
        self.registry = registry
        self.concurrency = max(1, concurrency)
        # Read per callback, not once: a setting a test (or a reload) changes is honoured.
        self._api_url = api_url
        self.max_run_records = max_run_records
        # Bounded so a scheduler bug cannot queue unbounded work; the NestJS
        # dispatcher treats a 429 as a retriable dispatch failure.
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self.concurrency * 32)
        self.runs: OrderedDict[str, RunRecord] = OrderedDict()
        self._workers: list[asyncio.Task[None]] = []
        # Args are held out of RunRecord so GET /runs never leaks payloads.
        self._pending_args: dict[str, dict[str, Any]] = {}
        # Each held run's token, kept until its callback has been attempted: a
        # retry that joins the run brings a newer one for the callback.
        self._tokens: dict[str, str | None] = {}
        # (queue, job_id) -> run_id for every job this runner holds, from submit
        # until its callback has been attempted; and each held run's heartbeat.
        self._held_jobs: dict[tuple[str, str], str] = {}
        self._heartbeats: dict[str, asyncio.Task[None]] = {}

    def run_started(self, args: dict[str, Any], token: str | None) -> None:
        """Hook: on the worker, just before the function runs. Nothing by default."""

    def run_finished(self, args: dict[str, Any]) -> None:
        """Hook: after the function returned or raised, before the callback. Nothing by default."""

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

        held = self._held_run(request)
        if held is not None:
            # pg-boss retries a job under the same id. One whose heartbeats
            # stopped reaching the API while this service still had it (the API
            # was down for a while) comes back here: the run already going
            # answers for it, rather than a second copy queued behind it.
            logger.info(
                "function_run_already_held",
                run_id=held.run_id,
                function=held.function,
                job_id=held.job_id,
            )
            self._rejoin(held, request)
            # A run still queued here needs a live worker. If one died since, the
            # run would beat with nothing running until some other job's submit
            # restarted the pool.
            self._ensure_workers()
            return held

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
        self._tokens[record.run_id] = request.access_token
        if request.job_id and request.queue:
            self._held_jobs[(request.queue, request.job_id)] = record.run_id
            if request.heartbeat_seconds and request.access_token:
                self._start_heartbeat(
                    record, request.access_token, request.heartbeat_seconds
                )
        self._ensure_workers()

        logger.info(
            "function_run_queued",
            run_id=record.run_id,
            function=record.function,
            job_id=record.job_id,
        )

        return record

    def _held_run(self, request: RunRequest) -> RunRecord | None:
        """The run already holding this request's job, if this runner has one."""
        if not (request.job_id and request.queue):
            return None
        run_id = self._held_jobs.get((request.queue, request.job_id))
        return self.runs.get(run_id) if run_id is not None else None

    def _rejoin(self, record: RunRecord, request: RunRequest) -> None:
        """A retry of the held job: carry the run on with the retry's token.

        The retry's token is newer, so it outlives the first one. Its job's
        expiry restarted when pg-boss fetched it again. If the retry asks for
        heartbeats, the run beats with that token from now on, even when the
        request that started it did not ask.
        """
        if not request.access_token:
            return
        self._tokens[record.run_id] = request.access_token
        if request.heartbeat_seconds:
            self._start_heartbeat(
                record, request.access_token, request.heartbeat_seconds
            )

    def _start_heartbeat(self, record: RunRecord, token: str, every: float) -> None:
        previous = self._heartbeats.pop(record.run_id, None)
        if previous is not None:
            previous.cancel()
        self._heartbeats[record.run_id] = asyncio.create_task(
            self._heartbeat(record, token, every)
        )

    def _release(self, run_id: str) -> None:
        """Stop the run's heartbeat, drop its token and let its job id be run again."""
        heartbeat = self._heartbeats.pop(run_id, None)
        if heartbeat is not None:
            heartbeat.cancel()
        self._tokens.pop(run_id, None)
        for key in [key for key, held in self._held_jobs.items() if held == run_id]:
            del self._held_jobs[key]

    def _remember(self, record: RunRecord) -> None:
        self.runs[record.run_id] = record
        while len(self.runs) > self.max_run_records:
            self.runs.popitem(last=False)

    async def _worker(self) -> None:
        while True:
            run_id = await self.queue.get()
            record = self.runs.get(run_id)
            args = self._pending_args.pop(run_id, {})
            token = self._tokens.get(run_id)

            if record is None:  # evicted before it ran — should not happen
                self._release(run_id)
                self.queue.task_done()
                continue

            record.status = "running"
            record.started_at = time.time()

            # Released whatever happens from here, a hook that raises included:
            # a heartbeat left going would keep the job alive with nothing running.
            # Nor may a hook end this worker. A dead worker strands every run
            # queued behind it, each still beating for its job.
            try:
                try:
                    # A start hook that raises fails the run like the function
                    # would, so its job is failed and retried now.
                    self.run_started(args, token)
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

                try:
                    self.run_finished(args)
                except Exception as exc:
                    logger.error(
                        "function_run_finished_hook_failed",
                        run_id=run_id,
                        function=record.function,
                        error=str(exc),
                        traceback=traceback.format_exc(),
                    )

                if record.job_id and record.queue:
                    await self._deliver_callback(record, token=token)
            finally:
                self._release(run_id)

    async def _heartbeat(self, record: RunRecord, token: str, every: float) -> None:
        """Tell the API, every ``every`` seconds, that this service still holds the run.

        Runs from submit until the callback has been attempted, so a run queued
        behind another one keeps its job too. A refused or failed beat is only
        logged: the next one may land and the API lets the job go when none do.
        """
        while True:
            await asyncio.sleep(every)
            url = f"{self._api_url().rstrip('/')}/function-runs/heartbeat"
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    response = await client.post(
                        url,
                        json={"job_id": record.job_id, "queue": record.queue},
                        headers=self._auth_headers(token),
                    )
                if response.status_code >= 300:
                    logger.warning(
                        "function_run_heartbeat_rejected",
                        run_id=record.run_id,
                        job_id=record.job_id,
                        http_status=response.status_code,
                        body=response.text[:300],
                    )
            except Exception as exc:
                logger.warning(
                    "function_run_heartbeat_error",
                    run_id=record.run_id,
                    job_id=record.job_id,
                    url=url,
                    error=describe_transport_error(exc),
                )

    async def _deliver_callback(self, record: RunRecord, token: str | None) -> None:
        url = f"{self._api_url().rstrip('/')}/function-runs/callback"
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
            # Read again on every attempt: a retry that joins this run while the
            # API is unreachable brings a newer token than the one we started with.
            current = self._tokens.get(record.run_id) or token
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    response = await client.post(
                        url, json=body, headers=self._auth_headers(current)
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
        """The per-run token the API issued, echoed back. Nothing is signed here.

        A run dispatched without one (only possible from a client other than the
        API's dispatcher) reports unauthenticated and the API refuses it — the
        job then recovers via pg-boss expiry rather than by trusting the caller.
        """
        if not token:
            logger.warning("run_token_missing_callback_will_be_unauthenticated")
            return {}
        return {"Authorization": f"Bearer {token}"}


def build_router(runner: FunctionRunner) -> APIRouter:
    """The three runner routes, bound to ``runner``, for the service's app to include."""
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
        # `heartbeats`: this runner honours `heartbeat_seconds`. The API's
        # dispatcher logs an error against a sidecar that does not say so.
        return {
            "functions": sorted(runner.registry),
            "concurrency": runner.concurrency,
            "heartbeats": True,
        }

    return router


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


__all__ = [
    "CALLBACK_RETRY_DELAYS",
    "FunctionRunner",
    "Registry",
    "RunRecord",
    "RunRequest",
    "build_router",
    "callback_unreachable_hint",
    "describe_transport_error",
]
