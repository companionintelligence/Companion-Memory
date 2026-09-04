"""
Named background functions for the summary service.

These are the former Temporal workflow bodies as plain async functions. The
NestJS API schedules them through pg-boss and dispatches each run to
``POST /functions/run`` (see runner.py); the manual API endpoints call them
directly. Hourly summaries first reuse an existing exact-window row so retries
and bounded recovery do not duplicate that stream, unless ``force`` is set to
repair a window that was summarized from partial data. Insight cards are
appended one at a time so a later failure preserves completed work.
"""

from collections import OrderedDict
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
    find_existing_summary_activity,
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

# Manual recovery may call a model once per non-empty hour. Keep the operator
# surface bounded so one typo cannot enqueue days or months of generation.
MAX_HOURLY_BACKFILL_HOURS = 24

# In-flight/recent hourly backfill progress, keyed by backfill_id. A 24-hour
# backfill is up to 24 full LLM summaries plus embeddings — tens of minutes to
# hours — so the operator who started it needs to see which windows have landed
# WHILE it runs. It used to run inline in the manual-trigger request, which any
# proxy times out long before the last hour finishes, leaving no result and no
# way to tell what got written. Bounded, because a long-lived process would
# otherwise accumulate one record per backfill forever.
MAX_BACKFILL_RECORDS = 50
_backfill_progress: OrderedDict[str, dict[str, Any]] = OrderedDict()


def backfill_progress(backfill_id: str) -> dict[str, Any] | None:
    """Return the progress record for a backfill, or None if unknown/evicted."""
    return _backfill_progress.get(backfill_id)


def backfill_key(user_id: str, start_time: str, end_time: str, force: bool) -> str:
    """Identity of the WORK a backfill does, independent of its backfill_id."""
    return f"{user_id}|{start_time}|{end_time}|{int(force)}"


def active_backfill(
    user_id: str, start_time: str, end_time: str, force: bool
) -> dict[str, Any] | None:
    """
    The queued-or-running record for exactly this work, if there is one.

    Every pg-boss caller of this target dedupes with a singletonKey; the
    in-process runner has no equivalent, so an operator who submits the same
    range twice queues two identical runs and burns up to 48 LLM summaries to
    produce one answer. The unique window index stops the duplicate ROW, not
    the duplicate WORK. Newest first: the most recent record for a key is the
    one still moving.
    """
    key = backfill_key(user_id, start_time, end_time, force)
    for record in reversed(_backfill_progress.values()):
        if record.get("key") == key and record.get("status") in ("queued", "running"):
            return record
    return None


def queue_backfill(
    backfill_id: str,
    user_id: str,
    plan: list[tuple[str, str]],
    force: bool,
) -> dict[str, Any]:
    """
    Publish the record for a backfill that has been accepted but not started.

    The 202 hands the caller a progress_url it is expected to poll immediately.
    FUNCTION_RUNNER_CONCURRENCY defaults to 2 and every other summary job on
    that pool is a minutes-long LLM call, so the wait for a worker is minutes —
    and a record written only once the function body ran answered 404 for all
    of it, telling the operator their healthy queued backfill never existed.
    """
    record = _backfill_record(
        backfill_id, user_id, plan, force, status="queued", windows=[]
    )
    _remember_backfill(backfill_id, record)
    return record


def _backfill_record(
    backfill_id: str | None,
    user_id: str,
    plan: list[tuple[str, str]],
    force: bool,
    status: str,
    windows: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "backfill_id": backfill_id,
        "user_id": user_id,
        "key": backfill_key(user_id, plan[0][0], plan[-1][1], force),
        "start_time": plan[0][0],
        "end_time": plan[-1][1],
        "hours": len(plan),
        "forced": force,
        "status": status,
        "completed": 0,
        "generated": 0,
        "skipped": 0,
        "windows": windows,
    }


