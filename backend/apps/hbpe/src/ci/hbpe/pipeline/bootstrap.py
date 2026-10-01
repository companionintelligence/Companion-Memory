"""
Bootstrap pipeline — full cold-start training through ONNX export.

Triggered when no HMT checkpoint exists (new user / fresh volume). After this
completes, the nightly pipeline (ci.hbpe.functions.nightly) takes over for
incremental updates. Orchestrated by ci.hbpe.functions.bootstrap.

Step order (mirrors run_pipeline.py steps 2–11):
  1. label_unlabeled      — assign L0/L1 to all events and content
  2. label_summary_tokens — label hourly summaries on the serialize days
  3. serialize            — write hbpe.token_stream for all labeled days
  4. train                — L0 MAE pre-train + HMT joint fine-tune
  5. export               — temperature calibration + ONNX FP32 + INT8
  6. lora                 — initial LoRA adapter fine-tune
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta

from ci.hbpe.event_status import LIVE_EVENT_SQL

log = logging.getLogger(__name__)

# Serialize budget, in *days that actually hold data* — not in calendar span.
# Older history lives in the recurrence/seasonal SQL, not in the HMT corpus, so
# widening this only makes the overnight slower.
#
# This is also the *binding* constraint on the nightly label drain. A label only
# becomes visible to hbpe.pipeline.recurrence (and therefore to /forecast) once
# serialize turns it into an hbpe.token_stream row, and serialize only ever
# rewrites the days it selects — a day that fell out of the selection before its
# events were labeled is never revisited. So the drain aims at the day list,
# ``content_source_days()``, and NOT at a calendar band: not at
# recurrence.HISTORY_DAYS (180), and not at ``today - 90`` either.
#
# The day list is the whole point, because which calendar days it holds is
# corpus-dependent. On a DENSE corpus it is the trailing 91 days, so labeling
# the 90–180-day band produces no token_stream rows at all — on the dev corpus
# that band is 5,775 of the 7,192 unlabeled events inside 180 days, 80% of a
# reserved budget share buying nothing. That was once stated flatly here; the
# reserved tier (EVENT_DAY_FLOOR) made it conditional. On a corpus whose events
# are SPARSE, the newest 45 event days can reach arbitrarily far back — days
# 90–180 included, and past 180 — and those days do get serialized, so labeling
# them is not wasted. Only the day list can say which case an appliance is in,
# which is exactly why the cutoff is read off the list rather than computed from
# today. See ``label_recency_start`` below and ``nightly_runner.label_unlabeled``.
#
# The trade-off the tiers introduce, written down because nothing else records
# it: on a bimodal corpus the fill tier reaches back only 46 days from the
# newest day-with-data, so days ~47–90 back are no longer rewritten nightly —
# yet they are not purged either, because they still hold an hourly summary and
# so never match the purge tier. Their hbpe.token_stream rows FREEZE at whatever
# the last run that selected them wrote. The bimodal corpus is the only shape
# where this bites INSIDE the trailing window; on any corpus whose recent end
# holds events the two content tiers overlap and the fill still covers it.
#
# Below the budget, every corpus has frozen days. A day that ages out of the
# budget keeps its rows, because it still has a source and so never matches the
# purge tier. What thaws a frozen day is the re-serialize queue (see
# RESERIALIZE_DAY_CAP), and only for a change the API announces: an event
# created, edited, deleted, restored or re-statused on that day. A late label, a
# re-labeled summary, or a pipeline write that bypasses HbpeNotifyService still
# never reaches a frozen day.
SERIALIZE_WINDOW_DAYS = 90

# Of the ``SERIALIZE_WINDOW_DAYS + 1`` content days, the share reserved for days
# that actually hold EVENTS before any summary-only day may claim a slot.
#
# Half the budget, and half is deliberate: it is the largest reservation that
# still cannot starve recent context. The fill tier always keeps 46 of the 91
# slots — a majority — for the newest days-with-data of either kind, so on every
# corpus whose recent end holds events (which is every non-bimodal corpus) the
# reservation and the fill draw from overlapping sets and the answer is exactly
# the newest 91 days the flat ``LIMIT`` used to return. Smaller, and an archival
# corpus still loses most of its hard-labeled days; larger, and a live appliance
# with an old import would start serializing more history than present.
#
# The reservation is a ceiling, never a quota: fewer event days than the floor
# reserves fewer slots and the fill takes the rest, so no slot is ever wasted.
# It is also clamped to half of whatever budget the caller asked for (see
# token_source_days) — HBPE_LABEL_RECENCY_DAYS can shrink ``window_days``, and a
# literal 45 against an 11-day budget would return 45 archival days and no
# recent day at all.
EVENT_DAY_FLOOR = 45

# Cap on the emptied days one run may purge, ON TOP of the content budget.
#
# Purge days are delete-only work (serialize_day's DELETE is the only thing that
# ever removes a day's tokens) and they are correctness-critical: a day whose
# rows are never purged keeps a deleted event nudging the forecast forever. So
# they must not be funded out of the content budget, where a handful of
# deletions would evict real days. They still need a bound of their own, or one
# bulk delete — a whole year of events removed at once — makes a single night's
# serialize_day count unbounded. At this cap the purge tier at most doubles the
# serialize_day count the content budget alone implies (the re-serialize queue
# adds a third budget on top; see RESERIALIZE_DAY_CAP) — and to keep that true
# for a caller that shrank ``window_days``, the effective cap is clamped to that
# caller's own budget (see token_source_days), exactly as EVENT_DAY_FLOOR is.
#
# Leftovers are picked up on subsequent nights, and the set shrinks by one on
# every day visited *as long as serialize_day writes that day nothing* — which
# is what makes it converge. That holds today for every day this branch can
# select. It would stop holding for a day whose only remaining source is a
# completed labeled task: serializer._fetch_tokens_for_day still consumes those
# (get_completed_tasks_for_day), so such a day would be purged and immediately
# rewritten, re-qualifying for the branch every night forever. Unreachable while
# nothing writes ci.tasks.l0_class; see the ci.tasks note below, which a future
# writer of that column has to act on.
PURGE_DAY_CAP = SERIALIZE_WINDOW_DAYS + 1

# Cap on the queued days one run may re-serialize, ON TOP of both budgets above.
#
# hbpe.reserialize_days (see reserialize_queue) holds the past days the API
# announced a change on, which the ingester did not rewrite because they were
# not today. Most of them are inside the content budget and get rewritten
# tonight anyway. The queue exists for the rest: a frozen day, older than the
# budget and still holding a source, which neither the content tiers nor the
# purge tier will ever visit again. Before the queue, a meeting cancelled on
# such a day stayed in hbpe.token_stream, and recurrence (180 days), seasonal
# (800) and HMT training went on counting it.
#
# It gets its own budget for the same two reasons the purge tier does. Funded
# from the content budget, a burst of edits to old days would evict real days
# for the night. Uncapped, one bulk edit (re-timing a year of imported events)
# would make a single night unbounded. With all three caps the worst night is
# three times the content budget: 273 serialize_day calls at the default
# window. In steady state the queue uses a handful of them, because it holds
# only days that changed.
#
# It converges. Rows come only from notifications and from the migration's
# one-time seed, and a re-serialized day is never queued again: serialize_day
# notifies nobody, and the ingester's poll path never enqueues. Days beyond the
# cap wait for the next night, so the queue drains whenever fewer than this many
# old days change per night. Unlike the purge cap it is not clamped to
# ``window_days``, because only serialize_token_stream drains the queue and it
# always runs at the default window.
RESERIALIZE_DAY_CAP = SERIALIZE_WINDOW_DAYS + 1

# The N most recent calendar days that hold anything the serializer can publish,
# newest first, with nothing after today.
#
# Days-with-data, not a contiguous (MIN, MAX) range. A contiguous window is only
# equivalent while the corpus is dense right up to its own end, and it collapses
# on the two shapes this appliance actually sees:
#
#   * Archival corpus + live summaries. ci.summaries rows are written hourly and
#     forever, so MAX(period_start) is "today" on any running appliance. On an
#     imported corpus whose events stop in 2024 the union's max is today and the
#     trailing 90-day range holds ZERO events — the entire historical event
#     corpus silently stops being labeled and stops reaching hbpe.token_stream,
#     replaced by summary tokens at SUMMARY_SOFT_PROB (0.7).
#   * The mirror failure, before summaries were in the bounds at all: the range
#     ended at the last *event*, so a summary created today fell outside it and
#     was never serialized.
#
# A day list satisfies both at once — today's summary day and the 2024 event
# days both reach the serializer while fewer than ``SERIALIZE_WINDOW_DAYS + 1``
# days-with-data are newer than those event days — and costs the same number of
# serialize_day calls as a contiguous 90-day range, whereas widening the range
# to span the gap would be ~800 days on that corpus.
#
# A flat ``ORDER BY source_date DESC LIMIT 91`` over the union is not enough to
# hold that guarantee, which is why the budget is allocated in tiers. Flat, the
# newest 91 days-with-data win outright; on an appliance that has BOTH an
# archival import and continuous live capture the hourly summaries accrue one
# day-with-data per calendar day, so ~91 days after the import the 2024 event
# days are evicted and the historical corpus stops reaching hbpe.token_stream —
# the same failure a contiguous trailing window has on day one, deferred by
# about three months rather than removed. And the days it evicts are the only
# ones that matter most: events carry hard L0/L1 labels, while summary-derived
# tokens are the gap-filler at SUMMARY_SOFT_PROB (0.7), so a flat budget spends
# the whole corpus on the weaker source.
#
# The tiers:
#
#   A. reserved — the newest EVENT_DAY_FLOOR days that hold events. Taken
#      first, from the event branch alone, so no volume of summary days can
#      evict them. A ceiling, not a quota: a corpus with fewer event days
#      reserves fewer slots.
#   B. fill     — the newest remaining days from (events UNION summaries),
#      minus tier A, for whatever the reservation left of the budget. The LIMIT
#      is an expression over ``count(*) FROM reserved`` precisely so unclaimed
#      reservation slots come back here instead of being wasted.
#   C. purge    — days holding hbpe.token_stream rows but NO live source at
#      all, newest first. Delete-only work, added ON TOP of the content budget
#      under PURGE_DAY_CAP; see that constant for why on-top-but-capped, and
#      the branch itself for why "source-less" and not "outside the budget".
#
# The re-serialize queue is not a tier of this query: serialize_token_stream
# drains it after walking this list, under RESERIALIZE_DAY_CAP, and a queued
# day this list already holds (content or purge) is settled without a second
# visit. See reserialize_queue.
#
# Tiers A and B are exactly the flat budget on every corpus whose recent end
# holds events, because the two tiers then draw from overlapping sets: dense
# live appliance, events-only, summaries-only (A is empty, B takes all 91) and
# short-event-corpus all return the same newest 91 days as before. The bimodal
# corpus is the only shape that moves, and it moves from 91 summary days and
# zero events to 45 event days plus 46 summary days.
#
# ci.tasks is deliberately NOT a source branch here. The bounds query used to
# union completed tasks gated on ``l0_class IS NOT NULL AND l0_class <>
# 'UNKNOWN'``, and nothing in this repo writes ci.tasks.l0_class — see
# data_client._completed_tasks_l0_class_populated(), which probes that exact
# predicate once per process precisely so the always-empty scan stops running.
# Adding the branch back here would reintroduce the scan main just removed.
# Note the serializer still CONSUMES completed labeled tasks once a day is
# selected (serializer._fetch_tokens_for_day -> data_client.get_completed_tasks_
# for_day). So the day a task falls on is tokenized only if an event, an hourly
# summary or an existing token_stream row already put that day in this list. A
# future writer of ci.tasks.l0_class has to add the selection branch back here
# too — to BOTH the content tiers and the purge tier's exclusions — or two
# things break at once. Its tokens land only on days something else selected;
# and a task-only day becomes a permanent purge slot, because the purge branch
# would keep selecting it (no event, no summary) while serialize_day keeps
# writing its task tokens straight back. That is the one shape in which the
# purge tier does not converge, and it is the reason the convergence claim on
# PURGE_DAY_CAP is stated conditionally.
#
# ``event_days`` has to agree with the reads it is PREDICTING, or a reserved
# slot buys nothing. The serializer's event read
# (data_client.get_token_events_for_day) and the drain's unlabeled-event read
# (data_client._unlabeled_events_where) both carry ``event_type IS DISTINCT
# FROM 'planned_block'`` — planning's own calendar rows, written by
# PlannedBlockService, are the appliance's own suggestions and are deliberately
# not part of the behavioural corpus. Without the same predicate here, an
# appliance that uses planning spends tier A's 45 reserved slots on days whose
# only events are planned blocks: days that serialize to ZERO event tokens, on
# exactly the bimodal shape tier A exists for. It also keeps such a day out of
# the purge tier, so its stale rows would never be removed either.
#
# The status predicate (``LIVE_EVENT_SQL``: not cancelled, no_show or skipped)
# is here for the same two reasons. Both reads leave out events that did not
# happen, so a day holding only those serializes to zero event tokens and has
# nothing to label. The purge half matters most. When a day's last live event
# is cancelled, the day has to leave this branch or it can never reach the
# purge tier, and a day older than the content budget has no other way back:
# the cancelled meeting's tokens would stay in hbpe.token_stream for good.
#
# The two reads carry three more predicates this CTE does not, and each is
# deliberate rather than an oversight:
#
#   * ``JOIN hbpe.l1_event_cluster`` (serializer only) — an unlabeled event day
#     yields no tokens *yet*. Reserving it is the point: the drain aims at this
#     list, so requiring the label here would be circular and no day would ever
#     become labeled.
#   * ``NOT (mapped_kind_sql())`` (drain only) — kinds in hbpe.kind_l0_map are
#     labeled by static_labeler.label_mapped_events, not by Qwen. They are
#     labeled events and the serializer publishes them, so their days are real
#     token days.
#   * ``ec.event_id IS NULL`` (drain only) — the drain's already-labeled filter,
#     which says nothing about whether a day produces tokens.
#
# ``is_deleted = FALSE`` and the ``>= '2010-01-01'`` sentinel bound are shared
# by all three and are present here. The ``< today + 1 day`` clamp is this
# query's alone; see the docstring for why.
_TOKEN_SOURCE_DAYS_SQL = f"""
    WITH event_days AS (
        SELECT DISTINCT e.start_time::date AS source_date
        FROM ci.events e
        WHERE e.user_id = %s::uuid
          AND e.is_deleted = FALSE
          AND e.event_type IS DISTINCT FROM 'planned_block'
          AND {LIVE_EVENT_SQL}
          AND e.start_time >= '2010-01-01'::timestamptz
          AND e.start_time < (%s::date + INTERVAL '1 day')
    ),
    summary_days AS (
        SELECT DISTINCT s.period_start::date AS source_date
        FROM ci.summaries s
        WHERE s.user_id = %s::uuid
          AND s.period_type = 'hourly'
          AND s.period_start >= '2010-01-01'::timestamptz
          AND s.period_start < (%s::date + INTERVAL '1 day')
    ),

    -- Tier A. The newest event days, reserved before anything else can claim a
    -- slot. Drawn from the event branch ALONE, which is the whole point: on a
    -- bimodal corpus every summary day is newer than every event day, so any
    -- selection over the union puts these last.
    reserved AS (
        SELECT source_date FROM event_days
        ORDER BY source_date DESC
        LIMIT %s
    ),

    -- Tier B. The newest content days of either kind that tier A did not take,
    -- for whatever is left of the budget. The LIMIT is an expression, not a
    -- literal: a corpus with no events (or fewer than the floor) reserves fewer
    -- slots, and those slots come back here rather than going unspent. GREATEST
    -- guards the negative that a caller-shrunk budget could otherwise produce.
    fill AS (
        SELECT source_date
        FROM (
            SELECT source_date FROM event_days
            UNION
            SELECT source_date FROM summary_days
        ) content_days
        WHERE NOT EXISTS (
            SELECT 1 FROM reserved r WHERE r.source_date = content_days.source_date
        )
        ORDER BY source_date DESC
        LIMIT GREATEST(%s - (SELECT count(*) FROM reserved), 0)
    ),
    content AS (
        SELECT source_date FROM reserved
        UNION
        SELECT source_date FROM fill
    ),

    -- Tier C. Days that no longer hold anything but still hold stale tokens.
    -- serialize_day's DELETE is the only thing that ever purges a day, and it
    -- only runs on days this query returns. Without this branch a day that
    -- EMPTIES OUT — the sole event on it soft-deleted by CalendarEventService,
    -- or its start_time edited onto another day — drops out of the two source
    -- branches above and is never visited again, so its rows sit in
    -- hbpe.token_stream forever while pipeline.recurrence and HMT training keep
    -- reading them: a deleted event still nudging the forecast. The old
    -- contiguous serialize_range(start, end) purged such days for free, because
    -- it walked every calendar day in the window whether or not it held data.
    --
    -- These days are ADDED ON TOP of the content budget rather than competing
    -- for its slots. Competing was the earlier policy and it is wrong in both
    -- directions: a purge that borrows a slot evicts a real day for the night,
    -- and — worse once tier A exists — a run of emptied days newer than the
    -- reserved event days would eat the fill tier. The cap is what keeps "on
    -- top" bounded: one bulk delete cannot make a single night unbounded, the
    -- leftovers are taken on subsequent nights, and the set shrinks by one per
    -- day visited because serialize_day writes such a day nothing, so it never
    -- returns to this branch. That last step is conditional, not structural —
    -- a completed labeled task would still be written back onto a day matching
    -- neither source branch. See the completed-task note above the query.
    --
    -- SOURCE-LESS is the load-bearing predicate, not "outside the content
    -- budget". hbpe.token_stream deliberately holds far more history than the
    -- serialize budget — pipeline.recurrence reads 180 days of it and
    -- pipeline.seasonal 800 — and every one of those days still has its event
    -- or summary behind it. Purging "every token_stream day the budget did not
    -- select" would therefore delete the profiler's own history every night;
    -- under the old competing-LIMIT policy nothing noticed, because the LIMIT
    -- kept this branch from ever reaching past the 91st newest day. On top of
    -- the budget it has no such ceiling, so the exclusion has to be explicit.
    -- The flip side is the gap that policy left: a day that emptied out below
    -- the 91st newest was never revisited at all, and its rows have been
    -- feeding recurrence ever since. Those days are now reachable.
    --
    -- Excluding both source branches also subsumes ``NOT IN content``: both
    -- content tiers draw only from event_days and summary_days.
    purge AS (
        SELECT stale.source_date
        FROM (
            SELECT DISTINCT ts.date AS source_date
            FROM hbpe.token_stream ts
            WHERE ts.user_id = %s::uuid
              AND ts.date < (%s::date + INTERVAL '1 day')
        ) stale
        WHERE NOT EXISTS (
            SELECT 1 FROM event_days e WHERE e.source_date = stale.source_date
        )
          AND NOT EXISTS (
            SELECT 1 FROM summary_days s WHERE s.source_date = stale.source_date
        )
        ORDER BY stale.source_date DESC
        LIMIT %s
    )
    -- Content and purge come back TAGGED, not merged. Serialize wants both;
    -- label_recency_start wants the oldest CONTENT day and must never see a
    -- purge day. A purge day carries no label to write — it has no event and no
    -- summary, that is what put it in the tier — but the tier is bounded in
    -- COUNT, not in REACH, so days[0] of the merged list can be an arbitrarily
    -- old emptied day. Merged, a 200-day corpus plus a handful of source-less
    -- 2020 token_stream days moves the label drain's phase boundary from
    -- 2026-06-05 to 2020, dissolving the recency phase — most of the nightly
    -- label budget — across years. UNION ALL is safe because the purge tier
    -- already excludes both content branches, so the two sets are disjoint.
    SELECT source_date, TRUE AS is_content FROM content
    UNION ALL
    SELECT source_date, FALSE AS is_content FROM purge
    ORDER BY source_date DESC
