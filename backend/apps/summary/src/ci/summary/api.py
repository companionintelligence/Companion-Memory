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
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ci.telemetry import init_telemetry

from . import __version__, functions
from .data_aggregator import aggregator
from .llm_health import check_endpoint_at_startup, probe_endpoint
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
        default="hourly", description="hourly|daily|weekly|monthly|dossier"
    )
    start_time: str | None = Field(default=None, description="ISO start time")
    end_time: str | None = Field(default=None, description="ISO end time")
    timezone: str = Field(default="UTC", description="Timezone")
    lookback_days: int | None = Field(
        default=None, description="For dossier: lookback days"
    )


async def _trigger_summary_workflow(
    user_id: str,
    period_type: str,
    start_time: str,
    end_time: str,
    timezone: str,
    lookback_days: int | None = None,
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
            user_id, start_time=start_time, end_time=end_time, timezone=timezone
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


@app.post("/summary/manual-trigger")
async def manual_trigger_summary(request: ManualSummaryRequest) -> dict[str, Any]:
    """Manually trigger summary generation (runs inline)."""
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

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

    try:
        result = await _trigger_summary_workflow(
            str(user_id),
            request.period_type,
            start_time.isoformat(),
            end_time.isoformat(),
            request.timezone,
            request.lookback_days,
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
