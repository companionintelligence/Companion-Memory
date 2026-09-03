"""
90-day multi-resolution training corpus.

Raw token_stream stays the source of truth for recurrence. Archetypes live in
hbpe.token_stream_rollup so they cannot double-count occurrence days.
"""

from __future__ import annotations

import datetime
import logging
from collections import Counter, defaultdict

import psycopg2.extras

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.database import get_conn

log = logging.getLogger(__name__)

RAW_DAYS = 30
ROLLUP_TO = 90
WEEKDAY_WEIGHT = 0.6
PRIOR_YEAR_WEIGHT = 0.4


def rebuild_token_rollups(user_id: str) -> dict:
    today = datetime.datetime.utcnow().date()
    weekly = _build_weekly(user_id, today)
    prior = _build_prior_year(user_id, today)
    _replace_rows(user_id, weekly + prior)
    log.info(
        "token_rollup user=%s weekly=%d prior_year=%d",
        user_id[:8],
        len(weekly),
        len(prior),
    )
    return {"weekly": len(weekly), "prior_year": len(prior)}


def _build_weekly(user_id: str, today: datetime.date) -> list[tuple]:
    start = today - datetime.timedelta(days=ROLLUP_TO)
    end = today - datetime.timedelta(days=RAW_DAYS)
    rows = _load_tokens(user_id, start, end)
    by_week: dict[tuple[datetime.date, str], list[dict]] = defaultdict(list)
    for row in rows:
        d = row["date"]
        kind = "weekend" if d.weekday() >= 5 else "weekday"
        monday = d - datetime.timedelta(days=d.weekday())
        by_week[(monday, kind)].append(row)

    out: list[tuple] = []
    for (monday, kind), tokens in by_week.items():
        # Fold the weekday/weekend split into `tier` itself: both groups
        # otherwise share (user_id, period_start, tier) and _archetype_rows
        # restarts seq_order at 0 for each call, colliding on
        # hbpe.token_stream_rollup's primary key.
        tier = f"weekly_{kind}"
        out.extend(_archetype_rows(user_id, monday, tier, WEEKDAY_WEIGHT, tokens))
    return out


def _build_prior_year(user_id: str, today: datetime.date) -> list[tuple]:
    this_monday = today - datetime.timedelta(days=today.weekday())
    prior_monday = this_monday - datetime.timedelta(days=364)
    start = prior_monday - datetime.timedelta(days=7)
    end = prior_monday + datetime.timedelta(days=14)
    rows = _load_tokens(user_id, start, end)
    if not rows:
        return []
    return _archetype_rows(user_id, prior_monday, "prior_year", PRIOR_YEAR_WEIGHT, rows)


def _archetype_rows(
    user_id: str,
    period_start: datetime.date,
    tier: str,
    weight: float,
    tokens: list[dict],
) -> list[tuple]:
    votes: dict[tuple[int, str], Counter] = defaultdict(Counter)
    for row in tokens:
        votes[(int(row["bucket_idx"]), row["level"])][row["token_id"]] += 1

    seq = 0
    out: list[tuple] = []
    for bucket in range(BUCKETS_PER_DAY):
        for level in ("L0", "L1", "L2"):
            counter = votes.get((bucket, level))
            if not counter:
                continue
            token_id, n = counter.most_common(1)[0]
            freq = n / max(sum(counter.values()), 1)
            out.append(
                (
                    user_id,
                    period_start,
                    tier,
                    seq,
                    bucket,
                    level,
                    token_id,
                    [float(freq)],
                    weight,
                )
            )
            seq += 1
    return out


def _load_tokens(user_id: str, start: datetime.date, end: datetime.date) -> list[dict]:
    sql = """
        SELECT date, bucket_idx, level, token_id
        FROM hbpe.token_stream
        WHERE user_id = %s AND date >= %s AND date < %s
          AND level IN ('L0', 'L1', 'L2')
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), start, end))
            return [dict(r) for r in cur.fetchall()]


def _replace_rows(user_id: str, rows: list[tuple]) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM hbpe.token_stream_rollup WHERE user_id = %s",
                (str(user_id),),
            )
            if rows:
                psycopg2.extras.execute_batch(
                    cur,
                    """
                    INSERT INTO hbpe.token_stream_rollup
                        (user_id, period_start, tier, seq_order, bucket_idx,
                         level, token_id, soft_prob, weight)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    rows,
                )


def fetch_rollup_days(user_id: str) -> list[dict]:
    """Sequences keyed by (period_start, tier) for the trainer."""
    sql = """
        SELECT period_start::text, tier, weight, seq_order, bucket_idx, level, token_id, soft_prob
        FROM hbpe.token_stream_rollup
        WHERE user_id = %s
        ORDER BY period_start, tier, seq_order
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id),))
            rows = [dict(r) for r in cur.fetchall()]
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        grouped[(row["period_start"], row["tier"])].append(row)
    return [
        {
            "date": period,
            "tier": tier,
            "weight": tokens[0]["weight"] if tokens else 1.0,
            "tokens": tokens,
        }
        for (period, tier), tokens in grouped.items()
    ]
