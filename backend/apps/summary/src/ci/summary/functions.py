"""
Named background functions for the summary service.

These are the former Temporal workflow bodies as plain async functions. The
NestJS API schedules them through pg-boss and dispatches each run to
``POST /functions/run`` (see runner.py); the manual API endpoints call them
directly. Each function is idempotent-ish per (user, window): summaries and
insights upsert-or-append, so a pg-boss retry after a mid-run crash re-runs the
whole function safely.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import structlog

from .activities import (
    aggregate_action_context_activity,
    aggregate_data_activity,
    aggregate_insights_context_activity,
    check_new_data_for_insights_activity,
    count_pending_actions_activity,
    fetch_child_summaries_activity,
    fetch_previous_dossier_activity,
    fetch_summaries_for_dossier_activity,
    generate_actions_activity,
    generate_dossier_activity,
    generate_hourly_summary_activity,
    generate_rollup_summary_activity,
    generate_single_insight_activity,
    get_entity_id_activity,
    get_last_insight_time_activity,
    resolve_summary_window_activity,
    store_action_activity,
    store_dossier_activity,
    store_insight_activity,
    store_summary_activity,
)
from .summary_functions import count_activities

logger = structlog.get_logger()

# Most actions the feed page shows at once. Mirrors the limit the web client
# passes to the feedActions query (useActionListService), so generation never
# builds a backlog the user cannot see.
DEFAULT_MAX_FEED_ACTIONS = 5

# Hard cap on the incremental insight loop (the prompt targets 3-5; the model
# usually stops earlier by returning a null insight).
MAX_INSIGHTS_PER_RUN = 5


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ============================================================================
# Summaries
# ============================================================================


async def hourly_summary(
    user_id: str,
    start_time: str | None = None,
    end_time: str | None = None,
    timezone: str = "UTC",
    **_: Any,
) -> dict[str, Any]:
    """Generate the hourly summary; defaults to the previous full UTC hour."""
    if end_time is None:
        end_dt = _utcnow().replace(minute=0, second=0, microsecond=0)
    else:
        end_dt = _parse_iso(end_time)
    start_dt = _parse_iso(start_time) if start_time else end_dt - timedelta(hours=1)

    start_iso, end_iso = start_dt.isoformat(), end_dt.isoformat()

    logger.info(
        "hourly_summary_started", user_id=user_id[:8], start=start_iso, end=end_iso
    )

    aggregated_data = await aggregate_data_activity(user_id, start_iso, end_iso)
    activity_counts = count_activities(aggregated_data)

    if activity_counts.get("total", 0) == 0:
        # Quiet hours are the common case. Calling the model (or even the
        # embedder) to say so just occupies the GPU; writing the row then
        # feeds dossier_refresh something to regenerate from. Report the
        # same skip shape the rollups use and leave the next window clean.
        logger.info(
            "hourly_summary_skipped",
            user_id=user_id[:8],
            reason="no_activity",
            start=start_iso,
            end=end_iso,
        )
        return {
            "summary_id": None,
            "summary_type": "hourly",
            "skipped": "no_activity",
            "summary_text": "Nothing new.",
            "key_insights": [],
            "activity_counts": activity_counts,
            "tokens_used": 0,
        }

    summary_data = await generate_hourly_summary_activity(aggregated_data)
    summary_id = await store_summary_activity(
        user_id, summary_data, start_iso, end_iso, timezone
    )

    logger.info("hourly_summary_completed", summary_id=summary_id)

    return {
        "summary_id": summary_id,
        "summary_type": "hourly",
        "summary_text": summary_data.get("summary_text", ""),
        "key_insights": summary_data.get("key_insights", []),
        "activity_counts": summary_data.get("activity_counts", {}),
        "tokens_used": summary_data.get("tokens_used", 0),
    }


async def _rollup_summary(
    user_id: str,
    period_type: str,  # 'daily' | 'weekly' | 'monthly' | 'seasonal' | 'yearly'
    child_period_type: str,  # 'hourly' for daily; 'daily' for the rest
    reference_time: str | None,
    start_time: str | None,
    end_time: str | None,
    timezone: str | None,
) -> dict[str, Any]:
    """
    Shared rollup path. When explicit ``start_time``/``end_time`` are absent,
    the window is the user's last complete local period before
    ``reference_time`` (their ci.users.timezone), matching the old
    resolve_summary_window_activity behaviour.
    """
    if start_time and end_time:
        start_iso, end_iso, tz = start_time, end_time, timezone or "UTC"
    else:
        reference_iso = reference_time or _utcnow().isoformat()
        window = await resolve_summary_window_activity(
            user_id, period_type, reference_iso
        )
        start_iso, end_iso, tz = (
            window["start_time"],
            window["end_time"],
            window["timezone"],
        )

    logger.info(
        f"{period_type}_summary_started",
        user_id=user_id[:8],
        start=start_iso,
        end=end_iso,
    )

    child_summaries = await fetch_child_summaries_activity(
        user_id, start_iso, end_iso, child_period_type
    )

    if not child_summaries:
        # An empty window is a routine state, not a failure. The rollup crons
        # fire on the calendar (daily 00:10, weekly Monday, monthly the 1st)
        # regardless of whether the child cadence produced anything, so a
        # quiet day — a powered-off appliance, a fresh install, no captured
        # activity — has no hourly summaries to aggregate. Raising here spent
        # the pg-boss retry budget and left a dead letter every single time,
        # which buries the failures that actually mean something.
        #
        # Skipped is reported as a successful run with `skipped` set, the same
        # shape dossier_refresh uses; the next window is unaffected because
        # nothing was written.
        logger.info(
            f"{period_type}_summary_skipped",
            user_id=user_id[:8],
            reason="no_child_summaries",
            child_period_type=child_period_type,
            start=start_iso,
            end=end_iso,
        )

        return {
            "summary_id": None,
            "summary_type": period_type,
            "skipped": "no_summaries",
            f"num_{child_period_type}_summaries": 0,
        }

    summary_data = await generate_rollup_summary_activity(period_type, child_summaries)
    summary_id = await store_summary_activity(
        user_id, summary_data, start_iso, end_iso, tz
    )

    logger.info(f"{period_type}_summary_completed", summary_id=summary_id)

    return {
        "summary_id": summary_id,
        "summary_type": period_type,
        "summary_text": summary_data.get("summary_text", ""),
        "activity_counts": summary_data.get("activity_counts", {}),
        f"num_{child_period_type}_summaries": len(child_summaries),
        "tokens_used": summary_data.get("tokens_used", 0),
    }


async def daily_summary(
    user_id: str,
    reference_time: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    timezone: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    return await _rollup_summary(
        user_id, "daily", "hourly", reference_time, start_time, end_time, timezone
    )


async def weekly_summary(
    user_id: str,
    reference_time: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    timezone: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    return await _rollup_summary(
        user_id, "weekly", "daily", reference_time, start_time, end_time, timezone
    )


async def monthly_summary(
    user_id: str,
    reference_time: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    timezone: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    return await _rollup_summary(
        user_id, "monthly", "daily", reference_time, start_time, end_time, timezone
    )


# ============================================================================
# Dossier
# ============================================================================


async def dossier_refresh(
    user_id: str,
    end_time: str | None = None,
    timezone: str = "UTC",
    lookback_days: int = 30,
    **_: Any,
) -> dict[str, Any]:
    """Regenerate the user's dossier from recent daily/hourly summaries."""
    end_iso = end_time or _utcnow().isoformat()

    logger.info("dossier_refresh_started", user_id=user_id[:8])

    entity_id = await get_entity_id_activity(user_id)
    if not entity_id:
        raise ValueError(f"No entity found for user {user_id}")

    previous_dossier = await fetch_previous_dossier_activity(entity_id)
    summaries = await fetch_summaries_for_dossier_activity(
        user_id, lookback_days, end_iso
    )

    daily_summaries = summaries.get("daily", [])
    hourly_summaries = summaries.get("hourly", [])

    if not daily_summaries and not hourly_summaries:
        # Same "no input yet" case as the rollups, but this one recurs hourly:
        # PythonFunctionCrons.dossierRefresh fans out at :12 every hour for
        # every onboarded user with no precondition, while hourly summaries
        # only run at :05. An appliance with a quiet hour therefore hit this
        # raise as a matter of routine — 19 dead letters on the QA box, one
        # per hour, forever. Nothing about the retry changes the input.
        logger.info(
            "dossier_refresh_skipped",
            user_id=user_id[:8],
            reason="no_summaries",
            lookback_days=lookback_days,
            end=end_iso,
        )

        return {"entity_id": entity_id, "dossier": None, "skipped": "no_summaries"}

    dossier = await generate_dossier_activity(
        user_id,
        daily_summaries,
        hourly_summaries,
        end_iso,
        timezone,
        lookback_days,
        previous_dossier,
    )

    await store_dossier_activity(entity_id, dossier)

    logger.info("dossier_refresh_completed", entity_id=entity_id)

    return {"entity_id": entity_id, "dossier": dossier}


