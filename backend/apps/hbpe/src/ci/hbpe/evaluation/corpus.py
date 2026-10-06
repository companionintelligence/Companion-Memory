"""
Corpus access for walk-forward evaluation.

The existing baseline path (``pipeline/baselines.py``) can only score days that
were actually *served*: it reads actuals out of ``hbpe.prediction_log``, which
is written by ``histogram_api.build_histogram`` and backfilled by
``actuals_backfill``.  A forecaster that has never been deployed therefore has
nothing to score against, and history predating the first served forecast is
invisible.

This module derives both history and actuals from ``hbpe.token_stream``
instead — the same table ``occupancy_counts`` fits on — so every day in the
corpus becomes an evaluation day and a candidate forecaster can be measured
offline before it is ever wired to the API.

Bucket collision convention
───────────────────────────
When two L0 tokens land in the same bucket, the later row in iteration order
wins.  This is not obviously the *right* rule, but it is the rule
``occupancy_counts`` already applies when fitting B0/B1/B2
(``baselines.py``: ``by_day[day][b] = idx``).  Matching it matters more than
improving it: if the actuals used a different rule than the baselines were fit
under, every comparison in this harness would carry a constant, invisible bias.
"""

from __future__ import annotations

import datetime
from collections.abc import Sequence

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.pipeline.baselines import _as_date
from ci.hbpe.pipeline.rhythm import DEFAULT_BACKGROUND, densify
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

_L0_SET = frozenset(L0_CLASSES)

# Re-exported: densification moved to ``pipeline.rhythm`` so the serving
# path can densify its own history without importing an evaluation module.
__all__ = [
    "DEFAULT_BACKGROUND",
    "actuals_for_day",
    "corpus_dates",
    "densify",
    "eval_dates",
    "history_before",
]


def corpus_dates(rows: Sequence[dict]) -> list[datetime.date]:
    """Every distinct calendar date present in the token stream, ascending."""
    return sorted({_as_date(r["date"]) for r in rows})


def history_before(rows: Sequence[dict], day: datetime.date) -> list[dict]:
    """
    Rows strictly before *day*.

    The walk-forward loop filters history here and hands the result to the
    forecaster, rather than passing the full corpus plus an ``until`` argument
    and trusting each forecaster to honour it.  A forecaster that ignores the
    cutoff then cannot leak, because it was never given the future rows.
    """
    return [r for r in rows if _as_date(r["date"]) < day]


def actuals_for_day(
    rows: Sequence[dict],
    day: datetime.date,
    n_buckets: int = BUCKETS_PER_DAY,
) -> dict[int, str]:
    """
    Observed L0 class per bucket on *day*, as ``{bucket_idx: class_name}``.

    Buckets with no token are absent — they are not scored.  Tokens outside the
    fixed L0 taxonomy (special tokens, stale cluster ids) are dropped, matching
    ``occupancy_counts``' ``CLASS_INDEX.get(token)`` guard.
    """
    out: dict[int, str] = {}
    for row in rows:
        if _as_date(row["date"]) != day:
            continue
        token = str(row.get("token_id") or "")
        if token not in _L0_SET:
            continue
        bucket = int(row["bucket_idx"])
        if bucket < 0 or bucket >= n_buckets:
            continue
        out[bucket] = token
    return out


def eval_dates(
    rows: Sequence[dict],
    *,
    min_history_days: int = 14,
    start: datetime.date | None = None,
    end: datetime.date | None = None,
    n_buckets: int = BUCKETS_PER_DAY,
) -> list[datetime.date]:
    """
    Days eligible to be scored.

    A day qualifies when at least *min_history_days* distinct earlier days exist
    in the corpus and the day itself carries at least one L0 actual.  History is
    counted in distinct observed days, not calendar span, so a gap in ingestion
    delays the first eval day instead of silently evaluating against an empty
    fit.
    """
    all_dates = corpus_dates(rows)
    out: list[datetime.date] = []
    for i, day in enumerate(all_dates):
        if i < min_history_days:
            continue
        if start is not None and day < start:
            continue
        if end is not None and day > end:
            continue
        if not actuals_for_day(rows, day, n_buckets):
            continue
        out.append(day)
    return out
