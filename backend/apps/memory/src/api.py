"""FastAPI surface for manual browser-history processing and manual summary triggers."""
from __future__ import annotations

import uuid
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, ConfigDict

from .browser_history_processor import history_processor
from .data_aggregator import aggregator
from .storage import storage, SummaryMetadata
from .summarizer import summarizer
from .config import settings
from . import __version__


app = FastAPI(
    title="CI Memory API",
    version=__version__,
    description="Utility endpoints for browser history processing and manual summary triggers.",
)


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
    output_filename: Optional[str] = Field(
        default=None,
        description="Optional relative path for the generated summary CSV.",
    )


@app.post("/history/process-file")
async def process_history_file(
    file: UploadFile = File(...),
    output_filename: Optional[str] = None,
) -> Dict[str, Any]:
    """Accept a CSV upload, summarize it, and return the generated rows."""
    if file.content_type not in ("text/csv", "application/vnd.ms-excel", None):
        raise HTTPException(status_code=400, detail="Only CSV uploads are supported")

    data = await file.read()
    try:
        result = history_processor.process_csv_bytes(
            data,
            output_path=output_filename,
            source_name=file.filename or "upload.csv",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result


@app.post("/history/process-entries")
async def process_history_entries(payload: HistoryPayload) -> Dict[str, Any]:
    """Process raw JSON payloads without going through the queue or listener."""
    rows = [entry.model_dump(by_alias=True) for entry in payload.entries]

    try:
        result = history_processor.process_entries(
            rows,
            output_path=payload.output_filename,
            source_name="manual-payload",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result


class ManualSummaryRequest(BaseModel):
    """Request payload for manual summary trigger."""
    user_id: str = Field(
        description="User UUID to generate summary for"
    )
    period_type: str = Field(
        default="hourly",
        description="Type of summary to generate: hourly, daily, or weekly"
    )
    start_time: Optional[str] = Field(
        default=None,
        description="ISO format start time. If not provided, defaults to 1 hour ago for hourly summaries."
    )
    end_time: Optional[str] = Field(
        default=None,
        description="ISO format end time. If not provided, defaults to now."
    )
    timezone: str = Field(
        default="UTC",
        description="Timezone for the summary"
    )


@app.post("/summary/manual-trigger")
async def manual_trigger_summary(
    request: ManualSummaryRequest,
) -> Dict[str, Any]:
    """
    Manually trigger a summary generation, bypassing the PgBoss queue.
    
    Useful for testing and debugging. Executes the same logic as the worker
    but directly without going through the queue system.
    """
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id UUID: {exc}") from exc

    # Parse or default time range
    if request.end_time:
        end_time = _parse_iso(request.end_time)
    else:
        end_time = datetime.utcnow()

    if request.start_time:
        start_time = _parse_iso(request.start_time)
    else:
        # Default to last hour for hourly summaries
        if request.period_type == "hourly":
            start_time = end_time - timedelta(hours=1)
        elif request.period_type == "daily":
            start_time = end_time - timedelta(days=1)
        elif request.period_type == "weekly":
            start_time = end_time - timedelta(weeks=1)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported period_type: {request.period_type}"
            )

    # Execute the summary
    try:
        if request.period_type == "hourly":
            result = _execute_hourly_summary(
                user_id,
                start_time,
                end_time,
                request.timezone
            )
        elif request.period_type == "daily":
            result = _execute_daily_summary(
                user_id,
                start_time,
                end_time,
                request.timezone
            )
        elif request.period_type == "weekly":
            result = _execute_weekly_summary(
                user_id,
                start_time,
                end_time,
                request.timezone
            )
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported period_type: {request.period_type}"
            )

        return {
            "status": "success",
            "message": f"{request.period_type.capitalize()} summary generated successfully",
            "result": result,
            "time_range": {
                "start": start_time.isoformat(),
                "end": end_time.isoformat(),
            },
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Summary generation failed: {str(exc)}"
        ) from exc


