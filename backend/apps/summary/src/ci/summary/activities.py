"""
Retriable units of work for summary generation (formerly Temporal activities).

Plain async functions orchestrated by ci.summary.functions and dispatched from
the NestJS pg-boss scheduler through the function runner. They are thin
wrappers around pure functions and database operations.
"""

import json
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import nest_asyncio
import structlog

# Allow nested event loops (needed for run_sync() in async context)
nest_asyncio.apply()

from .action_aggregator import action_aggregator
from .config import settings
from .data_aggregator import aggregator
from .database import db
from .insight_aggregator import insight_aggregator
from .llm_config import get_llm_config
from .summary_functions import (
    generate_actions,
    generate_hourly_summary,
    generate_insights,
    generate_rollup_summary,
    generate_single_insight,
    generate_user_dossier,
)

logger = structlog.get_logger()


# ============================================================================
# Timezone / Window Activities
# ============================================================================


async def resolve_summary_window_activity(
    user_id: str,
    period_type: str,  # 'daily' | 'weekly' | 'monthly'
    reference_iso: str,  # ISO timestamp, typically workflow.now()
) -> dict[str, str]:
    """
    Resolve the user-local ``[start, end)`` window (as UTC instants) and timezone
    for the last complete period before ``reference_iso``.

    Boundaries are computed in the user's ``ci.users.timezone`` so a GMT-5 user's
    "yesterday" is their local yesterday, not the UTC one.  Runs in an activity
    (not the workflow sandbox) so ``zoneinfo`` and DB access are safe.
    """
    from .timezone_utils import get_user_timezone, local_period_window

    tz = get_user_timezone(user_id)
    reference = datetime.fromisoformat(reference_iso.replace("Z", "+00:00"))
    start, end = local_period_window(reference, tz, period_type)
    logger.info(
        "resolved_summary_window",
        user_id=str(user_id)[:8],
        period=period_type,
        tz=tz,
        start=start.isoformat(),
        end=end.isoformat(),
    )
    return {
        "start_time": start.isoformat(),
        "end_time": end.isoformat(),
        "timezone": tz,
    }


# ============================================================================
# Data Aggregation Activities
# ============================================================================


async def aggregate_data_activity(
    user_id: str,
    start_time: str,  # ISO format
    end_time: str,  # ISO format
) -> dict[str, Any]:
    """
    Aggregate user activity data for a time period.

    This activity queries all configured data sources and returns
    aggregated data for summary generation.
    """
    logger.info("aggregating_data", user_id=user_id, start=start_time, end=end_time)

    user_uuid = UUID(user_id)
    start_dt = datetime.fromisoformat(start_time)
    end_dt = datetime.fromisoformat(end_time)

    # Add overlap for context
    overlap = timedelta(minutes=settings.summary_overlap_minutes)
    adjusted_start = start_dt - overlap
    adjusted_end = end_dt + overlap

    # Call pure aggregator function
    aggregated_data = aggregator.aggregate_hour(user_uuid, adjusted_start, adjusted_end)

    logger.info(
        "data_aggregated",
        user_id=user_id,
        total_sources=len(
            [k for k, v in aggregated_data.items() if isinstance(v, list) and v]
        ),
    )

    return aggregated_data


# ============================================================================
# Summary Generation Activities
# ============================================================================


async def generate_hourly_summary_activity(
    aggregated_data: dict[str, Any],
) -> dict[str, Any]:
    """
    Generate hourly summary from aggregated data using LLM.

    This activity calls the LLM to create a summary and is the main
    point where LLM API failures can occur (handled by retry policy).
    """
    logger.info("generating_hourly_summary")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    summary_data = generate_hourly_summary(llm_config, aggregated_data)

    logger.info(
        "hourly_summary_generated",
        tokens_used=summary_data.get("tokens_used", 0),
        has_activity=summary_data.get("activity_counts", {}).get("total", 0) > 0,
    )

    return summary_data


