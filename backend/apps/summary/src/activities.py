"""
Temporal activities for summary generation.

Activities are retriable units of work that can fail and be retried.
They are thin wrappers around pure functions and database operations.
"""
import json
import structlog
import nest_asyncio
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
from uuid import UUID, uuid4
from temporalio import activity

# Allow nested event loops (needed for run_sync() in async activity context)
nest_asyncio.apply()

from .config import settings
from .data_aggregator import aggregator
from .database import db
from .insight_aggregator import insight_aggregator
from .action_aggregator import action_aggregator
from .llm_config import LLMConfig, get_llm_config
from .summary_functions import (
    generate_hourly_summary,
    generate_rollup_summary,
    generate_user_dossier,
    generate_user_dossier,
    generate_insights,
    generate_actions,
)

logger = structlog.get_logger()


# ============================================================================
# Data Aggregation Activities
# ============================================================================

@activity.defn
async def aggregate_data_activity(
    user_id: str,
    start_time: str,  # ISO format
    end_time: str,    # ISO format
) -> Dict[str, Any]:
    """
    Aggregate user activity data for a time period.

    This activity queries all configured data sources and returns
    aggregated data for summary generation.
    """
    activity.logger.info("aggregating_data", user_id=user_id, start=start_time, end=end_time)

    # Send heartbeat for long-running operation
    activity.heartbeat("Starting data aggregation")

    user_uuid = UUID(user_id)
    start_dt = datetime.fromisoformat(start_time)
    end_dt = datetime.fromisoformat(end_time)

    # Add overlap for context
    overlap = timedelta(minutes=settings.summary_overlap_minutes)
    adjusted_start = start_dt - overlap
    adjusted_end = end_dt + overlap

    # Call pure aggregator function
    aggregated_data = aggregator.aggregate_hour(user_uuid, adjusted_start, adjusted_end)

    activity.heartbeat("Data aggregation complete")

    activity.logger.info(
        "data_aggregated",
        user_id=user_id,
        total_sources=len([k for k, v in aggregated_data.items() if isinstance(v, list) and v])
    )

    return aggregated_data


# ============================================================================
# Summary Generation Activities
# ============================================================================

