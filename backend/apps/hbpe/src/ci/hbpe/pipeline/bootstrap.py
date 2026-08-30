"""
Bootstrap pipeline — full cold-start training through ONNX export.

Triggered when no HMT checkpoint exists (new user / fresh volume). After this
completes, the nightly pipeline (ci.hbpe.functions.nightly) takes over for
incremental updates. Orchestrated by ci.hbpe.functions.bootstrap.

Step order (mirrors run_pipeline.py steps 2–11):
  1. label_unlabeled      — assign L0/L1 to all events and content
  2. label_summary_tokens — assign L0/L1 to all hourly summaries
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

# Raw serialize window, in days. Older history lives in the recurrence/seasonal
# SQL, not in the HMT corpus, so widening this only makes the overnight slower.
#
# This is also the *binding* constraint on the nightly label drain. A label only
# becomes visible to hbpe.pipeline.recurrence (and therefore to /forecast) once
# serialize turns it into an hbpe.token_stream row, and serialize only ever
# rewrites the days inside this window — a day that fell out of it before its
# events were labeled is never revisited. So the drain aims at
# ``serialize_window()``, not at recurrence.HISTORY_DAYS (180): labeling the
# 90–180-day band produces no token_stream rows at all, and on the dev corpus
# that band is 5,775 of the 7,192 unlabeled events inside 180 days — 80% of a
# reserved budget share buying nothing. See ``label_recency_start`` below and
# ``nightly_runner.label_unlabeled``.
SERIALIZE_WINDOW_DAYS = 90

_EVENT_DATE_BOUNDS_SQL = """
    SELECT MIN(start_time::date), MAX(start_time::date)
    FROM ci.events
    WHERE user_id = %s AND is_deleted = FALSE
      AND start_time >= '2010-01-01'::timestamptz
"""


def _utc_today() -> date:
    """Today in UTC. A named seam so tests can pin the serialize window."""
    return datetime.now(UTC).date()


def event_date_bounds(user_id: str) -> tuple[date, date] | None:
    """
    First and last calendar day this user has events on, or ``None`` for none.

    Shared by the serializer and by the nightly label drain so the two aim at
    the same window; see ``serialize_window``.
    """
    from ci.hbpe.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_EVENT_DATE_BOUNDS_SQL, (user_id,))
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
    The ``(start, end)`` day range the next serialize run will write, inclusive,
    or ``None`` when there is nothing it can write.

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
    day of the window the *next* serialize run will write.

    This is the boundary the nightly drain splits its two phases on, so the
    recency phase covers exactly the events a serialize run can still pick up.
    Deriving it from the corpus rather than from ``today`` matters when
    ingestion lags: with MAX(start_time) three days behind, serialize writes
    ``[today-93, today-3]``, and a cutoff of ``today-90`` would leave three of
    those days to the oldest-first historical phase — which reaches them last,
    so they would be serialized with their events still unlabeled.

    Falls back to ``today - window_days`` when the corpus is empty, entirely
    future-dated, or unreadable: the drain must still run, and that fallback is
    the window serialize would use for a corpus that starts arriving today.
    """
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

        bounds = event_date_bounds(user_id)
        if bounds is None:
            return {"rows": 0, "reason": "no_events"}

        # Cap the raw serialize window at SERIALIZE_WINDOW_DAYS so overnight
        # stays cheap; see serialize_window() for the clamp-to-today reasoning.
        window = serialize_window(bounds)
        if window is None:
            # Every event this user has is in the future. Say so explicitly
            # instead of emitting a start > end range.
            return {"rows": 0, "reason": "only_future_events"}
        start, end = window
        total_rows = TokenSerializer().serialize_range(
            user_id, start.isoformat(), end.isoformat()
        )
        from ci.hbpe.pipeline.token_rollup import rebuild_token_rollups

        rollup = rebuild_token_rollups(user_id)
        return {
            "rows": total_rows,
            "start": start.isoformat(),
            "end": end.isoformat(),
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