def _remember_backfill(backfill_id: str, record: dict[str, Any]) -> None:
    _backfill_progress[backfill_id] = record
    while len(_backfill_progress) > MAX_BACKFILL_RECORDS:
        _backfill_progress.popitem(last=False)


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
    force: bool = False,
    **_: Any,
) -> dict[str, Any]:
    """
    Generate the hourly summary; defaults to the previous full UTC hour.

    ``force`` bypasses the existing-row check. Without it the only recovery
    path is filling gaps: an hour summarized before an import batch finished
    landing stays wrong forever, because the thin row it produced satisfies the
    exact-window match. The regenerated summary overwrites that row rather than
    adding a second one — see store_summary_activity and the unique index it
    conflicts against.

    Every branch reports ``forced``. hourly_summary_backfill spreads this dict
    verbatim into each entry of the progress record's ``windows`` list, so a
    key present on only some branches is a KeyError for the operator reading
    the run — and ``forced`` used to be missing from exactly the
    already-summarized windows a forced run exists to repair. ``skipped`` is
    the one deliberate exception: like the rollups, it signals by presence, so
    callers read it with ``.get``.
    """
    if end_time is None:
        end_dt = _utcnow().replace(minute=0, second=0, microsecond=0)
    else:
        end_dt = _parse_iso(end_time)
    start_dt = _parse_iso(start_time) if start_time else end_dt - timedelta(hours=1)

    start_iso, end_iso = start_dt.isoformat(), end_dt.isoformat()

    logger.info(
        "hourly_summary_started",
        user_id=user_id[:8],
        start=start_iso,
        end=end_iso,
        force=force,
    )

    existing = (
        None
        if force
        else await find_existing_summary_activity(user_id, "hourly", start_iso, end_iso)
    )
    if existing:
        content = existing.get("content", {})
        logger.info(
            "hourly_summary_skipped",
            user_id=user_id[:8],
            reason="already_exists",
            summary_id=existing["summary_id"],
            start=start_iso,
            end=end_iso,
        )
        return {
            "summary_id": existing["summary_id"],
            "summary_type": "hourly",
            "skipped": "already_exists",
            "forced": force,
            "summary_text": content.get("summary_text", ""),
            "key_insights": content.get("key_insights", []),
            "activity_counts": content.get("activity_counts", {}),
            "tokens_used": content.get("tokens_used", 0),
        }

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
            "forced": force,
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
        "forced": force,
        "summary_text": summary_data.get("summary_text", ""),
        "key_insights": summary_data.get("key_insights", []),
        "activity_counts": summary_data.get("activity_counts", {}),
        "tokens_used": summary_data.get("tokens_used", 0),
    }


def plan_hourly_backfill(start_time: str, end_time: str) -> list[tuple[str, str]]:
    """
    Validate an hourly backfill range and return its one-hour windows.

    Split out of ``hourly_summary_backfill`` so the manual endpoint can reject
    a bad range with a 400 *before* accepting the run — once the work is handed
    to the runner, a ValueError is a failed background job the caller has to go
    looking for, not an answer to their request. The function still calls this
    itself, because pg-boss dispatch reaches it without going through the
    endpoint.
    """
    start_dt = _parse_iso(start_time)
    end_dt = _parse_iso(end_time)

    if start_dt.utcoffset() is None or end_dt.utcoffset() is None:
        raise ValueError("hourly backfill timestamps must include UTC offsets")
    if any((start_dt.minute, start_dt.second, start_dt.microsecond)) or any(
        (end_dt.minute, end_dt.second, end_dt.microsecond)
    ):
        raise ValueError("hourly backfill timestamps must align to hour boundaries")

    duration = end_dt - start_dt
    if duration <= timedelta(0):
        raise ValueError("hourly backfill end_time must be after start_time")
    hours = duration.total_seconds() / 3_600
    if not hours.is_integer():
        raise ValueError("hourly backfill range must contain whole hours")
    if hours > MAX_HOURLY_BACKFILL_HOURS:
        raise ValueError(
            f"hourly backfill is limited to {MAX_HOURLY_BACKFILL_HOURS} hours"
        )

    plan: list[tuple[str, str]] = []
    cursor = start_dt
    while cursor < end_dt:
        window_end = cursor + timedelta(hours=1)
        plan.append((cursor.isoformat(), window_end.isoformat()))
        cursor = window_end

    return plan