# ============================================================================
# Insights
# ============================================================================


async def insights_generation(
    user_id: str,
    timezone: str = "UTC",
    lookback_hours: int = 72,
    personalization: dict[str, Any] | None = None,
    force: bool = False,
    **_: Any,
) -> dict[str, Any]:
    """
    Generate insights ONE AT A TIME, storing each immediately so they appear on
    the feed as they land. A mid-run failure keeps everything stored so far.
    """
    logger.info("insights_generation_started", user_id=user_id[:8], force=force)

    now = _utcnow()

    last_insight_time = await get_last_insight_time_activity(user_id)
    since = (
        datetime.fromisoformat(last_insight_time)
        if last_insight_time
        else now - timedelta(hours=lookback_hours)
    )

    if not force:
        has_new_data = await check_new_data_for_insights_activity(
            user_id, since.isoformat()
        )
        if not has_new_data:
            logger.info("no_new_data_skipping_insights")
            return {"skipped": True, "reason": "no_new_data", "user_id": user_id}

    insights_context = await aggregate_insights_context_activity(
        user_id, since.isoformat(), now.isoformat()
    )

    if personalization:
        insights_context = {**insights_context, "personalization": personalization}

    context_counts = {
        source: len(insights_context.get(source, []))
        for source in (
            "graph_deltas",
            "upcoming_events",
            "recent_summaries",
            "strongest_relationships",
            "recently_changed_relationships",
            "event_relevant_relationships",
            "recent_communications",
        )
    }
    total_context_items = sum(context_counts.values())

    if total_context_items < 2:
        logger.info("insufficient_context_skipping", total_items=total_context_items)
        return {
            "skipped": True,
            "reason": "insufficient_context",
            "user_id": user_id,
            "context_items": total_context_items,
        }

    summary_ids: list[str] = []
    prior_insights: list[dict[str, Any]] = []
    data_sources_used: set = set()
    total_tokens = 0

    effective_personalization = insights_context.get("personalization") or {}
    multiplier = float(
        effective_personalization.get("insight_volume_multiplier") or 1.0
    )
    max_insights = max(1, round(MAX_INSIGHTS_PER_RUN * multiplier))

    for _iteration in range(max_insights):
        single = await generate_single_insight_activity(
            insights_context, prior_insights
        )

        total_tokens += single.get("tokens_used", 0)
        insight = single.get("insight")

        if not insight:
            # Model signalled it has nothing distinct left (or generation
            # failed non-fatally) — stop the loop, keep what we have.
            break

        new_title = str(insight.get("title", "")).strip().lower()
        if new_title and any(
            str(prior.get("title", "")).strip().lower() == new_title
            for prior in prior_insights
        ):
            logger.info("duplicate_insight_stopping", title=insight.get("title"))
            break

        stored_ids = await store_insight_activity(
            user_id,
            {
                "insights": [insight],
                "data_sources_used": single.get("data_sources_used", []),
                "embedding": single.get("embedding"),
                "tokens_used": single.get("tokens_used", 0),
            },
            since.isoformat(),
            now.isoformat(),
            timezone,
        )

        summary_ids.extend(stored_ids)
        prior_insights.append(insight)
        data_sources_used.update(single.get("data_sources_used", []))

        logger.info(
            "insight_stored_incrementally",
            count=len(summary_ids),
            summary_ids=stored_ids,
        )

    if not summary_ids:
        logger.info("no_insights_generated")
        return {"skipped": True, "reason": "no_insights_generated", "user_id": user_id}

    logger.info(
        "insights_generation_completed",
        num_insights=len(summary_ids),
        summary_ids=summary_ids,
    )

    return {
        "skipped": False,
        "summary_ids": summary_ids,
        "user_id": user_id,
        "num_insights": len(summary_ids),
        "tokens_used": total_tokens,
        "data_sources_used": sorted(data_sources_used),
    }


