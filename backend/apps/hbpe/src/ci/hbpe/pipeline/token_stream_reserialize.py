"""
Re-serialize hbpe.token_stream after bucket-resolution changes.

The 15-minute migration widened bucket indices from 0..47 to 0..95. Existing
rows keep stale indices until re-serialized from events/summaries. Inference
also remaps legacy rows at read time (see inference_engine.py), but re-
serializing fixes training, recurrence, and transition smoothing at the source.
"""

from __future__ import annotations

import datetime
import logging

from ci.hbpe.buckets import LEGACY_MAX_BUCKET_INDEX, MAX_BUCKET_INDEX
from ci.hbpe.database import get_conn
from ci.hbpe.tokenizer.serializer import TokenSerializer

log = logging.getLogger(__name__)

_DATE_BOUNDS_SQL = """
    WITH days AS (
        SELECT start_time::date AS d
        FROM ci.events
        WHERE user_id = %s
          AND is_deleted = FALSE
          AND start_time >= '2010-01-01'::timestamptz
        UNION
        SELECT period_start::date AS d
        FROM ci.summaries
        WHERE user_id = %s
          AND period_start >= '2010-01-01'::timestamptz
        UNION
        SELECT date AS d
        FROM hbpe.token_stream
        WHERE user_id = %s
    )
    SELECT MIN(d), MAX(d) FROM days
"""

_LEGACY_DAYS_SQL = """
    SELECT EXISTS (
        SELECT 1
        FROM hbpe.token_stream
        WHERE user_id = %s
          AND token_id = 'EOD'
          AND bucket_idx = %s
    )
"""


def _fetch_date_bounds(user_id: str) -> tuple[datetime.date, datetime.date] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_DATE_BOUNDS_SQL, (user_id, user_id, user_id))
            row = cur.fetchone()
    if not row or row[0] is None or row[1] is None:
        return None
    return row[0], row[1]


def has_legacy_token_days(user_id: str) -> bool:
    """True when any serialized day still has legacy EOD at bucket 47."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_LEGACY_DAYS_SQL, (user_id, LEGACY_MAX_BUCKET_INDEX))
            return bool(cur.fetchone()[0])


def has_15min_token_days(user_id: str) -> bool:
    """True when any serialized day uses current 15-min EOD at bucket 95."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM hbpe.token_stream
                    WHERE user_id = %s
                      AND token_id = 'EOD'
                      AND bucket_idx = %s
                )
                """,
                (user_id, MAX_BUCKET_INDEX),
            )
            return bool(cur.fetchone()[0])


def reserialize_full(user_id: str) -> dict:
    """Re-serialize the full event/summary/token_stream date span."""
    bounds = _fetch_date_bounds(user_id)
    if bounds is None:
        return {"rows": 0, "reason": "no_dates"}

    start, end = bounds
    today = datetime.date.today()
    end = min(end, today)
    total = TokenSerializer().serialize_range(user_id, str(start), str(end))
    return {
        "rows": total,
        "start": str(start),
        "end": str(end),
        "mode": "full",
        "legacy_migrated": has_legacy_token_days(user_id) is False,
    }


def reserialize_for_user(user_id: str, recent_days: int = 7) -> dict:
    """
    Nightly re-serialize entry point.

    When legacy 30-min rows remain, re-serialize the full span once. Otherwise
    refresh only the recent window so new events and summaries land at 15-min
    indices without rewriting all of history every night.
    """
    bounds = _fetch_date_bounds(user_id)
    if bounds is None:
        return {"rows": 0, "reason": "no_dates"}

    start, end = bounds
    today = datetime.date.today()
    end = min(end, today)
    serializer = TokenSerializer()

    if has_legacy_token_days(user_id):
        log.info(
            "Legacy 30-min token_stream detected — full re-serialize user=%s",
            user_id[:8],
        )
        total = serializer.serialize_range(user_id, str(start), str(end))
        return {
            "rows": total,
            "start": str(start),
            "end": str(end),
            "mode": "full_legacy_migration",
            "legacy_migrated": not has_legacy_token_days(user_id),
        }

    recent_start = max(start, today - datetime.timedelta(days=recent_days))
    total = serializer.serialize_range(user_id, str(recent_start), str(end))
    return {
        "rows": total,
        "start": str(recent_start),
        "end": str(end),
        "mode": "recent",
        "legacy_migrated": False,
    }