@app.get("/summary/aggregate")
async def get_aggregate_preview(
    request: ManualSummaryRequest,
) -> Dict[str, Any]:
    try:
        user_id = uuid.UUID(request.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid user_id UUID: {exc}") from exc

    if request.end_time:
        end_time = _parse_iso(request.end_time)
    else:
        end_time = datetime.utcnow()

    if request.start_time:
        start_time = _parse_iso(request.start_time)
    else:
        start_time = end_time - timedelta(hours=1)

    aggregated = aggregator.aggregate_hour(user_id, start_time, end_time)
    return {
        "user_id": str(user_id),
        "start_time": start_time.isoformat(),
        "end_time": end_time.isoformat(),
        "aggregated_data": aggregated,
    }


def _parse_iso(iso_str: str) -> datetime:
    """Parse ISO format timestamp."""
    if iso_str.endswith("Z"):
        iso_str = iso_str.replace("Z", "+00:00")
    return datetime.fromisoformat(iso_str)


def _execute_hourly_summary(
    user_id: uuid.UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str,
) -> Dict[str, Any]:
    """Execute hourly summary generation."""
    # Add overlap as the worker does
    overlap = timedelta(minutes=settings.summary_overlap_minutes)
    adjusted_start = start_time - overlap
    adjusted_end = end_time + overlap

    aggregated_data = aggregator.aggregate_hour(user_id, adjusted_start, adjusted_end)
    summary_data = summarizer.generate_hourly_summary(aggregated_data)

    metadata = SummaryMetadata(
        timezone=timezone,
        source_types=_derive_source_types(aggregated_data),
        structured_context={
            "activity_counts": summary_data['activity_counts'],
            "aggregated_data": aggregated_data,
            "key_insights": summary_data.get('key_insights'),
            "events": summary_data.get('events'),
            "anomalies": summary_data.get('anomalies'),
        },
        tags=_derive_tags(summary_data, aggregated_data),
    )

    summary_id = storage.store_summary(
        user_id,
        summary_data,
        start_time,
        end_time,
        metadata=metadata,
    )

    return {
        "summary_id": str(summary_id),
        "summary_type": "hourly",
        "summary_text": _decode_summary_text(summary_data),
        "key_insights": summary_data.get("key_insights", []),
        "activity_counts": summary_data["activity_counts"],
    }


def _execute_daily_summary(
    user_id: uuid.UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str,
) -> Dict[str, Any]:
    """Execute daily summary generation."""
    hourly_summaries_raw = storage.get_hourly_summaries(user_id, start_time, end_time)
    hourly_summaries = [
        {
            "summary_text": h.get("summary_text", ""),
            "activity_counts": h.get("activity_counts", {}),
        }
        for h in hourly_summaries_raw
    ]

    if not hourly_summaries:
        raise ValueError("No hourly summaries found for daily aggregation")

    summary_data = summarizer.generate_daily_summary(hourly_summaries)

    child_ids = [str(h['summary_id']) for h in hourly_summaries_raw]
    metadata = SummaryMetadata(
        timezone=timezone,
        source_types=['memory.hourly'],
        structured_context={
            "activity_counts": summary_data['activity_counts'],
            "child_summary_ids": child_ids,
            "num_child_summaries": len(hourly_summaries),
        },
        related_entity_ids=child_ids,
    )

    summary_id = storage.store_summary(
        user_id,
        summary_data,
        start_time,
        end_time,
        metadata=metadata,
    )

    return {
        "summary_id": str(summary_id),
        "summary_type": "daily",
        "summary_text": _decode_summary_text(summary_data),
        "activity_counts": summary_data["activity_counts"],
        "num_hourly_summaries": len(hourly_summaries),
    }


def _execute_weekly_summary(
    user_id: uuid.UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str,
) -> Dict[str, Any]:
    """Execute weekly summary generation."""
    daily_summaries_raw = storage.get_daily_summaries(user_id, start_time, end_time)
    daily_summaries = [
        {
            "summary_text": record.get("summary_text", ""),
            "activity_counts": record.get("activity_counts", {}),
        }
        for record in daily_summaries_raw
    ]

    if not daily_summaries:
        raise ValueError("No daily summaries found for weekly aggregation")

    summary_data = summarizer.generate_period_rollup('weekly', 'daily', daily_summaries)
    summary_data.setdefault('num_child_summaries', len(daily_summaries_raw))
    summary_data.setdefault('num_daily_summaries', len(daily_summaries_raw))
    child_ids = [str(record['summary_id']) for record in daily_summaries_raw]

    metadata = SummaryMetadata(
        timezone=timezone,
        source_types=['memory.daily'],
        structured_context={
            "activity_counts": summary_data['activity_counts'],
            "child_summary_ids": child_ids,
            "num_child_summaries": len(daily_summaries_raw),
        },
        related_entity_ids=child_ids,
    )

    summary_id = storage.store_summary(
        user_id,
        summary_data,
        start_time,
        end_time,
        metadata=metadata,
    )

    return {
        "summary_id": str(summary_id),
        "summary_type": summary_data['summary_type'],
        "summary_text": _decode_summary_text(summary_data),
        "activity_counts": summary_data['activity_counts'],
        "num_daily_summaries": len(daily_summaries),
    }


def _derive_source_types(aggregated_data: Dict[str, Any]) -> list[str]:
    """Derive source types from aggregated data."""
    sources: list[str] = []
    for key, value in aggregated_data.items():
        if key in {"user_id", "start_time", "end_time"}:
            continue
        if isinstance(value, list) and value:
            sources.append(key)
    return sources or ["memory"]


def _derive_tags(summary_data: Dict[str, Any], aggregated_data: Dict[str, Any]) -> list[str]:
    """Derive tags from summary data."""
    insights = summary_data.get('key_insights') or []
    if isinstance(insights, list):
        return insights[:5]
    return []


def _decode_summary_text(summary_data: Dict[str, Any]) -> Any:
    text = summary_data.get('summary_text')
    if isinstance(text, str):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text



__all__ = ["app"]