# ============================================================================
# Actions
# ============================================================================


async def actions_generation(
    user_id: str,
    timezone: str = "UTC",
    lookback_days: int = 7,
    max_feed_actions: int = DEFAULT_MAX_FEED_ACTIONS,
    **_: Any,
) -> dict[str, Any]:
    """Generate proactive action cards, capped to the feed's remaining capacity."""
    logger.info("actions_generation_started", user_id=user_id[:8])

    pending_actions = await count_pending_actions_activity(user_id)
    capacity = max_feed_actions - pending_actions

    if capacity <= 0:
        logger.info(
            "feed_at_action_capacity", pending=pending_actions, max=max_feed_actions
        )
        return {
            "skipped": True,
            "reason": "feed_at_capacity",
            "user_id": user_id,
            "pending_actions": pending_actions,
        }

    action_context = await aggregate_action_context_activity(user_id, lookback_days)

    total_context = (
        len(action_context.get("recent_summaries", []))
        + len(action_context.get("recent_insights", []))
        + len(action_context.get("upcoming_events", []))
        + len(action_context.get("key_people", []))
    )

    if action_context.get("user_dossier") is None:
        logger.info("actions_skipped_no_dossier")
        return {
            "skipped": True,
            "reason": "no_dossier",
            "user_id": user_id,
            "context_items": total_context,
        }

    if total_context < 2:
        logger.info("insufficient_context_for_actions", total_items=total_context)
        return {
            "skipped": True,
            "reason": "insufficient_context",
            "user_id": user_id,
            "context_items": total_context,
        }

    actions_data = await generate_actions_activity(action_context)
    generated_actions = actions_data.get("actions", [])

    if len(generated_actions) == 0:
        logger.info("no_actions_generated")
        return {"skipped": True, "reason": "no_actions_generated", "user_id": user_id}

    # Keep only what fits on the feed, best cards first. Lowest priority value
    # wins: the model emits rank order (1 = best) and ActionService.findAll
    # orders priority ASC, despite what the ActionItem field description says.
    if len(generated_actions) > capacity:
        logger.info(
            "actions_truncated_to_capacity",
            generated=len(generated_actions),
            capacity=capacity,
        )
        generated_actions = sorted(
            generated_actions, key=lambda action: action.get("priority", 5)
        )[:capacity]
        actions_data = {**actions_data, "actions": generated_actions}

    action_ids = await store_action_activity(user_id, actions_data)

    logger.info(
        "actions_generation_completed",
        num_actions=len(action_ids),
        action_ids=action_ids,
    )

    return {
        "skipped": False,
        "action_ids": action_ids,
        "user_id": user_id,
        "num_actions": len(action_ids),
        "pending_actions": pending_actions,
        "capacity": capacity,
        "tokens_used": actions_data.get("tokens_used", 0),
        "actions": generated_actions,
    }


# ============================================================================
# Registry — the only names the function runner will execute. Must stay in
# sync with PYTHON_FUNCTIONS.summary in the NestJS python-functions domain.
# ============================================================================

FUNCTIONS = {
    "hourly_summary": hourly_summary,
    "daily_summary": daily_summary,
    "weekly_summary": weekly_summary,
    "monthly_summary": monthly_summary,
    "dossier_refresh": dossier_refresh,
    "insights_generation": insights_generation,
    "actions_generation": actions_generation,
}

__all__ = [
    "DEFAULT_MAX_FEED_ACTIONS",
    "FUNCTIONS",
    "MAX_INSIGHTS_PER_RUN",
    "actions_generation",
    "daily_summary",
    "dossier_refresh",
    "hourly_summary",
    "insights_generation",
    "monthly_summary",
    "weekly_summary",
]