@activity.defn
async def generate_hourly_summary_activity(
    aggregated_data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Generate hourly summary from aggregated data using LLM.

    This activity calls the LLM to create a summary and is the main
    point where LLM API failures can occur (handled by retry policy).
    """
    activity.logger.info("generating_hourly_summary")
    activity.heartbeat("Calling LLM for hourly summary")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    summary_data = generate_hourly_summary(llm_config, aggregated_data)

    activity.heartbeat("Hourly summary generated")
    activity.logger.info(
        "hourly_summary_generated",
        tokens_used=summary_data.get("tokens_used", 0),
        has_activity=summary_data.get("activity_counts", {}).get("total", 0) > 0
    )

    return summary_data


@activity.defn
async def generate_rollup_summary_activity(
    period_type: str,
    child_summaries: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Generate rollup summary (daily/weekly/monthly/seasonal/yearly).

    This activity synthesizes child summaries into a higher-level summary.
    """
    activity.logger.info("generating_rollup_summary", period_type=period_type, child_count=len(child_summaries))
    activity.heartbeat(f"Generating {period_type} summary")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    summary_data = generate_rollup_summary(llm_config, period_type, child_summaries)

    activity.heartbeat(f"{period_type.title()} summary generated")
    activity.logger.info(
        "rollup_summary_generated",
        period_type=period_type,
        tokens_used=summary_data.get("tokens_used", 0)
    )

    return summary_data


# ============================================================================
# Database Activities - Summaries
# ============================================================================

@activity.defn
async def store_summary_activity(
    user_id: str,
    summary_data: Dict[str, Any],
    start_time: str,
    end_time: str,
    timezone: str,
) -> str:
    """
    Store a summary in the database.

    Returns the summary_id as a string.
    """
    activity.logger.info("storing_summary", summary_type=summary_data.get("summary_type"))
    activity.heartbeat("Storing summary to database")

    user_uuid = UUID(user_id)
    start_dt = datetime.fromisoformat(start_time)
    end_dt = datetime.fromisoformat(end_time)

    summary_id = uuid4()
    summary_type = summary_data.get("summary_type", "unknown")

    # Build content payload
    content = {
        "summary_text": summary_data.get("summary_text", ""),
        "key_insights": summary_data.get("key_insights", []),
        "activity_counts": summary_data.get("activity_counts", {}),
        "tokens_used": summary_data.get("tokens_used", 0),
    }

    # Include structured data if present (time-scale specific fields)
    if "structured_data" in summary_data:
        content["structured_data"] = summary_data["structured_data"]

    # Determine source types from activity counts
    activity_counts = summary_data.get("activity_counts", {})
    source_types = [
        key for key, count in activity_counts.items()
        if key != "total" and count > 0
    ]

    # Prepare embedding (use None if empty)
    embedding = summary_data.get("embedding", [])
    embedding_value = json.dumps(embedding) if embedding else None

    # Insert
    db.execute_write(
        """
        INSERT INTO summaries (
            summary_id, user_id, period_start, period_end, period_type,
            timezone, source_types, title, content, summary_embedding, seen, created_at, updated_at
        ) VALUES (
            :summary_id, :user_id, :period_start, :period_end, :period_type,
            :timezone, :source_types, :title, CAST(:content AS jsonb),
            CASE WHEN :embedding IS NULL THEN NULL ELSE CAST(:embedding AS vector) END, :seen, NOW(), NOW()
        )
        """,
        {
            "summary_id": str(summary_id),
            "user_id": str(user_uuid),
            "period_start": start_dt,
            "period_end": end_dt,
            "period_type": summary_type,
            "timezone": timezone,
            "source_types": source_types,
            "title": f"{summary_type.title()} Summary",
            "content": json.dumps(content),
            "embedding": embedding_value,
            "seen": bool(summary_data.get("seen", False)),
        },
    )

    activity.heartbeat("Summary stored")
    activity.logger.info("summary_stored", summary_id=str(summary_id), type=summary_type)

    return str(summary_id)


@activity.defn
async def fetch_child_summaries_activity(
    user_id: str,
    start_time: str,
    end_time: str,
    period_type: str,
) -> List[Dict[str, Any]]:
    """
    Fetch child summaries for rollup generation.

    For example, fetch hourly summaries to create daily summary,
    or daily summaries to create weekly summary.
    """
    activity.logger.info("fetching_child_summaries", period_type=period_type)
    activity.heartbeat(f"Fetching {period_type} summaries")

    user_uuid = UUID(user_id)
    start_dt = datetime.fromisoformat(start_time)
    end_dt = datetime.fromisoformat(end_time)

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
            "user_id": str(user_uuid),
            "period_type": period_type,
            "start_time": start_dt,
            "end_time": end_dt,
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

    activity.heartbeat(f"Found {len(rows)} {period_type} summaries")
    activity.logger.info("child_summaries_fetched", count=len(rows))

    return rows


# ============================================================================
# Database Activities - Dossier
# ============================================================================

@activity.defn
async def get_entity_id_activity(user_id: str) -> Optional[str]:
    """
    Get or find entity_id for a user.

    Returns entity_id or None if not found.
    """
    activity.logger.info("getting_entity_id", user_id=user_id)
    activity.heartbeat("Looking up entity ID")

    user_uuid = UUID(user_id)

    # Try from users table first
    rows = db.execute_query(
        "SELECT entity_id FROM ci.users WHERE id = :user_id",
        {"user_id": str(user_uuid)},
    )
    if rows and rows[0].get("entity_id"):
        entity_id = str(rows[0]["entity_id"])
        activity.logger.info("entity_id_found_from_users", entity_id=entity_id)
        return entity_id

    # Fallback: find Person entity
    rows = db.execute_query(
        """
        SELECT entity_id FROM entities
        WHERE owner_user_id = :user_id AND entity_type = 'Person'
        ORDER BY created_at LIMIT 1
        """,
        {"user_id": str(user_uuid)},
    )

    if rows:
        entity_id = str(rows[0]["entity_id"])
        activity.logger.info("entity_id_found_from_entities", entity_id=entity_id)
        return entity_id

    activity.logger.warning("entity_id_not_found", user_id=user_id)
    return None


@activity.defn
async def fetch_previous_dossier_activity(entity_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetch the previous dossier for an entity.

    Returns the dossier dict or None if not found.
    """
    activity.logger.info("fetching_previous_dossier", entity_id=entity_id)
    activity.heartbeat("Fetching previous dossier")

    rows = db.execute_query(
        "SELECT dossier FROM entities WHERE entity_id = :entity_id",
        {"entity_id": entity_id},
    )

    if not rows:
        activity.logger.info("no_previous_dossier_found")
        return None

    dossier = rows[0].get("dossier")

    if isinstance(dossier, dict):
        activity.logger.info("previous_dossier_fetched")
        return dossier

    if isinstance(dossier, str):
        try:
            parsed = json.loads(dossier)
            activity.logger.info("previous_dossier_parsed")
            return parsed
        except json.JSONDecodeError:
            activity.logger.warning("dossier_parse_failed")
            return None

    activity.logger.info("no_dossier_data")
    return None


@activity.defn
async def fetch_summaries_for_dossier_activity(
    user_id: str,
    lookback_days: int,
    end_time: str,
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Fetch recent summaries for dossier generation.

    Returns dict with 'daily' and 'hourly' summary lists.
    """
    activity.logger.info("fetching_summaries_for_dossier", lookback_days=lookback_days)
    activity.heartbeat("Fetching recent summaries")

    user_uuid = UUID(user_id)
    end_dt = datetime.fromisoformat(end_time)
    daily_start = end_dt - timedelta(days=lookback_days)
    hourly_start = end_dt - timedelta(days=1)

    # Fetch daily summaries
    daily_rows = db.execute_query(
        """
        SELECT summary_id, content, period_start, period_end
        FROM summaries
        WHERE user_id = :user_id
          AND period_type = 'daily'
          AND period_start >= :start
          AND period_start < :end
        ORDER BY period_start
        """,
        {"user_id": str(user_uuid), "start": daily_start, "end": end_dt},
    )

    # Fetch hourly summaries (last 24 hours)
    hourly_rows = db.execute_query(
        """
        SELECT summary_id, content, period_start, period_end
        FROM summaries
        WHERE user_id = :user_id
          AND period_type = 'hourly'
          AND period_start >= :start
          AND period_start < :end
        ORDER BY period_start
        """,
        {"user_id": str(user_uuid), "start": hourly_start, "end": end_dt},
    )

    # Parse content for both
    for row in daily_rows + hourly_rows:
        content = row.get("content")
        if isinstance(content, str):
            try:
                row["content"] = json.loads(content)
            except json.JSONDecodeError:
                row["content"] = {}
        row["summary_text"] = row.get("content", {}).get("summary_text", "")
        row["activity_counts"] = row.get("content", {}).get("activity_counts", {})

    activity.heartbeat(f"Found {len(daily_rows)} daily, {len(hourly_rows)} hourly summaries")
    activity.logger.info(
        "summaries_fetched_for_dossier",
        daily_count=len(daily_rows),
        hourly_count=len(hourly_rows)
    )

    return {
        "daily": daily_rows[-30:],  # Last 30 days max
        "hourly": hourly_rows[-24:],  # Last 24 hours max
    }


@activity.defn
async def generate_dossier_activity(
    user_id: str,
    daily_summaries: List[Dict[str, Any]],
    hourly_summaries: List[Dict[str, Any]],
    end_time: str,
    timezone: str,
    lookback_days: int,
    previous_dossier: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Generate user dossier from summaries using LLM.

    Returns the dossier payload ready to be stored.
    """
    activity.logger.info(
        "generating_dossier",
        daily_count=len(daily_summaries),
        hourly_count=len(hourly_summaries)
    )
    activity.heartbeat("Calling LLM for dossier generation")

    end_dt = datetime.fromisoformat(end_time)
    lookback_start = end_dt - timedelta(days=lookback_days)

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    dossier = generate_user_dossier(
        llm_config,
        user_id,
        daily_summaries,
        hourly_summaries,
        previous_dossier,
        lookback_start=lookback_start,
        lookback_end=end_dt,
        timezone=timezone,
        max_chars=settings.dossier_max_chars,
    )

    activity.heartbeat("Dossier generated")
    activity.logger.info("dossier_generated")

    return dossier


@activity.defn
async def store_dossier_activity(
    entity_id: str,
    dossier: Dict[str, Any],
) -> None:
    """
    Store dossier in the entities table.
    """
    activity.logger.info("storing_dossier", entity_id=entity_id)
    activity.heartbeat("Storing dossier to database")

    db.execute_write(
        """
        UPDATE entities
        SET dossier = CAST(:dossier AS jsonb), updated_at = NOW()
        WHERE entity_id = :entity_id
        """,
        {"entity_id": entity_id, "dossier": json.dumps(dossier)},
    )

    activity.heartbeat("Dossier stored")
    activity.logger.info("dossier_stored", entity_id=entity_id)


# ============================================================================
# Insight Generation Activities
# ============================================================================

@activity.defn
async def check_new_data_for_insights_activity(
    user_id: str,
    since: str,  # ISO format
) -> bool:
    """
    Check if there's new data worth generating insights for.

    Returns True if new graph deltas, events, or summaries exist since the given time.
    """
    activity.logger.info("checking_new_data_for_insights", user_id=user_id, since=since)
    activity.heartbeat("Checking for new data")

    user_uuid = UUID(user_id)
    since_dt = datetime.fromisoformat(since)

    has_new_data = insight_aggregator.has_new_data(user_uuid, since_dt)

    activity.logger.info("new_data_check_complete", user_id=user_id, has_new_data=has_new_data)
    return has_new_data


@activity.defn
async def get_last_insight_time_activity(user_id: str) -> Optional[str]:
    """
    Get the timestamp of the last generated insight for this user.

    Returns ISO format timestamp or None if no insights exist.
    """
    activity.logger.info("getting_last_insight_time", user_id=user_id)
    activity.heartbeat("Looking up last insight time")

    user_uuid = UUID(user_id)
    last_time = insight_aggregator.get_last_insight_time(user_uuid)

    if last_time:
        activity.logger.info("last_insight_time_found", user_id=user_id, last_time=last_time.isoformat())
        return last_time.isoformat()

    activity.logger.info("no_previous_insights", user_id=user_id)
    return None


@activity.defn
async def aggregate_insights_context_activity(
    user_id: str,
    since: str,  # ISO format
    until: str,  # ISO format
) -> Dict[str, Any]:
    """
    Aggregate all context needed for insight generation.

    Collects graph deltas, upcoming events, recent summaries,
    relevant relationships, and communications.
    """
    activity.logger.info("aggregating_insights_context", user_id=user_id, since=since, until=until)
    activity.heartbeat("Aggregating insights context")

    user_uuid = UUID(user_id)
    since_dt = datetime.fromisoformat(since)
    until_dt = datetime.fromisoformat(until)

    context = insight_aggregator.aggregate_insights_context(user_uuid, since_dt, until_dt)

    activity.heartbeat("Insights context aggregated")
    activity.logger.info(
        "insights_context_aggregated",
        user_id=user_id,
        graph_deltas=len(context.get("graph_deltas", [])),
        upcoming_events=len(context.get("upcoming_events", [])),
        recent_summaries=len(context.get("recent_summaries", [])),
    )

    return context


@activity.defn
async def generate_insights_activity(
    insights_context: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Generate proactive insights from aggregated context using LLM.

    Returns insights data ready for storage.
    """
    activity.logger.info("generating_insights")
    activity.heartbeat("Calling LLM for insights generation")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    insights_data = generate_insights(llm_config, insights_context)

    activity.heartbeat("Insights generated")
    activity.logger.info(
        "insights_generated",
        num_insights=insights_data.get("num_insights", 0),
        tokens_used=insights_data.get("tokens_used", 0),
    )

    return insights_data


@activity.defn
async def aggregate_action_context_activity(
    user_id: str,
    lookback_days: int = 7,
) -> Dict[str, Any]:
    """
    Aggregate context needed for action card generation.

    Collects summaries, insights, events, and key people rather than
    raw data like graph deltas. This produces higher-level context
    for conversation starters and time suggestions.
    """
    activity.logger.info("aggregating_action_context", user_id=user_id, lookback_days=lookback_days)
    activity.heartbeat("Aggregating action context")

    user_uuid = UUID(user_id)

    context = action_aggregator.aggregate_action_context(user_uuid, lookback_days)

    activity.heartbeat("Action context aggregated")
    activity.logger.info(
        "action_context_aggregated",
        user_id=user_id,
        recent_summaries=len(context.get("recent_summaries", [])),
        recent_insights=len(context.get("recent_insights", [])),
        upcoming_events=len(context.get("upcoming_events", [])),
        key_people=len(context.get("key_people", [])),
    )

    return context


@activity.defn
async def generate_actions_activity(
    action_context: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Generate action cards from aggregated context using LLM.

    Returns conversation starters and time suggestions.
    """
    activity.logger.info("generating_actions")
    activity.heartbeat("Calling LLM for actions generation")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    actions_data = generate_actions(llm_config, action_context)

    activity.heartbeat("Actions generated")
    activity.logger.info(
        "actions_generated",
        num_actions=len(actions_data.get("actions", [])),
        tokens_used=actions_data.get("tokens_used", 0),
    )

    return actions_data


@activity.defn
async def store_action_activity(
    user_id: str,
    actions_data: Dict[str, Any],
) -> List[str]:
    """
    Store generated actions in the ci.actions table.

    Each action is stored as a separate row with a dedicated seen column plus
    metadata for action type and additional payload.

    Returns list of action_ids for all stored actions.
    """
    actions_list = actions_data.get("actions", [])
    num_actions = len(actions_list)

    activity.logger.info("storing_actions", num_actions=num_actions)
    activity.heartbeat("Storing actions to database")

    if not actions_list:
        activity.logger.info("no_actions_to_store")
        return []

    user_uuid = UUID(user_id)

    # Prepare all inserts for transaction
    writes: List[tuple[str, Dict[str, Any]]] = []
    action_ids: List[str] = []

    insert_query = """
        INSERT INTO ci.actions (
            id, title, text, priority, user_id, seen, metadata, created_at, updated_at
        ) VALUES (
            :action_id, :title, :text, :priority, :user_id, :seen,
            CAST(:metadata AS jsonb), NOW(), NOW()
        )
    """

    for action in actions_list:
        action_id = str(uuid4())
        action_ids.append(action_id)

        # Build metadata with type, context, and related_person
        metadata = {
            "type": action.get("type", "general"),
            "context": action.get("context"),
            "related_person": action.get("related_person"),
            "tags": action.get("tags", []),
        }

        params = {
            "action_id": action_id,
            "title": action.get("title", ""),
            "text": action.get("text", ""),
            "priority": action.get("priority", 5),
            "user_id": str(user_uuid),
            "seen": False,
            "metadata": json.dumps(metadata),
        }

        writes.append((insert_query, params))

    # Execute all inserts in a single transaction
    activity.heartbeat(f"Inserting {num_actions} actions in transaction")
    db.execute_writes_in_transaction(writes)

    activity.heartbeat("Actions stored")
    activity.logger.info(
        "actions_stored",
        num_actions=num_actions,
        action_ids=action_ids,
    )

    return action_ids


@activity.defn
async def store_insight_activity(
    user_id: str,
    insights_data: Dict[str, Any],
    start_time: str,
    end_time: str,
    timezone: str,
) -> List[str]:
    """
    Store generated insights as individual summaries with period_type='insight'.

    Each insight is stored as a separate row to enable individual tracking,
    tagging, and relationship linking.

    Returns list of summary_ids for all stored insights.
    """
    insights_list = insights_data.get("insights", [])
    num_insights = len(insights_list)

    activity.logger.info("storing_insights", num_insights=num_insights)
    activity.heartbeat("Storing insights to database")

    if not insights_list:
        activity.logger.info("no_insights_to_store")
        return []

    user_uuid = UUID(user_id)
    start_dt = datetime.fromisoformat(start_time)
    end_dt = datetime.fromisoformat(end_time)

    source_types = insights_data.get("data_sources_used", ["graph_deltas", "events", "summaries"])
    total_tokens = insights_data.get("tokens_used", 0)
    tokens_per_insight = total_tokens // num_insights if num_insights > 0 else 0
    embedding = insights_data.get("embedding", [])
    embedding_value = json.dumps(embedding) if embedding else None

    # Prepare all inserts for transaction
    writes: List[tuple[str, Dict[str, Any]]] = []
    summary_ids: List[str] = []

    insert_query = """
        INSERT INTO ci.summaries (
            summary_id, user_id, period_start, period_end, period_type,
            timezone, source_types, title, content, structured_context,
            tags, participants, confidence_score, summary_embedding, seen, metadata, created_at, updated_at
        ) VALUES (
            :summary_id, :user_id, :period_start, :period_end, 'insight',
            :timezone, :source_types, :title, CAST(:content AS jsonb),
            CAST(:structured_context AS jsonb), CAST(:tags AS jsonb),
            CAST(:participants AS uuid[]), :confidence_score,
            CASE WHEN :embedding IS NULL THEN NULL ELSE CAST(:embedding AS vector) END, :seen,
            CAST(:metadata AS jsonb), NOW(), NOW()
        )
    """

    for insight in insights_list:
        summary_id = str(uuid4())
        summary_ids.append(summary_id)

        # Extract and validate participant UUIDs
        participants_list = []
        related_ids = insight.get("related_entity_ids", [])
        if related_ids:
            for entity_id in related_ids:
                try:
                    UUID(str(entity_id))
                    participants_list.append(str(entity_id))
                except (ValueError, TypeError):
                    pass

        # Content: lightweight payload for UI consumption
        content = {
            "summary_text": insight.get("summary_text", ""),
            "key_actions": insight.get("key_actions", []),
            "tokens_used": tokens_per_insight,
            "data_sources_used": source_types,
        }

        metadata = {
            "relevance_score": insight.get("relevance_score", 0),
        }

        params = {
            "summary_id": summary_id,
            "user_id": str(user_uuid),
            "period_start": start_dt,
            "period_end": end_dt,
            "timezone": timezone,
            "source_types": source_types,
            "title": insight.get("title", "Proactive Insight"),
            "content": json.dumps(content),
            "structured_context": json.dumps(insight),
            "tags": json.dumps(insight.get("tags", [])),
            "participants": participants_list,
            "confidence_score": insight.get("relevance_score", 0),
            "embedding": embedding_value,
            "seen": False,
            "metadata": json.dumps(metadata),
        }

        writes.append((insert_query, params))

    # Execute all inserts in a single transaction
    activity.heartbeat(f"Inserting {num_insights} insights in transaction")
    db.execute_writes_in_transaction(writes)

    activity.heartbeat("Insights stored")
    activity.logger.info(
        "insights_stored",
        num_insights=num_insights,
        summary_ids=summary_ids,
    )

    return summary_ids


__all__ = [
    "aggregate_data_activity",
    "generate_hourly_summary_activity",
    "generate_rollup_summary_activity",
    "store_summary_activity",
    "fetch_child_summaries_activity",
    "get_entity_id_activity",
    "fetch_previous_dossier_activity",
    "fetch_summaries_for_dossier_activity",
    "generate_dossier_activity",
    "store_dossier_activity",
    # Insight activities
    "check_new_data_for_insights_activity",
    "get_last_insight_time_activity",
    "aggregate_insights_context_activity",
    "generate_insights_activity",
    "store_insight_activity",
    # Action activities
    "aggregate_action_context_activity",
    "generate_actions_activity",
    "store_action_activity",
]
