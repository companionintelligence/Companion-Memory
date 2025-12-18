"""
FastAPI endpoints for manual triggers and browser history processing.

Simple HTTP layer - delegates to summaries.py for execution logic.
"""
import uuid
import nest_asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, ConfigDict

from .browser_history_processor import history_processor
from .data_aggregator import aggregator
from . import summaries
from . import __version__

# Allow nested event loops (needed for run_sync() in async FastAPI context)
nest_asyncio.apply()

app = FastAPI(
    title="CI Memory API",
    version=__version__,
    description="Browser history processing and manual summary triggers.",
)


# ============================================================================
# Browser history endpoints
# ============================================================================

class HistoryEntry(BaseModel):
    date: str
    time: str
    title: str = ""
    url: str = ""
    visit_count: int = Field(default=1, alias="visitCount")
    typed_count: int = Field(default=0, alias="typedCount")
    transition: Optional[str] = None
    model_config = ConfigDict(populate_by_name=True)


class HistoryPayload(BaseModel):
    entries: List[HistoryEntry]
    output_filename: Optional[str] = None


@app.post("/history/process-file")
async def process_history_file(
    file: UploadFile = File(...),
    output_filename: Optional[str] = None,
) -> Dict[str, Any]:
    """Process uploaded browser history CSV."""
    if file.content_type not in ("text/csv", "application/vnd.ms-excel", None):
        raise HTTPException(status_code=400, detail="Only CSV uploads supported")

    data = await file.read()
    try:
        return history_processor.process_csv_bytes(
            data, output_path=output_filename, source_name=file.filename or "upload.csv"
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/history/process-entries")
async def process_history_entries(payload: HistoryPayload) -> Dict[str, Any]:
    """Process browser history from JSON payload."""
    rows = [entry.model_dump(by_alias=True) for entry in payload.entries]
    try:
        return history_processor.process_entries(
            rows, output_path=payload.output_filename, source_name="manual-payload"
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ============================================================================
# Manual summary trigger
# ============================================================================

class ManualSummaryRequest(BaseModel):
    user_id: str = Field(description="User UUID")
    period_type: str = Field(default="hourly", description="hourly|daily|weekly|monthly|dossier")
    start_time: Optional[str] = Field(default=None, description="ISO start time")
    end_time: Optional[str] = Field(default=None, description="ISO end time")
    timezone: str = Field(default="UTC", description="Timezone")
    lookback_days: Optional[int] = Field(default=None, description="For dossier: lookback days")


@app.post("/summary/manual-trigger")
async def manual_trigger_summary(request: ManualSummaryRequest) -> Dict[str, Any]:
    """Manually trigger summary generation (bypasses queue)."""
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

    # Execute
    try:
        if request.period_type == "hourly":
            result = summaries.execute_hourly_summary(user_id, start_time, end_time, request.timezone)
        elif request.period_type == "daily":
            result = summaries.execute_daily_summary(user_id, start_time, end_time, request.timezone)
        elif request.period_type == "weekly":
            result = summaries.execute_weekly_summary(user_id, start_time, end_time, request.timezone)
        elif request.period_type == "monthly":
            result = summaries.execute_monthly_summary(user_id, start_time, end_time, request.timezone)
        elif request.period_type == "dossier":
            result = summaries.execute_dossier_refresh(
                user_id, end_time, request.timezone, request.lookback_days
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unknown period_type: {request.period_type}")

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
    """Manually refresh user dossier."""
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {exc}") from exc

    end_time = _parse_iso(request.end_time) if request.end_time else datetime.utcnow()

    try:
        result = summaries.execute_dossier_refresh(
            user_id, end_time, request.timezone, request.lookback_days
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
