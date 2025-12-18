"""
Core summary execution logic - single source of truth.

Both the worker and API delegate to these functions.
"""
import json
import structlog
from typing import Dict, Any
from datetime import datetime, timedelta
from uuid import UUID

from .config import settings
from .data_aggregator import aggregator
from .database import db
from .summarizer import summarizer

logger = structlog.get_logger()


def execute_hourly_summary(
    user_id: UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str = "UTC",
) -> Dict[str, Any]:
    """Execute hourly summary generation."""
    # Add overlap for context
    overlap = timedelta(minutes=settings.summary_overlap_minutes)
    adjusted_start = start_time - overlap
    adjusted_end = end_time + overlap

    # Aggregate data
    aggregated_data = aggregator.aggregate_hour(user_id, adjusted_start, adjusted_end)
    logger.info("data_aggregated",
                user_id=str(user_id),
                measurements=len(aggregated_data.get("measurements", [])),
                events=len(aggregated_data.get("events", [])),
                communications=len(aggregated_data.get("communications", [])),
                browser_activity=len(aggregated_data.get("browser_activity", [])))

    # Generate summary
    summary_data = summarizer.generate_hourly_summary(aggregated_data)
    logger.info("summary_generated", has_activity=summary_data.get("activity_counts", {}).get("total", 0) > 0)

    # Store summary
    summary_id = _store_summary(user_id, summary_data, start_time, end_time, timezone)

    return {
        "summary_id": str(summary_id),
        "summary_type": "hourly",
        "summary_text": summary_data.get("summary_text", ""),
        "key_insights": summary_data.get("key_insights", []),
        "activity_counts": summary_data.get("activity_counts", {}),
    }


def execute_daily_summary(
    user_id: UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str = "UTC",
) -> Dict[str, Any]:
    """Execute daily summary from hourly summaries."""
    # Get hourly summaries
    hourly_summaries = _get_summaries(user_id, start_time, end_time, "hourly")
    if not hourly_summaries:
        raise ValueError("No hourly summaries found for daily aggregation")

    # Generate daily summary from hourlies
    summary_data = summarizer.generate_daily_summary(hourly_summaries)

    # Store
    summary_id = _store_summary(user_id, summary_data, start_time, end_time, timezone)

    return {
        "summary_id": str(summary_id),
        "summary_type": "daily",
        "summary_text": summary_data.get("summary_text", ""),
        "activity_counts": summary_data.get("activity_counts", {}),
        "num_hourly_summaries": len(hourly_summaries),
    }


def execute_weekly_summary(
    user_id: UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str = "UTC",
) -> Dict[str, Any]:
    """Execute weekly summary from daily summaries."""
    return _execute_rollup("weekly", user_id, start_time, end_time, timezone)


def execute_monthly_summary(
    user_id: UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str = "UTC",
) -> Dict[str, Any]:
    """Execute monthly summary from daily summaries."""
    return _execute_rollup("monthly", user_id, start_time, end_time, timezone)


def execute_dossier_refresh(
    user_id: UUID,
    end_time: datetime,
    timezone: str = "UTC",
    lookback_days: int = None,
) -> Dict[str, Any]:
    """Refresh user dossier from recent summaries."""
    from .dossier_builder import dossier_builder

    logger.info("dossier_refresh_started", user_id=str(user_id))

    # Get entity and previous dossier
    entity_id = _get_user_entity_id(user_id)
    if not entity_id:
        raise ValueError(f"No entity found for user {user_id}")

    logger.info("entity_found", entity_id=entity_id)

    previous_dossier = _get_entity_dossier(entity_id)
    logger.info("previous_dossier_fetched", has_dossier=bool(previous_dossier))

    # Build new dossier
    logger.info("building_new_dossier", lookback_days=lookback_days)
    dossier_payload = dossier_builder.build(
        user_id,
        end_time,
        timezone,
        lookback_override=lookback_days,
        previous_dossier=previous_dossier,
    )
    logger.info("dossier_built_successfully")

    if not dossier_payload:
        raise ValueError("Unable to build dossier from available summaries")

    # Persist
    db.execute_write(
        """
        UPDATE entities
        SET dossier = CAST(:dossier AS jsonb), updated_at = NOW()
        WHERE entity_id = :entity_id
        """,
        {"entity_id": entity_id, "dossier": json.dumps(dossier_payload)},
    )

    return {
        "entity_id": entity_id,
        "dossier": dossier_payload,
    }


# ============================================================================
# Internal helpers
# ============================================================================

