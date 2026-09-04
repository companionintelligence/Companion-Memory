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

log = logging.getLogger(__name__)

# Serialize budget, in *days that actually hold data* — not in calendar span.
# Older history lives in the recurrence/seasonal SQL, not in the HMT corpus, so
# widening this only makes the overnight slower.
#
# This is also the *binding* constraint on the nightly label drain. A label only
# becomes visible to hbpe.pipeline.recurrence (and therefore to /forecast) once
# serialize turns it into an hbpe.token_stream row, and serialize only ever
# rewrites the days it selects — a day that fell out of the selection before its
# events were labeled is never revisited. So the drain aims at
# ``token_source_days()``, not at recurrence.HISTORY_DAYS (180): labeling the
# 90–180-day band produces no token_stream rows at all, and on the dev corpus
# that band is 5,775 of the 7,192 unlabeled events inside 180 days — 80% of a
# reserved budget share buying nothing. See ``label_recency_start`` below and
# ``nightly_runner.label_unlabeled``.
SERIALIZE_WINDOW_DAYS = 90

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
# That guarantee is bounded, and the bound is worth naming: ``ORDER BY
# source_date DESC LIMIT 91`` takes the newest 91 days-with-data, full stop. On
# an appliance that has BOTH an archival import and continuous live capture, the
# hourly summaries accrue one day-with-data per calendar day, so ~91 days after
# the import the 2024 event days are evicted and the historical corpus stops
# reaching hbpe.token_stream again — the same failure a contiguous trailing
# window has on day one, deferred by about three months rather than removed.
# Fixing that properly means reserving a share of the budget for event-bearing
# days (the summary branch would then be capped rather than allowed to fill the
# whole list); that is a policy change, not a query change, and is deliberately
# not made here.
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
# too, or its tokens land only on days something else selected.
_TOKEN_SOURCE_DAYS_SQL = """
    SELECT source_date
    FROM (
        SELECT DISTINCT e.start_time::date AS source_date
        FROM ci.events e
        WHERE e.user_id = %s::uuid
          AND e.is_deleted = FALSE
          AND e.start_time >= '2010-01-01'::timestamptz
          AND e.start_time < (%s::date + INTERVAL '1 day')

        UNION

        SELECT DISTINCT s.period_start::date AS source_date
        FROM ci.summaries s
        WHERE s.user_id = %s::uuid
          AND s.period_type = 'hourly'
          AND s.period_start >= '2010-01-01'::timestamptz
          AND s.period_start < (%s::date + INTERVAL '1 day')

        UNION

        -- Days that no longer hold anything but still hold stale tokens.
        -- serialize_day's DELETE is the only thing that ever purges a day, and
        -- it only runs on days this query returns. Without this branch a day
        -- that EMPTIES OUT — the sole event on it soft-deleted by
        -- CalendarEventService, or its start_time edited onto another day —
        -- drops out of the two source branches above and is never visited
        -- again, so its rows sit in hbpe.token_stream forever while
        -- pipeline.recurrence and HMT training keep reading them: a deleted
        -- event still nudging the forecast. The old contiguous
        -- serialize_range(start, end) purged such days for free, because it
        -- walked every calendar day in the window whether or not it held data.
        --
        -- These days compete for the same LIMIT budget rather than being added
        -- on top of it. An emptied day is self-limiting: the run that visits it
        -- deletes its rows, so it contributes to neither this branch nor the
        -- source branches on the next run and stops consuming a slot. Adding
        -- them on top would instead let a bulk delete (a whole year of events
        -- removed) inflate one night's serialize_day count without bound, and
        -- the slot a purge borrows is given back the same night.
        SELECT DISTINCT ts.date AS source_date
        FROM hbpe.token_stream ts
        WHERE ts.user_id = %s::uuid
          AND ts.date < (%s::date + INTERVAL '1 day')
    ) token_days
    ORDER BY source_date DESC
    LIMIT %s
"""

_TOKEN_DATE_BOUNDS_SQL = """
    SELECT MIN(source_date), MAX(source_date)
    FROM (
        SELECT e.start_time::date AS source_date
        FROM ci.events e
        WHERE e.user_id = %s::uuid
          AND e.is_deleted = FALSE
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


def token_source_days(
    user_id: str,
    window_days: int = SERIALIZE_WINDOW_DAYS,
    today: date | None = None,
) -> list[date]:
    """
    The calendar days the next serialize run will write, oldest first.

    The most recent ``window_days + 1`` distinct days that hold an event, an
    hourly summary, or stale hbpe.token_stream rows, with nothing dated after
    ``today``. The ``+ 1`` keeps the same day budget the old inclusive
    ``[end - window_days, end]`` range had, so switching from a range to a list
    does not silently shave a day off every appliance's corpus.

    The token_stream branch is what lets a day that emptied out be purged: see
    _TOKEN_SOURCE_DAYS_SQL, and serialize_day, whose DELETE is the only purge
    there is.

    The clamp lives in SQL, not in Python: a future-dated row (a calendar
    reminder, a booked flight, an import with a bad date) that survived into the
    result would consume one of the ``LIMIT`` slots and push a real day out of
    the budget. Everything downstream (recurrence 180d, token_rollup 90d,
    seasonal 800d) anchors on today, so a serialized future day is work nothing
    can ever read.

    Returns ``[]`` when the user has no dated source at or before today — an
    empty corpus, or one that is entirely in the future.
    """
    from ci.hbpe.database import get_conn

    end = today or _utc_today()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                _TOKEN_SOURCE_DAYS_SQL,
                (user_id, end, user_id, end, user_id, end, window_days + 1),
            )
            rows = cur.fetchall()

    days = [date.fromisoformat(str(r[0])) for r in rows if r and r[0] is not None]
    days.sort()
    return days


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
    of the days the *next* serialize run will write.

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
        days = token_source_days(user_id, window_days)
    except Exception:
        log.exception("label_recency_start: token source days unavailable")
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


async def serialize_token_stream(user_id: str) -> dict:
    """Serialize all labeled events/content into hbpe.token_stream."""

    def _run() -> dict:
        from ci.hbpe.tokenizer.serializer import TokenSerializer

        # Days that hold data (plus any day whose stale tokens still need
        # purging), capped at SERIALIZE_WINDOW_DAYS, rather than every day
        # between MIN and MAX: same number of serialize_day calls as a
        # contiguous 90-day range, but on a bimodal corpus (imported events two
        # years old, hourly summaries still being written today) the list holds
        # both ends instead of only the live one. See token_source_days.
        days = token_source_days(user_id)
        if not days:
            # One extra query, only on the empty path, to keep the two legacy
            # reason strings apart: they are the operator's only signal for why
            # a bootstrap aborted with no_token_data, and the day list clamps
            # future dates away so it cannot tell "nothing" from "all future".
            bounds = event_date_bounds(user_id)
            reason = "no_events" if bounds is None else "only_future_events"
            return {"rows": 0, "reason": reason}

        serializer = TokenSerializer()
        total_rows = sum(serializer.serialize_day(user_id, d.isoformat()) for d in days)
        from ci.hbpe.pipeline.token_rollup import rebuild_token_rollups

        rollup = rebuild_token_rollups(user_id)
        return {
            "rows": total_rows,
            "start": days[0].isoformat(),
            "end": days[-1].isoformat(),
            "days": len(days),
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
