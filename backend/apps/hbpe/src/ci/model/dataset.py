"""
HMT Dataset — loads token sequences from hbpe.token_stream for model training.

Provides:
  • TokenStreamDataset   — PyTorch Dataset over one split (train/val/test)
  • make_splits          — stratified day-of-week split with 14-day held-out test

Split strategy (CI-HBPE-SPEC-001 §T2.1):
  1. Test  — the most recent 14 calendar days (chronologically held-out).
  2. Val   — 15% of remaining days, sampled to preserve day-of-week distribution.
  3. Train — everything else.

Each sample is one day's full token sequence as a list of dicts:
  [{"level": "SOD", "token_id": "SOD", "soft_prob": [1.0], "bucket_idx": 0}, ...]

Implements T2.1 (CI-Server-oj3).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Literal

import psycopg2.extras

from ci.database import get_conn

log = logging.getLogger(__name__)

Split = Literal["train", "val", "test"]

VAL_FRACTION = 0.15
TEST_DAYS = 14


def make_splits(user_id: str) -> dict[Split, list[str]]:
    """
    Return {"train": [...dates], "val": [...dates], "test": [...dates]}.

    Dates are ISO strings (YYYY-MM-DD), sorted chronologically within each split.
    Test is always the last TEST_DAYS dates.  Val is sampled from the remainder
    to preserve day-of-week balance.
    """
    import random

    dates = _fetch_dates(user_id)
    if len(dates) < TEST_DAYS + 2:
        raise ValueError(
            f"Only {len(dates)} days in hbpe.token_stream for user {user_id}. "
            f"Need at least {TEST_DAYS + 2}."
        )

    # Chronological split: last TEST_DAYS → test
    test_dates = dates[-TEST_DAYS:]
    remaining = dates[:-TEST_DAYS]

    # Stratified val sample by day-of-week
    from datetime import date as date_cls
    by_dow: dict[int, list[str]] = defaultdict(list)
    for d in remaining:
        by_dow[date_cls.fromisoformat(d).weekday()].append(d)

    val_dates: list[str] = []
    for dow_dates in by_dow.values():
        n_val = max(1, round(len(dow_dates) * VAL_FRACTION))
        sampled = random.sample(dow_dates, min(n_val, len(dow_dates)))
        val_dates.extend(sampled)

    val_set = set(val_dates)
    train_dates = [d for d in remaining if d not in val_set]

    splits: dict[Split, list[str]] = {
        "train": sorted(train_dates),
        "val":   sorted(val_dates),
        "test":  sorted(test_dates),
    }

    log.info(
        "Dataset splits: train=%d val=%d test=%d days",
        len(train_dates), len(val_dates), len(test_dates),
    )
    return splits


class TokenStreamDataset:
    """
    Iterable dataset over one split's token sequences.

    Each item is a list of token dicts for one day, in seq_order:
        [{"level", "token_id", "soft_prob", "bucket_idx"}, ...]

    Usage:
        splits = make_splits(user_id)
        train_ds = TokenStreamDataset(user_id, splits["train"])
        for day_tokens in train_ds:
            ...
    """

    def __init__(self, user_id: str, dates: list[str]) -> None:
        self.user_id = user_id
        self.dates = dates

    def __len__(self) -> int:
        return len(self.dates)

    def __getitem__(self, idx: int) -> list[dict]:
        return _fetch_day(self.user_id, self.dates[idx])

    def __iter__(self):
        for date in self.dates:
            yield _fetch_day(self.user_id, date)


# ── DB helpers ────────────────────────────────────────────────────────────────


def _fetch_dates(user_id: str) -> list[str]:
    """Return all dates in hbpe.token_stream for the user, sorted ascending."""
    sql = """
        SELECT DISTINCT date::text
        FROM hbpe.token_stream
        WHERE user_id = %s
        ORDER BY date
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (user_id,))
            return [row[0] for row in cur.fetchall()]


def _fetch_day(user_id: str, date: str) -> list[dict]:
    """Return the full token sequence for one day, ordered by seq_order."""
    sql = """
        SELECT level, token_id, soft_prob, bucket_idx
        FROM hbpe.token_stream
        WHERE user_id = %s AND date = %s
        ORDER BY seq_order
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (user_id, date))
            return [dict(r) for r in cur.fetchall()]