def _execute_rollup(
    period_type: str,
    user_id: UUID,
    start_time: datetime,
    end_time: datetime,
    timezone: str,
) -> Dict[str, Any]:
    """Generic rollup (weekly/monthly/seasonal/yearly) from daily summaries."""
    daily_summaries = _get_summaries(user_id, start_time, end_time, "daily")
    if not daily_summaries:
        raise ValueError(f"No daily summaries found for {period_type} aggregation")

    summary_data = summarizer.generate_period_rollup(period_type, daily_summaries)
    summary_id = _store_summary(user_id, summary_data, start_time, end_time, timezone)

    return {
        "summary_id": str(summary_id),
        "summary_type": period_type,
        "summary_text": summary_data.get("summary_text", ""),
        "activity_counts": summary_data.get("activity_counts", {}),
        "num_daily_summaries": len(daily_summaries),
    }


def _store_summary(
    user_id: UUID,
    summary_data: Dict[str, Any],
    start_time: datetime,
    end_time: datetime,
    timezone: str,
) -> UUID:
    """Store a summary in the database."""
    from uuid import uuid4

    summary_id = uuid4()
    summary_type = summary_data.get("summary_type", "unknown")

    # Build content payload
    content = {
        "summary_text": summary_data.get("summary_text", ""),
        "key_insights": summary_data.get("key_insights", []),
        "activity_counts": summary_data.get("activity_counts", {}),
        "tokens_used": summary_data.get("tokens_used", 0),
    }

    # Determine source types from activity counts
    activity_counts = summary_data.get("activity_counts", {})
    source_types = [
        key for key, count in activity_counts.items()
        if key != "total" and count > 0
    ]

    # Insert
    db.execute_write(
        """
        INSERT INTO summaries (
            summary_id, user_id, period_start, period_end, period_type,
            timezone, source_types, title, content, summary_embedding, created_at, updated_at
        ) VALUES (
            :summary_id, :user_id, :period_start, :period_end, :period_type,
            :timezone, :source_types, :title, CAST(:content AS jsonb),
            CAST(:embedding AS vector), NOW(), NOW()
        )
        """,
        {
            "summary_id": str(summary_id),
            "user_id": str(user_id),
            "period_start": start_time,
            "period_end": end_time,
            "period_type": summary_type,
            "timezone": timezone,
            "source_types": source_types,
            "title": f"{summary_type.title()} Summary",
            "content": json.dumps(content),
            "embedding": json.dumps(summary_data.get("embedding", [])),
        },
    )

    logger.info("summary_stored", summary_id=str(summary_id), type=summary_type)
    return summary_id


def _get_summaries(
    user_id: UUID,
    start_time: datetime,
    end_time: datetime,
    period_type: str,
) -> list:
    """Get summaries of a given type for a time range."""
    rows = db.execute_query(
        """
        SELECT summary_id, content, period_start, period_end
        FROM summaries
        WHERE user_id = :user_id
          AND period_type = :period_type
          AND period_start >= :start_time
          AND period_start < :end_time
        ORDER BY period_start
        """,
        {
            "user_id": str(user_id),
            "period_type": period_type,
            "start_time": start_time,
            "end_time": end_time,
        },
    )

    # Parse content
    for row in rows:
        content = row.get("content")
        if isinstance(content, str):
            try:
                row["content"] = json.loads(content)
            except json.JSONDecodeError:
                row["content"] = {}
        row["summary_text"] = row.get("content", {}).get("summary_text", "")
        row["activity_counts"] = row.get("content", {}).get("activity_counts", {})

    return rows


def _get_user_entity_id(user_id: UUID) -> str:
    """Get or find entity_id for a user."""
    rows = db.execute_query(
        "SELECT entity_id FROM ci.users WHERE id = :user_id",
        {"user_id": str(user_id)},
    )
    if rows and rows[0].get("entity_id"):
        return str(rows[0]["entity_id"])

    # Fallback: find Person entity
    rows = db.execute_query(
        """
        SELECT entity_id FROM entities
        WHERE owner_user_id = :user_id AND entity_type = 'Person'
        ORDER BY created_at LIMIT 1
        """,
        {"user_id": str(user_id)},
    )
    return str(rows[0]["entity_id"]) if rows else None


def _get_entity_dossier(entity_id: str) -> dict:
    """Get dossier for an entity."""
    rows = db.execute_query(
        "SELECT dossier FROM entities WHERE entity_id = :entity_id",
        {"entity_id": entity_id},
    )
    if not rows:
        return None

    dossier = rows[0].get("dossier")
    if isinstance(dossier, dict):
        return dossier
    if isinstance(dossier, str):
        try:
            return json.loads(dossier)
        except json.JSONDecodeError:
            return None
    return None
