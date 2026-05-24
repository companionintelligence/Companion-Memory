"""
FastAPI endpoints for manual summary triggers.

Simple HTTP layer - delegates to summaries.py for execution logic.
"""
import uuid
import nest_asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .data_aggregator import aggregator
from . import workflow_control
from . import __version__

# Allow nested event loops (needed for run_sync() in async FastAPI context)
nest_asyncio.apply()

app = FastAPI(
    title="CI Summary API",
    version=__version__,
    description="Manual summary triggers and data aggregation.",
)


# ============================================================================
# Manual summary triggers
# ============================================================================

class ManualSummaryRequest(BaseModel):
    user_id: str = Field(description="User UUID")
    period_type: str = Field(default="hourly", description="hourly|daily|weekly|monthly|dossier")
    start_time: Optional[str] = Field(default=None, description="ISO start time")
    end_time: Optional[str] = Field(default=None, description="ISO end time")
    timezone: str = Field(default="UTC", description="Timezone")
    lookback_days: Optional[int] = Field(default=None, description="For dossier: lookback days")


async def _trigger_summary_workflow(
    user_id: str,
    period_type: str,
    start_time: str,
    end_time: str,
    timezone: str,
    lookback_days: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Trigger summary generation workflow via Temporal.

    This ensures all summary generation goes through the same code path
    with proper durability, retries, and visibility.
    """
    from temporalio.client import Client
    from .config import settings
    from .priority import Priority, get_task_queue

    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    now = datetime.utcnow()

    # Map period_type to workflow name
    workflow_map = {
        "hourly": "hourly-summary",
        "daily": "daily-summary",
        "weekly": "weekly-summary",
        "monthly": "monthly-summary",
        "dossier": "dossier-refresh",
    }

    workflow_name = workflow_map.get(period_type)
    if not workflow_name:
        raise ValueError(f"Unknown period_type: {period_type}")

    workflow_id = f"{period_type}-{user_id}-{now.isoformat()}"

    # Build args based on workflow type
    if period_type == "dossier":
        args = [user_id, end_time, timezone, lookback_days or 30, None]
    else:
        args = [user_id, start_time, end_time, timezone, None]

    # Start the workflow and wait for result
    result = await client.execute_workflow(
        workflow_name,
        args=args,
        id=workflow_id,
        task_queue=get_task_queue(Priority.HIGH),  # API-triggered = high priority
    )

    return result


@app.post("/summary/manual-trigger")
async def manual_trigger_summary(request: ManualSummaryRequest) -> Dict[str, Any]:
    """Manually trigger summary generation via Temporal workflow."""
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
            "time_range": {"start": start_time.isoformat(), "end": end_time.isoformat()},
        }

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(exc)}") from exc


# ============================================================================
# Dossier endpoints
# ============================================================================

class DossierRefreshRequest(BaseModel):
    user_id: str = Field(description="User UUID")
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    timezone: str = Field(default="UTC")
    lookback_days: Optional[int] = None


class DossierFetchRequest(BaseModel):
    user_id: str


@app.post("/dossier/refresh")
async def refresh_dossier(request: DossierRefreshRequest) -> Dict[str, Any]:
    """Manually refresh user dossier via Temporal workflow."""
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
async def get_dossier(request: DossierFetchRequest) -> Dict[str, Any]:
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
    lookback_hours: Optional[int] = Field(default=72, description="Hours to look back for context (default 72)")


async def _trigger_insights_workflow(
    user_id: str,
    timezone: str,
    lookback_hours: int,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Trigger the InsightsGenerationWorkflow via Temporal.

    This ensures all insight generation goes through the same code path
    with proper durability, retries, and visibility.
    """
    from temporalio.client import Client
    from .config import settings
    from .priority import Priority, get_task_queue
    from datetime import datetime

    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    now = datetime.utcnow()
    workflow_id = f"insights-{user_id}-{now.isoformat()}"

    # Start the workflow and wait for result
    result = await client.execute_workflow(
        "insights-generation",
        args=[user_id, timezone, lookback_hours, None, force],
        id=workflow_id,
        task_queue=get_task_queue(Priority.HIGH),  # API-triggered = high priority
    )

    return result


    return result


async def _trigger_actions_workflow(
    user_id: str,
    timezone: str,
    lookback_hours: int,
) -> Dict[str, Any]:
    """
    Trigger the ActionsGenerationWorkflow via Temporal.
    """
    from temporalio.client import Client
    from .config import settings
    from .priority import Priority, get_task_queue
    from datetime import datetime
    import math

    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    now = datetime.utcnow()
    workflow_id = f"actions-{user_id}-{now.isoformat()}"

    lookback_days = max(1, math.ceil(lookback_hours / 24))

    # Start the workflow and wait for result
    result = await client.execute_workflow(
        "actions-generation",
        args=[user_id, timezone, lookback_days, None],
        id=workflow_id,
        task_queue=get_task_queue(Priority.HIGH),
    )

    return result


@app.post("/insights/generate")
async def generate_insights(request: InsightsRequest) -> Dict[str, Any]:
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
        raise HTTPException(status_code=500, detail=f"Insights generation failed: {str(exc)}") from exc


@app.post("/insights/force-generate")
async def force_generate_insights(request: InsightsRequest) -> Dict[str, Any]:
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
        raise HTTPException(status_code=500, detail=f"Insights generation failed: {str(exc)}") from exc


@app.post("/actions/generate")
async def generate_actions_endpoint(request: InsightsRequest) -> Dict[str, Any]:
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
        raise HTTPException(status_code=500, detail=f"Actions generation failed: {str(exc)}") from exc


# ============================================================================
# Aggregate preview (for debugging)
# ============================================================================

@app.get("/summary/aggregate")
async def get_aggregate_preview(request: ManualSummaryRequest) -> Dict[str, Any]:
    """Get aggregated data preview (no summary generation)."""
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    end_time = _parse_iso(request.end_time) if request.end_time else datetime.utcnow()
    start_time = _parse_iso(request.start_time) if request.start_time else end_time - timedelta(hours=1)

    aggregated = aggregator.aggregate_hour(user_id, start_time, end_time)
    return {
        "user_id": str(user_id),
        "start_time": start_time.isoformat(),
        "end_time": end_time.isoformat(),
        "aggregated_data": aggregated,
    }


# ============================================================================
# Workflow Control (for LLM resource management)
# ============================================================================

class CancelWorkflowsRequest(BaseModel):
    workflow_types: Optional[list[str]] = Field(
        default=None,
        description="Workflow types to cancel (hourly, daily, weekly, monthly, dossier). If None, cancels all."
    )


class CancelUserWorkflowsRequest(BaseModel):
    user_id: str = Field(description="User ID whose workflows to cancel")
    workflow_types: Optional[list[str]] = Field(
        default=None,
        description="Workflow types to cancel. If None, cancels all user workflows."
    )


@app.post("/workflows/cancel-system")
async def cancel_system_workflows_endpoint(request: CancelWorkflowsRequest) -> Dict[str, Any]:
    """
    Cancel running system workflows to free up LLM resources for high-priority work.

    Use this when critical LLM operations need immediate access and background
    summarization can be paused.
    """
    try:
        results = await workflow_control.cancel_system_workflows(request.workflow_types)
        return {
            "status": "success",
            "message": "System workflow cancellation requested",
            "results": results,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cancellation failed: {str(exc)}") from exc


@app.post("/workflows/cancel-user")
async def cancel_user_workflows_endpoint(request: CancelUserWorkflowsRequest) -> Dict[str, Any]:
    """
    Cancel running workflows for a specific user.

    Use this to stop background processing for a particular user when needed.
    """
    try:
        user_id_uuid = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    try:
        results = await workflow_control.cancel_user_workflows(
            str(user_id_uuid),
            request.workflow_types
        )
        return {
            "status": "success",
            "message": f"User workflow cancellation requested for {request.user_id}",
            "results": results,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cancellation failed: {str(exc)}") from exc


@app.get("/workflows/status")
async def get_workflow_status() -> Dict[str, Any]:
    """
    Get information about currently running workflows.

    Useful for monitoring LLM resource usage and deciding when to cancel workflows.
    """
    try:
        workflow_counts = await workflow_control.get_running_workflows()
        return {
            "status": "success",
            "workflows": workflow_counts,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Status fetch failed: {str(exc)}") from exc


# ============================================================================
# Helpers
# ============================================================================

def _parse_iso(iso_str: Optional[str]) -> datetime:
    """Parse ISO timestamp."""
    if not iso_str:
        return datetime.utcnow()
    if iso_str.endswith("Z"):
        iso_str = iso_str.replace("Z", "+00:00")
    return datetime.fromisoformat(iso_str)


__all__ = ["app"]
