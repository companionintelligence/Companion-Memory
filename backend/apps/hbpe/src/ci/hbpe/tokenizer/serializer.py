"""
Token Serializer — writes [SOD]…[EOD] token streams per user-day to ci.token_stream.

Each token record: (seq_order, bucket_idx, level, token_id, soft_prob).
Re-serializing a day deletes existing rows for that (user_id, date) first.

Token stream layout for a calendar day:
  [SOD] bucket_idx=0,  seq_order=0
  (L0, L1, L2 token triples for each event in chronological order)
  [EOD] bucket_idx=95, seq_order=N

soft_prob is a FLOAT4[] holding the assignment similarity score.  Currently
1-element; the full distribution over all centroids is deferred to Phase 2
training pre-processing.

Implements T1.5 (CI-Server-ub5).
"""

from __future__ import annotations

import logging

import psycopg2.extras

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.database import get_conn

log = logging.getLogger(__name__)

_SOD = {"level": "SOD", "token_id": "SOD", "soft_prob_vector": [1.0], "bucket_idx": 0}
_EOD = {
    "level": "EOD",
    "token_id": "EOD",
    "soft_prob_vector": [1.0],
    "bucket_idx": BUCKETS_PER_DAY - 1,
}

_INSERT_SQL = """
    INSERT INTO hbpe.token_stream
        (user_id, date, seq_order, bucket_idx, level, token_id, soft_prob)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
"""


class TokenSerializer:
    """Serializes a day's token assignments to ci.token_stream."""

    def serialize_day(self, user_id: str, date: str) -> int:
        """
        Write the token stream for one calendar date to ci.token_stream.

        Deletes any existing rows for this (user_id, date) before inserting.
        Returns the number of rows written.
        """
        rows = _fetch_tokens_for_day(user_id, date)
        if not rows:
            return 0

        records = [_SOD, *rows, _EOD]
        db_rows = [
            (
                user_id,
                date,
                i,
                r["bucket_idx"],
                r["level"],
                r["token_id"],
                "{" + ",".join(f"{v:.6f}" for v in r["soft_prob_vector"]) + "}",
            )
            for i, r in enumerate(records)
        ]

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM hbpe.token_stream WHERE user_id = %s AND date = %s",
                    (user_id, date),
                )
                psycopg2.extras.execute_batch(cur, _INSERT_SQL, db_rows)

        log.info(
            "Serialized %d tokens for user=%s date=%s", len(records), user_id, date
        )
        return len(records)

    def serialize_range(
        self,
        user_id: str,
        start_date: str,
        end_date: str,
    ) -> int:
        """
        Serialize all days from start_date to end_date (inclusive, YYYY-MM-DD).

        Returns total number of token rows written across all days.
        """
        from datetime import date, timedelta

        d = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
        total = 0

        while d <= end:
            total += self.serialize_day(user_id, d.isoformat())
            d += timedelta(days=1)

        return total


# ── DB helpers ────────────────────────────────────────────────────────────────


def _fetch_tokens_for_day(user_id: str, date_str: str) -> list[dict]:
    """
    Fetch L0/L1/L2 token records for a user on a calendar date.

    Events (and completed tasks) collapse to one L0+L1 winner per bucket.
    Hourly summaries fill buckets that still have no event-derived coverage.
    """
    from ci.hbpe.data_client import (
        get_completed_tasks_for_day,
        get_token_events_for_day,
    )
    from ci.hbpe.tokenizer.bucket_aggregator import aggregate_day

    events = get_token_events_for_day(user_id, date_str)
    events.extend(get_completed_tasks_for_day(user_id, date_str))
    records = aggregate_day(events)

    try:
        from ci.hbpe.tokenizer.summary_tokenizer import SummaryTokenizer

        summary_records = SummaryTokenizer().get_tokens_for_day(user_id, date_str)
        if summary_records:
            covered_buckets = {r["bucket_idx"] for r in records}
            for sr in summary_records:
                if sr["bucket_idx"] not in covered_buckets:
                    records.append(sr)
            records.sort(key=lambda r: r["bucket_idx"])
    except Exception as exc:
        log.warning("Summary token merge failed (non-fatal): %s", exc)

    return records