async def hourly_summary_backfill(
    user_id: str,
    start_time: str,
    end_time: str,
    timezone: str = "UTC",
    force: bool = False,
    backfill_id: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    """
    Generate hourly summaries over an explicit bounded range.

    Registered in FUNCTIONS so it can be dispatched to the runner's worker pool
    instead of occupying an HTTP request for the length of up to 24 LLM calls.
    When ``backfill_id`` is supplied each finished window is published to the
    progress record that ``GET /summary/backfill/{id}`` serves, so a caller who
    was handed a 202 can watch the hours land. The endpoint publishes that
    record as ``queued`` before submitting, so this takes over an existing one
    rather than minting a second record on the same id.

    ``force`` regenerates windows that already have a summary — the only way to
    repair an hour that was summarized before its import batch finished.
    """
    plan = plan_hourly_backfill(start_time, end_time)

    windows: list[dict[str, Any]] = []
    # Take over the record the endpoint published at accept time when there is
    # one: replacing it would reset the id the caller is already polling, and
    # would drop the run_id the 202 pointed them at.
    record = _backfill_progress.get(backfill_id) if backfill_id else None
    if record is None:
        record = _backfill_record(
            backfill_id, user_id, plan, force, status="running", windows=windows
        )
        if backfill_id:
            _remember_backfill(backfill_id, record)
    else:
        record["windows"] = windows
    record["status"] = "running"

    try:
        for window_start, window_end in plan:
            result = await hourly_summary(
                user_id,
                start_time=window_start,
                end_time=window_end,
                timezone=timezone,
                force=force,
            )
            windows.append(
                {
                    "start_time": window_start,
                    "end_time": window_end,
                    **result,
                }
            )
            # Update in place after every window, not at the end: the whole
            # point of the record is answering "which hours landed?" while the
            # run is still going.
            record["completed"] = len(windows)
            record["skipped"] = sum(1 for w in windows if w.get("skipped"))
            record["generated"] = len(windows) - record["skipped"]
    except Exception as exc:
        # Leave the partial progress visible; a backfill that died on hour 9 of
        # 24 still wrote eight hours, and the operator needs to know which.
        record["status"] = "failed"
        record["error"] = f"{type(exc).__name__}: {exc}"
        raise

    record["status"] = "completed"

    return {
        "user_id": user_id,
        "backfill_id": backfill_id,
        "start_time": record["start_time"],
        "end_time": record["end_time"],
        "hours": record["hours"],
        "forced": force,
        "generated": record["generated"],
        "skipped": record["skipped"],
        "windows": windows,
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
#
# `hourly_summary_backfill` is here so the manual endpoint can hand a 24-hour
# recovery to the runner's worker pool instead of holding an HTTP request open
# for tens of minutes. It is operator-initiated only — there is no cron for it —
# but a name absent from PYTHON_FUNCTIONS.summary is one `dispatch()` rejects at
# the call site, so pg-boss could not send it at all; it is now listed there
# too, and pythonFunctionRegistryDrift.test.ts parses this dict to keep the two
# sides from drifting apart again.
# ============================================================================

FUNCTIONS = {
    "hourly_summary": hourly_summary,
    "hourly_summary_backfill": hourly_summary_backfill,
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
    "MAX_BACKFILL_RECORDS",
    "MAX_HOURLY_BACKFILL_HOURS",
    "MAX_INSIGHTS_PER_RUN",
    "actions_generation",
    "active_backfill",
    "backfill_key",
    "backfill_progress",
    "daily_summary",
    "dossier_refresh",
    "hourly_summary",
    "hourly_summary_backfill",
    "insights_generation",
    "monthly_summary",
    "plan_hourly_backfill",
    "queue_backfill",
    "weekly_summary",
]