async def generate_rollup_summary_activity(
    period_type: str,
    child_summaries: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Generate rollup summary (daily/weekly/monthly/seasonal/yearly).

    This activity synthesizes child summaries into a higher-level summary.
    """
    logger.info(
        "generating_rollup_summary",
        period_type=period_type,
        child_count=len(child_summaries),
    )

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function
    summary_data = generate_rollup_summary(llm_config, period_type, child_summaries)

    logger.info(
        "rollup_summary_generated",
        period_type=period_type,
        tokens_used=summary_data.get("tokens_used", 0),
    )

    return summary_data


# ============================================================================
# Database Activities - Summaries
# ============================================================================


async def find_existing_summary_activity(
    user_id: str,
    period_type: str,
    start_time: str,
    end_time: str,
) -> dict[str, Any] | None:
    """
    Return an existing summary for the exact user/type/window, if any.

    Newest first. ``summaries_user_window_uniq`` makes this at most one row
    going forward, but an appliance whose duplicates were collapsed by
    migration 20260903162709 keeps the newest of each pair — and this read used
    to ``ORDER BY created_at`` ascending, pinning the OLDEST row (often the one
    generated from a half-imported hour) as the permanent answer for that
    window. Order the two the same way so the survivor is the row callers see.
    """
    rows = db.execute_query(
        """
        SELECT summary_id::text, content
        FROM ci.summaries
        WHERE user_id = :user_id
          AND period_type = :period_type
          AND period_start = :period_start
          AND period_end = :period_end
        ORDER BY created_at DESC NULLS LAST, summary_id DESC
        LIMIT 1
        """,
        {
            "user_id": str(UUID(user_id)),
            "period_type": period_type,
            "period_start": datetime.fromisoformat(start_time),
            "period_end": datetime.fromisoformat(end_time),
        },
    )
    if not rows:
        return None

    row = rows[0]
    content = row.get("content")
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            content = {}

    return {
        "summary_id": row["summary_id"],
        "content": content if isinstance(content, dict) else {},
    }


async def store_summary_activity(
    user_id: str,
    summary_data: dict[str, Any],
    start_time: str,
    end_time: str,
    timezone: str,
) -> str:
    """
    Store a summary in the database, one row per (user, type, window).

    Upsert, not insert. ``hourly_summary`` checks for an existing row before
    doing any work, but a check followed by a bare INSERT is not atomic: the
    :05 cron racing an operator's manual trigger, or two runner workers
    draining a queued backfill, both saw no row and both wrote one. Migration
    20260903162709 added the partial unique index this conflicts against
    (``summaries_user_window_uniq``, every period_type except 'insight', which
    stores one row per card over the same span on purpose), so the race now
    converges on a single row and a forced regeneration overwrites the window
    in place instead of minting a second answer for it.

    Returns the summary_id as a string — the SURVIVING row's id, which for a
    conflict is the id already on disk, not the one minted here.
    """
    logger.info("storing_summary", summary_type=summary_data.get("summary_type"))

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
        key for key, count in activity_counts.items() if key != "total" and count > 0
    ]

    # Prepare embedding (use None if empty)
    embedding = summary_data.get("embedding", [])
    embedding_value = json.dumps(embedding) if embedding else None

    params = {
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
    }

    # `seen` is deliberately NOT overwritten: a regenerated window keeps
    # whatever read state the user already gave it.
    db.execute_write(
        """
        INSERT INTO ci.summaries (
            summary_id, user_id, period_start, period_end, period_type,
            timezone, source_types, title, content, summary_embedding, seen, created_at, updated_at
        ) VALUES (
            :summary_id, :user_id, :period_start, :period_end, :period_type,
            :timezone, :source_types, :title, CAST(:content AS jsonb),
            CASE WHEN :embedding IS NULL THEN NULL ELSE CAST(:embedding AS vector) END, :seen, NOW(), NOW()
        )
        ON CONFLICT (user_id, period_type, period_start, period_end)
            WHERE period_type <> 'insight'
        DO UPDATE SET
            timezone = EXCLUDED.timezone,
            source_types = EXCLUDED.source_types,
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            -- COALESCE, not a straight overwrite: a run whose embedding call failed
            -- arrives as NULL (summarizer returns `embedding: []`), and overwriting
            -- would drop an already-embedded window out of vector search. NULL ->
            -- vector still upgrades when a later retry does produce one.
            summary_embedding = COALESCE(EXCLUDED.summary_embedding, summaries.summary_embedding),
            updated_at = NOW()
        """,
        params,
    )

    # Read the id back rather than trusting the one minted above: on conflict
    # the row that survives is the one already on disk, and callers (and the
    # feed rows keyed on it) must get that id, not an id nothing points at.
    rows = db.execute_query(
        """
        SELECT summary_id::text
        FROM ci.summaries
        WHERE user_id = :user_id
          AND period_type = :period_type
          AND period_start = :period_start
          AND period_end = :period_end
        """,
        {
            "user_id": params["user_id"],
            "period_type": params["period_type"],
            "period_start": start_dt,
            "period_end": end_dt,
        },
    )
    stored_id = rows[0]["summary_id"] if rows else str(summary_id)

    logger.info("summary_stored", summary_id=stored_id, type=summary_type)

    return stored_id


async def fetch_child_summaries_activity(
    user_id: str,
    start_time: str,
    end_time: str,
    period_type: str,
) -> list[dict[str, Any]]:
    """
    Fetch child summaries for rollup generation.

    For example, fetch hourly summaries to create daily summary,
    or daily summaries to create weekly summary.
    """
    logger.info("fetching_child_summaries", period_type=period_type)

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

    logger.info("child_summaries_fetched", count=len(rows))

    return rows


# ============================================================================
# Database Activities - Dossier
# ============================================================================


async def get_entity_id_activity(user_id: str) -> str | None:
    """
    Get or find entity_id for a user.

    Returns entity_id or None if not found.
    """
    logger.info("getting_entity_id", user_id=user_id)

    user_uuid = UUID(user_id)

    # Try from users table first
    rows = db.execute_query(
        "SELECT entity_id FROM ci.users WHERE id = :user_id",
        {"user_id": str(user_uuid)},
    )
    if rows and rows[0].get("entity_id"):
        entity_id = str(rows[0]["entity_id"])
        logger.info("entity_id_found_from_users", entity_id=entity_id)
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
        logger.info("entity_id_found_from_entities", entity_id=entity_id)
        return entity_id

    logger.warning("entity_id_not_found", user_id=user_id)
    return None


async def fetch_previous_dossier_activity(entity_id: str) -> dict[str, Any] | None:
    """
    Fetch the previous dossier for an entity.

    Returns the dossier dict or None if not found.
    """
    logger.info("fetching_previous_dossier", entity_id=entity_id)

    rows = db.execute_query(
        "SELECT dossier FROM entities WHERE entity_id = :entity_id",
        {"entity_id": entity_id},
    )

    if not rows:
        logger.info("no_previous_dossier_found")
        return None

    dossier = rows[0].get("dossier")

    if isinstance(dossier, dict):
        logger.info("previous_dossier_fetched")
        return dossier

    if isinstance(dossier, str):
        try:
            parsed = json.loads(dossier)
            logger.info("previous_dossier_parsed")
            return parsed
        except json.JSONDecodeError:
            logger.warning("dossier_parse_failed")
            return None

    logger.info("no_dossier_data")
    return None


async def fetch_summaries_for_dossier_activity(
    user_id: str,
    lookback_days: int,
    end_time: str,
) -> dict[str, list[dict[str, Any]]]:
    """
    Fetch recent summaries for dossier generation.

    Returns dict with 'daily' and 'hourly' summary lists.
    """
    logger.info("fetching_summaries_for_dossier", lookback_days=lookback_days)

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

    logger.info(
        "summaries_fetched_for_dossier",
        daily_count=len(daily_rows),
        hourly_count=len(hourly_rows),
    )

    return {
        "daily": daily_rows[-30:],  # Last 30 days max
        "hourly": hourly_rows[-24:],  # Last 24 hours max
    }


async def generate_dossier_activity(
    user_id: str,
    daily_summaries: list[dict[str, Any]],
    hourly_summaries: list[dict[str, Any]],
    end_time: str,
    timezone: str,
    lookback_days: int,
    previous_dossier: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Generate user dossier from summaries using LLM.

    Returns the dossier payload ready to be stored.
    """
    logger.info(
        "generating_dossier",
        daily_count=len(daily_summaries),
        hourly_count=len(hourly_summaries),
    )

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

    logger.info("dossier_generated")

    return dossier


async def store_dossier_activity(
    entity_id: str,
    dossier: dict[str, Any],
) -> None:
    """
    Store dossier in the entities table.
    """
    logger.info("storing_dossier", entity_id=entity_id)

    db.execute_write(
        """
        UPDATE entities
        SET dossier = CAST(:dossier AS jsonb), updated_at = NOW()
        WHERE entity_id = :entity_id
        """,
        {"entity_id": entity_id, "dossier": json.dumps(dossier)},
    )

    logger.info("dossier_stored", entity_id=entity_id)


# ============================================================================
# Insight Generation Activities
# ============================================================================


async def check_new_data_for_insights_activity(
    user_id: str,
    since: str,  # ISO format
) -> bool:
    """
    Check if there's new data worth generating insights for.

    Returns True if new graph deltas, events, or summaries exist since the given time.
    """
    logger.info("checking_new_data_for_insights", user_id=user_id, since=since)

    user_uuid = UUID(user_id)
    since_dt = datetime.fromisoformat(since)

    has_new_data = insight_aggregator.has_new_data(user_uuid, since_dt)

    logger.info("new_data_check_complete", user_id=user_id, has_new_data=has_new_data)
    return has_new_data


async def get_last_insight_time_activity(user_id: str) -> str | None:
    """
    Get the timestamp of the last generated insight for this user.

    Returns ISO format timestamp or None if no insights exist.
    """
    logger.info("getting_last_insight_time", user_id=user_id)

    user_uuid = UUID(user_id)
    last_time = insight_aggregator.get_last_insight_time(user_uuid)

    if last_time:
        logger.info(
            "last_insight_time_found", user_id=user_id, last_time=last_time.isoformat()
        )
        return last_time.isoformat()

    logger.info("no_previous_insights", user_id=user_id)
    return None


async def aggregate_insights_context_activity(
    user_id: str,
    since: str,  # ISO format
    until: str,  # ISO format
) -> dict[str, Any]:
    """
    Aggregate all context needed for insight generation.

    Collects graph deltas, upcoming events, recent summaries,
    relevant relationships, and communications.
    """
    logger.info(
        "aggregating_insights_context", user_id=user_id, since=since, until=until
    )

    user_uuid = UUID(user_id)
    since_dt = datetime.fromisoformat(since)
    until_dt = datetime.fromisoformat(until)

    context = insight_aggregator.aggregate_insights_context(
        user_uuid, since_dt, until_dt
    )

    logger.info(
        "insights_context_aggregated",
        user_id=user_id,
        graph_deltas=len(context.get("graph_deltas", [])),
        upcoming_events=len(context.get("upcoming_events", [])),
        recent_summaries=len(context.get("recent_summaries", [])),
    )

    return context


async def generate_insights_activity(
    insights_context: dict[str, Any],
) -> dict[str, Any]:
    """
    Generate proactive insights from aggregated context using LLM.

    Returns insights data ready for storage.
    """
    logger.info("generating_insights")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function. Insights are a proactive, best-effort feature: a flaky
    # local model that can't produce schema-valid output should not fail the
    # run (and trigger pg-boss's retry storm). Return an empty result so
    # the caller's num_insights==0 branch skips gracefully.
    try:
        insights_data = generate_insights(llm_config, insights_context)
    except Exception as exc:
        # Loud on purpose: this swallow is the reason "insights never show up"
        # went undiagnosed. The workflow still skips gracefully, but the error
        # (with traceback) must be visible in the logs.
        logger.error(
            "insights_generation_failed_nonfatal error=%s error_type=%s output_mode=%s",
            exc,
            type(exc).__name__,
            settings.output_mode,
            exc_info=True,
        )
        return {
            "insights": [],
            "data_sources_used": [],
            "embedding": None,
            "tokens_used": 0,
            "num_insights": 0,
            "skipped": True,
            "reason": "generation_failed",
        }

    logger.info(
        "insights_generated",
        num_insights=insights_data.get("num_insights", 0),
        tokens_used=insights_data.get("tokens_used", 0),
    )

    return insights_data


async def generate_single_insight_activity(
    insights_context: dict[str, Any],
    prior_insights: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Generate ONE insight, distinct from the prior ones (incremental generation).

    The workflow loops over this activity and stores each insight as it lands,
    so insights appear on the feed one by one. A failure here is loud but
    non-fatal: any insights already stored this run stay stored, and the loop
    simply ends.
    """
    logger.info("generating_single_insight num_prior=%d", len(prior_insights))

    llm_config = get_llm_config()

    try:
        return generate_single_insight(llm_config, insights_context, prior_insights)
    except Exception as exc:
        logger.error(
            "single_insight_generation_failed_nonfatal error=%s error_type=%s output_mode=%s",
            exc,
            type(exc).__name__,
            settings.output_mode,
            exc_info=True,
        )
        return {
            "insight": None,
            "data_sources_used": [],
            "embedding": None,
            "tokens_used": 0,
            "skipped": True,
            "reason": "generation_failed",
        }


async def aggregate_action_context_activity(
    user_id: str,
    lookback_days: int = 7,
) -> dict[str, Any]:
    """
    Aggregate context needed for action card generation.

    Collects summaries, insights, events, and key people rather than
    raw data like graph deltas. This produces higher-level context
    for conversation starters and time suggestions.
    """
    logger.info(
        "aggregating_action_context", user_id=user_id, lookback_days=lookback_days
    )

    user_uuid = UUID(user_id)

    context = action_aggregator.aggregate_action_context(user_uuid, lookback_days)

    logger.info(
        "action_context_aggregated",
        user_id=user_id,
        recent_summaries=len(context.get("recent_summaries", [])),
        recent_insights=len(context.get("recent_insights", [])),
        upcoming_events=len(context.get("upcoming_events", [])),
        key_people=len(context.get("key_people", [])),
    )

    return context


async def generate_actions_activity(
    action_context: dict[str, Any],
) -> dict[str, Any]:
    """
    Generate action cards from aggregated context using LLM.

    Returns conversation starters and time suggestions.
    """
    logger.info("generating_actions")

    # Create LLM config
    llm_config = get_llm_config()

    # Call pure function. Action cards are proactive/best-effort — don't fail the
    # workflow when a local model can't produce schema-valid output; return empty
    # so the workflow's num_actions==0 branch skips gracefully.
    try:
        actions_data = generate_actions(llm_config, action_context)
    except Exception as exc:
        logger.error(
            "actions_generation_failed_nonfatal error=%s error_type=%s output_mode=%s",
            exc,
            type(exc).__name__,
            settings.output_mode,
            exc_info=True,
        )
        return {
            "actions": [],
            "tokens_used": 0,
            "skipped": True,
            "reason": "generation_failed",
        }

    logger.info(
        "actions_generated",
        num_actions=len(actions_data.get("actions", [])),
        tokens_used=actions_data.get("tokens_used", 0),
    )

    return actions_data


async def count_pending_actions_activity(user_id: str) -> int:
    """
    Count the actions currently occupying slots on the user's feed.

    The feed shows unseen, undismissed actions first (see ActionService.findForFeed),
    so those are the ones that consume the feed's card budget. Seen-but-undismissed
    actions are only used as filler and are not counted here — otherwise a user who
    stops dismissing would permanently block new generation.
    """
    logger.info("counting_pending_actions", user_id=user_id)

    rows = db.execute_query(
        """
        SELECT COUNT(*) AS pending
        FROM ci.actions
        WHERE user_id = :user_id
          AND dismissed = false
          AND seen = false
        """,
        {"user_id": str(UUID(user_id))},
    )

    pending = int(rows[0]["pending"]) if rows else 0

    logger.info("pending_actions_counted", user_id=user_id, pending=pending)

    return pending


async def store_action_activity(
    user_id: str,
    actions_data: dict[str, Any],
) -> list[str]:
    """
    Store generated actions in the ci.actions table.

    Each action is stored as a separate row with a dedicated seen column plus
    metadata for action type and additional payload.

    Returns list of action_ids for all stored actions.
    """
    actions_list = actions_data.get("actions", [])
    num_actions = len(actions_list)

    logger.info("storing_actions", num_actions=num_actions)

    if not actions_list:
        logger.info("no_actions_to_store")
        return []

    user_uuid = UUID(user_id)

    # Prepare all inserts for transaction
    writes: list[tuple[str, dict[str, Any]]] = []
    action_ids: list[str] = []

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
    db.execute_writes_in_transaction(writes)

    logger.info(
        "actions_stored",
        num_actions=num_actions,
        action_ids=action_ids,
    )

    return action_ids


async def store_insight_activity(
    user_id: str,
    insights_data: dict[str, Any],
    start_time: str,
    end_time: str,
    timezone: str,
) -> list[str]:
    """
    Store generated insights as individual summaries with period_type='insight'.

    Each insight is stored as a separate row to enable individual tracking,
    tagging, and relationship linking.

    Returns list of summary_ids for all stored insights.
    """
    insights_list = insights_data.get("insights", [])
    num_insights = len(insights_list)

    logger.info("storing_insights", num_insights=num_insights)

    if not insights_list:
        logger.info("no_insights_to_store")
        return []

    user_uuid = UUID(user_id)
    start_dt = datetime.fromisoformat(start_time)
    end_dt = datetime.fromisoformat(end_time)

    source_types = insights_data.get(
        "data_sources_used", ["graph_deltas", "events", "summaries"]
    )
    total_tokens = insights_data.get("tokens_used", 0)
    tokens_per_insight = total_tokens // num_insights if num_insights > 0 else 0
    embedding = insights_data.get("embedding", [])
    embedding_value = json.dumps(embedding) if embedding else None

    # Prepare all inserts for transaction
    writes: list[tuple[str, dict[str, Any]]] = []
    summary_ids: list[str] = []

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
    db.execute_writes_in_transaction(writes)

    logger.info(
        "insights_stored",
        num_insights=num_insights,
        summary_ids=summary_ids,
    )

    return summary_ids


__all__ = [
    # Action activities
    "aggregate_action_context_activity",
    "aggregate_data_activity",
    "aggregate_insights_context_activity",
    # Insight activities
    "check_new_data_for_insights_activity",
    "count_pending_actions_activity",
    "fetch_child_summaries_activity",
    "fetch_previous_dossier_activity",
    "fetch_summaries_for_dossier_activity",
    "find_existing_summary_activity",
    "generate_actions_activity",
    "generate_dossier_activity",
    "generate_hourly_summary_activity",
    "generate_insights_activity",
    "generate_rollup_summary_activity",
    "generate_single_insight_activity",
    "get_entity_id_activity",
    "get_last_insight_time_activity",
    "store_action_activity",
    "store_dossier_activity",
    "store_insight_activity",
    "store_summary_activity",
]