"""

# Same event predicates as the day query's event_days branch, and for the same
# reason: this is the fallback answer to "what can the serializer publish", so
# counting a day whose only events are planned blocks, or did not happen, would
# hand the label drain a cutoff for a day that yields no tokens, and would
# report a planning-only appliance as having a corpus.
_TOKEN_DATE_BOUNDS_SQL = f"""
    SELECT MIN(source_date), MAX(source_date)
    FROM (
        SELECT e.start_time::date AS source_date
        FROM ci.events e
        WHERE e.user_id = %s::uuid
          AND e.is_deleted = FALSE
          AND e.event_type IS DISTINCT FROM 'planned_block'
          AND {LIVE_EVENT_SQL}
          AND e.start_time >= '2010-01-01'::timestamptz

        UNION ALL

        SELECT s.period_start::date AS source_date
        FROM ci.summaries s
        WHERE s.user_id = %s::uuid
          AND s.period_type = 'hourly'
          AND s.period_start >= '2010-01-01'::timestamptz
    ) token_sources
"""


def _utc_today() -> date:
    """Today in UTC. A named seam so tests can pin the serialize window."""
    return datetime.now(UTC).date()


def _token_source_rows(
    user_id: str,
    window_days: int,
    today: date | None,
) -> tuple[list[date], list[date]]:
    """
    One day-list read, returned as ``(content_days, purge_days)``, oldest first.

    The two are kept apart rather than merged because their consumers differ:
    serialize walks both (a purge day's whole purpose is to be visited), while
    ``label_recency_start`` may only ever see content. See the tag comment at
    the end of _TOKEN_SOURCE_DAYS_SQL.
    """
    from ci.hbpe.database import get_conn

    end = today or _utc_today()
    budget = window_days + 1
    # Never more than half the budget the caller actually asked for. The default
    # window makes this exactly EVENT_DAY_FLOOR; a shrunk window (see
    # HBPE_LABEL_RECENCY_DAYS, via label_recency_start) would otherwise get a
    # reservation-only day list — more days than its budget, all archival.
    event_floor = min(EVENT_DAY_FLOOR, budget // 2)
    # Same reasoning, same reason: window_days is a caller parameter, so a flat
    # cap would let an 11-day request return 11 content days and up to 91 purge
    # days — a night eight times the size the caller asked for. Capped at the
    # content budget, the purge tier's share of the bound PURGE_DAY_CAP
    # documents (at most one more content budget) holds for every window, not
    # just the default (where budget == PURGE_DAY_CAP and this is a no-op).
    purge_cap = min(PURGE_DAY_CAP, budget)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                _TOKEN_SOURCE_DAYS_SQL,
                (
                    user_id,
                    end,
                    user_id,
                    end,
                    event_floor,
                    budget,
                    user_id,
                    end,
                    purge_cap,
                ),
            )
            rows = cur.fetchall()

    content: list[date] = []
    purge: list[date] = []
    for row in rows:
        if not row or row[0] is None:
            continue
        (content if row[1] else purge).append(date.fromisoformat(str(row[0])))
    content.sort()
    purge.sort()
    return content, purge


def content_source_days(
    user_id: str,
    window_days: int = SERIALIZE_WINDOW_DAYS,
    today: date | None = None,
) -> list[date]:
    """
    The days of ``token_source_days`` that hold an event or an hourly summary —
    tiers A and B only, no purge days — oldest first.

    This is what ``label_recency_start`` aims at. A purge day is source-less by
    construction, so it has no label to write and no business setting the label
    drain's phase boundary; the purge tier is capped in count but not in reach,
    so letting it into that boundary drags the recency phase back arbitrarily
    far (see the tag comment in _TOKEN_SOURCE_DAYS_SQL). Clamping the purge
    tier's reach instead would have been the wrong repair: reaching back is
    exactly what lets it clean up days that emptied out long ago.
    """
    return _token_source_rows(user_id, window_days, today)[0]


def token_source_days(
    user_id: str,
    window_days: int = SERIALIZE_WINDOW_DAYS,
    today: date | None = None,
) -> list[date]:
    """
    The calendar days the next serialize run will write, oldest first.

    A budget of ``window_days + 1`` distinct CONTENT days — days holding an
    event or an hourly summary, nothing dated after ``today`` — allocated in two
    tiers, plus the purge days that ride on top of it. The ``+ 1`` keeps the
    same day budget the old inclusive ``[end - window_days, end]`` range had, so
    switching from a range to a list did not silently shave a day off every
    appliance's corpus.

      * Reserved: the newest ``EVENT_DAY_FLOOR`` days that hold events, taken
        before any summary-only day may claim a slot. Events carry hard L0/L1
        labels; without the reservation an appliance running both an archival
        import and continuous live capture evicts every imported event day once
        ~91 days of hourly summaries have accrued, and serializes nothing but
        the 0.7-confidence gap-filler.
      * Fill: the newest remaining content days of either kind, for whatever the
        reservation left. Unclaimed reservation slots come back here, so a
        corpus with few or no events wastes none of the budget.
      * Purge: days holding hbpe.token_stream rows but no live source at all,
        newest first, capped at ``PURGE_DAY_CAP`` and added ON TOP of the
        budget. serialize_day's DELETE is the only purge there is, and a day it
        never visits keeps a deleted event nudging the forecast forever. Days
        that still HAVE a source are never in this tier: token_stream holds far
        more history than the budget (recurrence reads 180 days of it, seasonal
        800), and that history is not stale.

    The tiers are a no-op on every corpus whose recent end holds events: they
    then draw from overlapping sets, and the answer is the newest
    ``window_days + 1`` days-with-data, exactly what a flat ``LIMIT`` returned.
    Only a bimodal corpus — old events, new summaries — moves. See
    _TOKEN_SOURCE_DAYS_SQL for the tiers in SQL and for why each bound is there.

    The clamp lives in SQL, not in Python: a future-dated row (a calendar
    reminder, a booked flight, an import with a bad date) that survived into the
    result would consume one of the ``LIMIT`` slots and push a real day out of
    the budget. Everything downstream (recurrence 180d, token_rollup 90d,
    seasonal 800d) anchors on today, so a serialized future day is work nothing
    can ever read.

    Returns ``[]`` when the user has no dated source at or before today and no
    stale rows to purge — an empty corpus, or one that is entirely in the
    future.
    """
    content, purge = _token_source_rows(user_id, window_days, today)
    return sorted(content + purge)


def event_date_bounds(user_id: str) -> tuple[date, date] | None:
    """
    First and last calendar day with input the serializer can publish.

    The legacy name is retained for callers, but the bounds include both events
    and hourly summaries. This is no longer what serialize aims at — that is
    ``token_source_days`` — but it is still the cheapest way to tell an empty
    corpus apart from an entirely future-dated one, and it backs
    ``label_recency_start``'s fallback when the day-list read is unavailable.
    """
    from ci.hbpe.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_TOKEN_DATE_BOUNDS_SQL, (user_id, user_id))
            row = cur.fetchone()

    if not row or row[0] is None:
        return None
    return date.fromisoformat(str(row[0])), date.fromisoformat(str(row[1]))


def serialize_window(
    bounds: tuple[date, date] | None,
    window_days: int = SERIALIZE_WINDOW_DAYS,
    today: date | None = None,
) -> tuple[date, date] | None:
    """
    The contiguous ``(start, end)`` day range implied by ``bounds``, inclusive,
    or ``None`` when there is nothing inside it.

    Serialize itself no longer uses this — it walks ``token_source_days``, which
    a bimodal corpus needs — but the range is still the right shape for the
    label drain's fallback cutoff, so the clamp reasoning below still applies.

    The end is CLAMPED to today, not anchored on it. MAX(start_time) runs ahead
    of the present whenever the corpus holds future-dated rows — a calendar
    reminder, a booked flight, an import with a bad date. On the dev corpus
    three such rows (the furthest 2026-10-15) dragged the window to
    2026-07-17..2026-10-15, which contains 7 events; the clamped window contains
    1,412 over 24 distinct days. Everything downstream (recurrence 180d,
    token_rollup 90d, seasonal 800d) anchors on today, so a window sitting in
    the future serializes almost nothing they can ever read.

    Clamp rather than anchor: ``end = today`` would regress an archival-only
    appliance (all data two years old) from "serializes its last 90 days" to
    "serializes an empty range", which returns rows: 0 and aborts bootstrap()
    with no_token_data — a working cold start turned dead.
    """
    if bounds is None:
        return None
    min_date, max_date = bounds
    end = min(max_date, today or _utc_today())
    if end < min_date:
        # Every event this user has is in the future. Nothing to serialize.
        return None
    return max(min_date, end - timedelta(days=window_days)), end


def label_recency_start(user_id: str, window_days: int = SERIALIZE_WINDOW_DAYS) -> date:
    """
    Oldest day whose labels can still reach hbpe.token_stream — i.e. the first
    CONTENT day the *next* serialize run will write.

    Content, not the whole day list: serialize also visits purge days, and those
    are source-less by definition, so there is no label on them for this cutoff
    to protect. They are also unbounded in reach — the purge tier is capped in
    count only — so including them would let one emptied 2020 day drag the
    drain's phase boundary back six years and dissolve the recency phase that
    boundary exists to create.

    This is the boundary the nightly drain splits its two phases on, so the
    recency phase covers exactly the events a serialize run can still pick up.
    Deriving it from the corpus rather than from ``today`` matters when
    ingestion lags: with the newest data three days behind, serialize's day list
    reaches back to ``today-93``, and a cutoff of ``today-90`` would leave three
    of those days to the oldest-first historical phase — which reaches them
    last, so they would be serialized with their events still unlabeled. It
    matters more on a bimodal corpus, where the day list jumps a two-year gap
    and no contiguous cutoff describes it at all.

    Falls back to the contiguous ``serialize_window`` of the corpus bounds, and
    then to ``today - window_days``, when the day-list read is unavailable: the
    drain must still run, and a cutoff that is too old only costs budget
    ordering, never correctness.
    """
    try:
        days = content_source_days(user_id, window_days)
    except Exception:
        log.exception("label_recency_start: content source days unavailable")
        days = []
    if days:
        return days[0]

    try:
        bounds = event_date_bounds(user_id)
    except Exception:
        log.exception("label_recency_start: event date bounds unavailable")
        bounds = None

    window = serialize_window(bounds, window_days)
    if window is None:
        return _utc_today() - timedelta(days=window_days)
    return window[0]


# ── Activities ─────────────────────────────────────────────────────────────────


def _snapshot_reserialize_queue(
    user_id: str,
) -> tuple[dict[date, datetime] | None, str]:
    """
    The queue snapshot serialize_token_stream drains, and why it is None if so.

    ``"unavailable"`` is deploy skew (the sidecar is running ahead of the API
    migration that creates the table); ``"error"`` is any other failed read.
    Neither may stop the serialize pass, which never depended on the queue.
    """
    from ci.hbpe.pipeline import reserialize_queue

    try:
        queued = reserialize_queue.snapshot(user_id)
    except Exception:
        log.exception("serialize: re-serialize queue unreadable; no drain this run")
        return None, "error"
    return (queued, "ok") if queued is not None else (None, "unavailable")


def _drain_reserialize_queue(
    user_id: str,
    snapshot: tuple[dict[date, datetime] | None, str],
    visited: set[date],
    today: date,
    serializer,
) -> dict:
    """reserialize_queue.drain under RESERIALIZE_DAY_CAP, never raising."""
    from ci.hbpe.pipeline import reserialize_queue

    queued, status = snapshot
    if queued is None:
        return {"status": status}
    try:
        return reserialize_queue.drain(
            user_id,
            queued,
            visited=visited,
            today=today,
            cap=RESERIALIZE_DAY_CAP,
            serializer=serializer,
        )
    except Exception as exc:
        # The pass has already published the budget, and the queue rows are
        # still there for the next run: failing the step here would abort a
        # bootstrap over work that is purely additive.
        log.exception("serialize: re-serialize queue drain failed")
        return {"status": "error", "error": str(exc)}


async def serialize_token_stream(user_id: str) -> dict:
    """
    Serialize all labeled events/content into hbpe.token_stream, then drain the
    re-serialize queue (days outside that list whose source changed).
    """

    def _run() -> dict:
        from ci.hbpe.tokenizer.serializer import TokenSerializer

        today = _utc_today()
        # The queue is read BEFORE the day list, not after the pass. Every
        # serialize_day below then reads its sources after the change behind
        # each snapshotted row had committed, which is what lets a queued day
        # the pass visits be settled without a second visit. See
        # reserialize_queue.
        queued = _snapshot_reserialize_queue(user_id)

        # Days that hold data — a budget of SERIALIZE_WINDOW_DAYS + 1 of them,
        # with EVENT_DAY_FLOOR reserved for event-bearing days — plus up to
        # PURGE_DAY_CAP source-less days whose stale tokens still need purging.
        # Not every day between MIN and MAX: the same number of serialize_day
        # calls as a contiguous 90-day range, but on a bimodal corpus (imported
        # events two years old, hourly summaries still being written today) the
        # list holds both ends instead of only the live one. See
        # token_source_days.
        content, purge = _token_source_rows(user_id, SERIALIZE_WINDOW_DAYS, today)
        days = sorted(content + purge)
        serializer = TokenSerializer()
        if not days:
            # No token row at or before today survives an empty day list (the
            # purge tier would have listed it), so this drain only consumes:
            # it keeps the queue converging for a user whose corpus emptied.
            requeue = _drain_reserialize_queue(
                user_id, queued, set(), today, serializer
            )
            # One extra query, only on the empty path, to keep the two legacy
            # reason strings apart: they are the operator's only signal for why
            # a bootstrap aborted with no_token_data, and the day list clamps
            # future dates away so it cannot tell "nothing" from "all future".
            bounds = event_date_bounds(user_id)
            reason = "no_events" if bounds is None else "only_future_events"
            return {"rows": 0, "reason": reason, "reserialize_queue": requeue}

        total_rows = sum(serializer.serialize_day(user_id, d.isoformat()) for d in days)
        # After the pass, so a queued day the pass rewrote is settled rather
        # than rewritten twice; before the rollups, so they see the rewrites.
        requeue = _drain_reserialize_queue(
            user_id, queued, set(days), today, serializer
        )
        from ci.hbpe.pipeline.token_rollup import rebuild_token_rollups

        rollup = rebuild_token_rollups(user_id)
        # start/end describe the CONTENT tiers, not the merged list. A purge day
        # can sit years behind the corpus the model actually trains on, so
        # reporting days[0] made the nightly result claim a start date for an
        # appliance whose model corpus begins months later — the same days[0]
        # conflation that let the purge tier hijack label_recency_start. Purge
        # days are counted separately because they are delete-only work, and
        # the queue's rewrites under their own key: "rows" stays the budget's.
        return {
            "rows": total_rows,
            "start": content[0].isoformat() if content else None,
            "end": content[-1].isoformat() if content else None,
            "days": len(content),
            "purge_days": len(purge),
            "reserialize_queue": requeue,
            "rollup": rollup,
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def train_hmt_model(user_id: str) -> dict:
    """L0 MAE pre-training followed by HMT joint fine-tuning."""

    def _run() -> dict:
        from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
        from ci.hbpe.model.trainer import train_hmt_joint, train_l0_mae

        splits = make_splits(user_id)
        extra: list[list[dict]] = []
        try:
            from ci.hbpe.pipeline.token_rollup import fetch_rollup_days

            extra = [_rollup_as_day(day) for day in fetch_rollup_days(user_id)]
        except Exception:
            extra = []
        train_ds = TokenStreamDataset(user_id, splits["train"], extra)
        val_ds = TokenStreamDataset(user_id, splits["val"])

        if len(train_ds) == 0:
            return {"skipped": True, "reason": "no_training_data"}

        l0_ckpt = train_l0_mae(user_id, train_ds, val_ds)
        hmt_ckpt = train_hmt_joint(user_id, train_ds, val_ds)

        return {
            "l0_checkpoint": str(l0_ckpt),
            "hmt_checkpoint": str(hmt_ckpt),
            "train_days": len(train_ds),
            "val_days": len(val_ds),
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def calibrate_and_export_onnx(user_id: str) -> dict:
    """Temperature calibration + ONNX FP32 export + INT8 quantization."""

    def _run() -> dict:
        from ci.hbpe.model.calibration import calibrate
        from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
        from ci.hbpe.model.onnx_export import export_and_quantize

        splits = make_splits(user_id)
        val_ds = TokenStreamDataset(user_id, splits["val"])
        test_ds = TokenStreamDataset(user_id, splits["test"])

        calibrate(user_id, val_ds)
        rep = export_and_quantize(user_id, val_ds, test_ds)

        return {
            "fp32_mb": rep["fp32_size_mb"],
            "int8_mb": rep["int8_size_mb"],
            "l0_acc_int8": rep["l0_acc_int8"],
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


def _rollup_as_day(day: dict) -> list[dict]:
    from ci.hbpe.buckets import BUCKETS_PER_DAY

    body = [
        {
            "level": t["level"],
            "token_id": t["token_id"],
            "soft_prob": t["soft_prob"],
            "bucket_idx": t["bucket_idx"],
        }
        for t in day["tokens"]
    ]
    return [
        {"level": "SOD", "token_id": "SOD", "soft_prob": [1.0], "bucket_idx": 0},
        *body,
        {
            "level": "EOD",
            "token_id": "EOD",
            "soft_prob": [1.0],
            "bucket_idx": BUCKETS_PER_DAY - 1,
        },
    ]
