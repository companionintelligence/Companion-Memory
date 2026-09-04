"""
FastAPI endpoints for manual summary triggers.

Simple HTTP layer - delegates to summaries.py for execution logic.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any

import nest_asyncio
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from ci.telemetry import init_telemetry

from . import __version__, functions
from .data_aggregator import aggregator
from .llm_health import check_endpoint_at_startup, probe_endpoint
from .runner import RunRequest, runner
from .runner import router as runner_router

# No-op unless SENTRY_DSN is set — see telemetry.py.
init_telemetry("ci-server-summary")

# Allow nested event loops (needed for run_sync() in async FastAPI context)
nest_asyncio.apply()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """
    Say out loud, once, whether the model endpoint is actually there.

    Every summary, insight and action this service produces goes through that
    endpoint, and a service pointed at nothing used to boot clean and fail one
    job at a time — see llm_health.py for the run this cost. Off the event loop
    so a black-holed address delays startup by the probe timeout at worst, and
    never fatal: a down model is a degraded service, not a crashed one.
    """
    await asyncio.to_thread(check_endpoint_at_startup)
    yield


app = FastAPI(
    title="CI Summary API",
    version=__version__,
    description="Manual summary triggers, background function runner, and data aggregation.",
    lifespan=lifespan,
)

# pg-boss function runner: POST /functions/run, GET /runs/{id}
app.include_router(runner_router)


@app.get("/health")
async def health() -> dict[str, Any]:
    """
    Liveness, plus the state of the one dependency that silently breaks.

    Always 200: the process is up and its HTTP surface works, which is what a
    container healthcheck is asking. An unreachable model shows as
    `status: degraded` with the endpoint and the reason, so nobody has to infer
    it from a stream of failed jobs. Probed live rather than cached from boot,
    because "the model came back" is the more common transition.
    """
    status = await asyncio.to_thread(probe_endpoint)

    return {
        "status": "ok" if status.reachable else "degraded",
        "service": "ci-summary",
        "version": __version__,
        "llm": status.as_dict(),
    }


# ============================================================================
# Manual summary triggers
# ============================================================================


class ManualSummaryRequest(BaseModel):
    user_id: str = Field(description="User UUID")
    period_type: str = Field(
        default="hourly",
        description="hourly|hourly_backfill|daily|weekly|monthly|dossier",
    )
    start_time: str | None = Field(default=None, description="ISO start time")
    end_time: str | None = Field(default=None, description="ISO end time")
    timezone: str = Field(default="UTC", description="Timezone")
    lookback_days: int | None = Field(
        default=None, description="For dossier: lookback days"
    )
    force: bool = Field(
        default=False,
        description=(
            "hourly / hourly_backfill: regenerate windows that already have a "
            "summary, overwriting them in place"
        ),
    )
    wait: bool = Field(
        default=False,
        description=(
            "hourly_backfill: run inline and return the finished result instead "
            "of queueing. Only safe for a range short enough to beat the proxy "
            "timeout; a single hour runs inline either way."
        ),
    )


async def _trigger_summary_workflow(
    user_id: str,
    period_type: str,
    start_time: str,
    end_time: str,
    timezone: str,
    lookback_days: int | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """
    Run summary generation directly (same functions the pg-boss scheduler
    dispatches through the runner). Kept synchronous for debugging/manual use.
    """
    if period_type == "dossier":
        return await functions.dossier_refresh(
            user_id,
            end_time=end_time,
            timezone=timezone,
            lookback_days=lookback_days or 30,
        )

    if period_type == "hourly":
        return await functions.hourly_summary(
            user_id,
            start_time=start_time,
            end_time=end_time,
            timezone=timezone,
            force=force,
        )

    if period_type == "hourly_backfill":
        return await functions.hourly_summary_backfill(
            user_id,
            start_time=start_time,
            end_time=end_time,
            timezone=timezone,
            force=force,
        )

    rollups = {
        "daily": functions.daily_summary,
        "weekly": functions.weekly_summary,
        "monthly": functions.monthly_summary,
    }
    rollup = rollups.get(period_type)

    if not rollup:
        raise ValueError(f"Unknown period_type: {period_type}")

    return await rollup(
        user_id, start_time=start_time, end_time=end_time, timezone=timezone
    )


def _accepted_body(
    progress: dict[str, Any], message: str, duplicate: bool
) -> dict[str, Any]:
    backfill_id = progress["backfill_id"]
    run_id = progress.get("run_id")

    return {
        "status": "accepted",
        "message": message,
        "duplicate": duplicate,
        "backfill_id": backfill_id,
        "run_id": run_id,
        "progress_url": f"/summary/backfill/{backfill_id}",
        "run_url": f"/runs/{run_id}",
        "hours": progress["hours"],
        "forced": progress["forced"],
        "time_range": {"start": progress["start_time"], "end": progress["end_time"]},
    }


def _accept_hourly_backfill(
    user_id: str,
    plan: list[tuple[str, str]],
    timezone: str,
    force: bool,
) -> dict[str, Any]:
    """
    Hand a multi-hour backfill to the runner and answer immediately.

    Each window is a full LLM summary plus an embedding, so 24 of them serially
    is tens of minutes to hours. Running that inside the request meant every
    proxy in front of this service timed out first: the operator got no result,
    no progress, and no way to tell which hours had landed — while the work
    kept going invisibly on the other side of the dropped connection.

    The runner already has the shape we need (bounded pool, run records, a
    ``GET /runs/{id}``), so this is a submit plus a progress id the function
    publishes each finished window to.

    A range already queued or running is answered with that run instead of a
    second submit. The runner takes no singleton key, so nothing else stops a
    double-submitted day from spending 24 more LLM summaries rewriting the
    windows the first run is still working through.
    """
    start_time, end_time = plan[0][0], plan[-1][1]

    in_flight = functions.active_backfill(user_id, start_time, end_time, force)
    if in_flight is not None:
        return _accepted_body(
            in_flight,
            f"Hourly backfill for these {in_flight['hours']} hour(s) is already "
            f"{in_flight['status']}; watch that run rather than starting a second",
            duplicate=True,
        )

    backfill_id = str(uuid.uuid4())
    record = runner.submit(
        RunRequest(
            function="hourly_summary_backfill",
            args={
                "user_id": user_id,
                "start_time": start_time,
                "end_time": end_time,
                "timezone": timezone,
                "force": force,
                "backfill_id": backfill_id,
            },
        )
    )
    # Publish the queued record after the submit, with no await between the
    # two: a full runner queue raises 429 here and must not leave a record for
    # work nothing will run, while a worker cannot advance until this handler
    # yields, so there is no instant in which the id the caller was just given
    # answers 404.
    progress = functions.queue_backfill(backfill_id, user_id, plan, force)
    progress["run_id"] = record.run_id

    return _accepted_body(
        progress,
        f"Hourly backfill queued for {progress['hours']} hour(s)",
        duplicate=False,
    )


@app.get("/summary/backfill/{backfill_id}")
async def get_backfill_progress(backfill_id: str) -> dict[str, Any]:
    """
    Per-window progress for an accepted hourly backfill.

    ``status`` is queued | running | completed | failed — the record exists from
    the moment the 202 is returned, so polling the progress_url immediately
    answers rather than 404ing for the minutes a backfill spends waiting on a
    runner worker. ``windows`` grows as each hour finishes, carrying the same
    per-window shape the inline result returns, so a caller can see exactly
    which hours landed and which were skipped.
    """
    progress = functions.backfill_progress(backfill_id)

    if progress is None:
        # Say only what a missing record can actually distinguish. It used to
        # claim the backfill "never started", which was wrong for the entire
        # queued window and sent operators looking for a failure that was in
        # fact a healthy run waiting its turn.
        raise HTTPException(
            status_code=404,
            detail=(
                f"No backfill {backfill_id} on this process — progress records "
                f"are in-memory, so this id is unknown here, has aged out (last "
                f"{functions.MAX_BACKFILL_RECORDS} kept), or predates a restart"
            ),
        )

    return progress


@app.post("/summary/manual-trigger")
async def manual_trigger_summary(
    request: ManualSummaryRequest, response: Response
) -> dict[str, Any]:
    """
    Manually trigger summary generation.

    Runs inline and returns the finished result, except for a multi-hour
    ``hourly_backfill``, which is accepted into the runner and answered with a
    poll url — see _accept_hourly_backfill for why.
    """
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    if request.period_type == "hourly_backfill" and (
        request.start_time is None or request.end_time is None
    ):
        raise HTTPException(
            status_code=400,
            detail="hourly_backfill requires explicit start_time and end_time",
        )

    # Parse time range
    end_time = _parse_iso(request.end_time) if request.end_time else datetime.utcnow()
    if request.start_time:
        start_time = _parse_iso(request.start_time)
    else:
        # Default window
        delta = {
            "hourly": timedelta(hours=1),
            "daily": timedelta(days=1),
            "weekly": timedelta(weeks=1),
            "monthly": timedelta(days=30),
            "dossier": timedelta(days=1),
        }.get(request.period_type, timedelta(hours=1))
        start_time = end_time - delta

    if request.period_type == "hourly_backfill":
        # Validate here rather than inside the accepted run: once the work is
        # queued a bad range is a failed background job the operator has to go
        # hunting for, instead of a 400 answering the request they just made.
        try:
            plan = functions.plan_hourly_backfill(
                start_time.isoformat(), end_time.isoformat()
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        # One hour is a single LLM call — cheap enough to answer inline, which
        # is what the documented single-window debugging use expects.
        if len(plan) > 1 and not request.wait:
            # 202: the work is queued, not done — the body carries where to
            # watch it, and a caller that keys off the status code should see
            # that difference rather than a 200 promising a finished summary.
            response.status_code = 202
            return _accept_hourly_backfill(
                str(user_id),
                plan,
                request.timezone,
                request.force,
            )

    try:
        result = await _trigger_summary_workflow(
            str(user_id),
            request.period_type,
            start_time.isoformat(),
            end_time.isoformat(),
            request.timezone,
            request.lookback_days,
            request.force,
        )

        return {
            "status": "success",
            "message": f"{request.period_type.title()} summary generated",
            "result": result,
            "time_range": {
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            },
        }

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Generation failed: {exc!s}"
        ) from exc


# ============================================================================
# Dossier endpoints
# ============================================================================


class DossierRefreshRequest(BaseModel):
    user_id: str = Field(description="User UUID")
    start_time: str | None = None
    end_time: str | None = None
    timezone: str = Field(default="UTC")
    lookback_days: int | None = None


class DossierFetchRequest(BaseModel):
    user_id: str


@app.post("/dossier/refresh")
async def refresh_dossier(request: DossierRefreshRequest) -> dict[str, Any]:
    """Manually refresh user dossier (runs inline)."""
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    end_time = _parse_iso(request.end_time) if request.end_time else datetime.utcnow()

    try:
        result = await _trigger_summary_workflow(
            str(user_id),
            "dossier",
            end_time.isoformat(),  # start_time not used for dossier
            end_time.isoformat(),
            request.timezone,
            request.lookback_days,
        )
        return {
            "status": "success",
            "message": "Dossier refreshed",
            "result": result,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Refresh failed: {exc}") from exc


@app.post("/dossier/get")
async def get_dossier(request: DossierFetchRequest) -> dict[str, Any]:
    """Fetch current user dossier."""
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    from .database import db

    # Get entity
    rows = db.execute_query(
        "SELECT entity_id, dossier FROM entities WHERE owner_user_id = :user_id AND entity_type = 'Person' LIMIT 1",
        {"user_id": str(user_id)},
    )

    if not rows:
        raise HTTPException(status_code=404, detail="No entity found for user")

    entity_id = rows[0].get("entity_id")
    dossier = rows[0].get("dossier")

    if not dossier:
        raise HTTPException(status_code=404, detail="No dossier available")

    return {"entity_id": entity_id, "dossier": dossier}


# ============================================================================
# Insights endpoints
# ============================================================================


class InsightsRequest(BaseModel):
    user_id: str = Field(description="User UUID")
    timezone: str = Field(default="UTC", description="User's timezone")
    lookback_hours: int | None = Field(
        default=72, description="Hours to look back for context (default 72)"
    )
    trust_mode: str | None = Field(
        default=None, description="User autonomy setting (cautious|balanced|hands_off)"
    )
    insight_volume_multiplier: float | None = Field(
        default=1.0, description="Scale insight card volume by trust dial"
    )


async def _trigger_insights_workflow(
    user_id: str,
    timezone: str,
    lookback_hours: int,
    force: bool = False,
    trust_mode: str | None = None,
    insight_volume_multiplier: float | None = 1.0,
) -> dict[str, Any]:
    """Run insights generation directly (same function pg-boss dispatches)."""
    personalization_config = {
        "trust_mode": trust_mode,
        "insight_volume_multiplier": insight_volume_multiplier or 1.0,
    }

    return await functions.insights_generation(
        user_id,
        timezone=timezone,
        lookback_hours=lookback_hours,
        personalization=personalization_config,
        force=force,
    )


async def _trigger_actions_workflow(
    user_id: str,
    timezone: str,
    lookback_hours: int,
) -> dict[str, Any]:
    """Run actions generation directly (same function pg-boss dispatches)."""
    import math

    lookback_days = max(1, math.ceil(lookback_hours / 24))

    return await functions.actions_generation(
        user_id, timezone=timezone, lookback_days=lookback_days
    )


@app.post("/insights/generate")
async def generate_insights(request: InsightsRequest) -> dict[str, Any]:
    """
    Manually trigger proactive insights generation.

    Generates actionable insights based on:
    - Recent graph deltas (new people, relationship changes)
    - Upcoming events (next 14 days)
    - Recent activity summaries
    - Strongest and recently-changed relationships
    - Recent communications

    Will skip if no new data since last insight generation.
    """
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    try:
        result = await _trigger_insights_workflow(
            str(user_id),
            request.timezone,
            request.lookback_hours,
            force=False,
            trust_mode=request.trust_mode,
            insight_volume_multiplier=request.insight_volume_multiplier,
        )

        if result.get("skipped"):
            return {
                "status": "skipped",
                "reason": result.get("reason"),
                "user_id": request.user_id,
                "message": f"Insights generation skipped: {result.get('reason')}",
            }

        return {
            "status": "success",
            "message": f"Generated {result.get('num_insights', 0)} insights",
            "summary_ids": result.get("summary_ids"),
            "num_insights": result.get("num_insights"),
            "tokens_used": result.get("tokens_used", 0),
        }

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Insights generation failed: {exc!s}"
        ) from exc


@app.post("/insights/force-generate")
async def force_generate_insights(request: InsightsRequest) -> dict[str, Any]:
    """
    Force insights generation even if no new data.

    Use this to regenerate insights regardless of whether there's new data.
    Sets lookback to specified hours (default 72) from now.
    """
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    try:
        result = await _trigger_insights_workflow(
            str(user_id),
            request.timezone,
            request.lookback_hours,
            force=True,
        )

        if result.get("skipped"):
            return {
                "status": "skipped",
                "reason": result.get("reason"),
                "user_id": request.user_id,
                "message": f"Insights generation skipped: {result.get('reason')}",
            }

        return {
            "status": "success",
            "message": f"Force-generated {result.get('num_insights', 0)} insights",
            "summary_ids": result.get("summary_ids"),
            "num_insights": result.get("num_insights"),
            "tokens_used": result.get("tokens_used", 0),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Insights generation failed: {exc!s}"
        ) from exc


@app.post("/actions/generate")
async def generate_actions_endpoint(request: InsightsRequest) -> dict[str, Any]:
    """
    Manually trigger proactive actions generation.

    Generates Action Cards based on recent user context.
    """
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    # Reuse insight aggregation logic for context
    # We can invoke the activity directly via a workflow, or just run the aggregation + generation here if we want synchronous response
    # But sticking to workflow pattern is better for timeout handling.
    # However, for "Action Cards" on a feed, the user might expect a quicker response?
    # Insights/Summaries are background tasks.
    # But let's follow the pattern and use a workflow.
    # I need to create ActionsGenerationWorkflow in workflows.py first.
    # Since I haven't done that yet, I'll return a placeholder or implement the workflow trigger.
    # I will implement the workflow trigger, assuming I will create the workflow next.

    try:
        # Trigger workflow
        # Need to define a new workflow in workflows.py and a helper here
        result = await _trigger_actions_workflow(
            str(user_id),
            request.timezone,
            request.lookback_hours,
        )

        return {
            "status": "success",
            "message": f"Generated {result.get('num_actions', 0)} actions",
            "actions": result.get("actions", []),
            "tokens_used": result.get("tokens_used", 0),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Actions generation failed: {exc!s}"
        ) from exc


# ============================================================================
# Aggregate preview (for debugging)
# ============================================================================


@app.get("/summary/aggregate")
async def get_aggregate_preview(request: ManualSummaryRequest) -> dict[str, Any]:
    """Get aggregated data preview (no summary generation)."""
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    end_time = _parse_iso(request.end_time) if request.end_time else datetime.utcnow()
    start_time = (
        _parse_iso(request.start_time)
        if request.start_time
        else end_time - timedelta(hours=1)
    )

    aggregated = aggregator.aggregate_hour(user_id, start_time, end_time)
    return {
        "user_id": str(user_id),
        "start_time": start_time.isoformat(),
        "end_time": end_time.isoformat(),
        "aggregated_data": aggregated,
    }


# ============================================================================
# Helpers
# ============================================================================


def _parse_iso(iso_str: str | None) -> datetime:
    """Parse ISO timestamp."""
    if not iso_str:
        return datetime.utcnow()
    if iso_str.endswith("Z"):
        iso_str = iso_str.replace("Z", "+00:00")
    return datetime.fromisoformat(iso_str)


__all__ = ["app"]
