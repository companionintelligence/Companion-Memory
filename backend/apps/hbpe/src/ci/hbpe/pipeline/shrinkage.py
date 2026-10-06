"""
Recency-weighted hierarchical shrinkage, and a transition matrix that does not
collapse into the majority class.

Two things in the baseline family are mis-specified rather than merely simple.

**Fixed Laplace.** ``hmm.LAPLACE = 1.0`` adds one count of a *uniform* prior to
every cell, whatever that cell already holds. A (bucket, day-of-week) cell with
forty observations barely notices; a cell with one observation is dragged most
of the way to uniform. B1 slices by weekday, so its cells hold seven times less
than B0's and it takes the damage where it is worst. The measured symptom is
B1 posting the best top-1 in the table alongside an ECE three times B0's: not
inaccurate, just described with the wrong confidence.

The fix is the standard one. Shrink each cell toward its *parent* rather than
toward uniform, with a single strength ``k`` interpreted as a count:
(bucket, dow) shrinks to (bucket), which shrinks to the global marginal. A cell
with n observations and strength k lands n/(n+k) of the way to its own
empirical distribution, so thin cells inherit structure instead of being
flattened.

**No recency.** Pooled counts treat a Tuesday from twelve weeks ago exactly like
last Tuesday. The evidence that this is wrong is already in the table:
``persistence`` — literally the single most recent matching weekday, with
uniform for anything that day did not observe — beats B1 on Brier and by
threefold on ECE. A routine that drifts is better described by recent evidence
than by more evidence. Counts here are weighted by an exponential half-life.

**Transitions.** ``laplace_transitions`` adds a flat 1.0 to every from→to cell.
Dayparts where one class dominates end up with a row that is nearly all
self-transition, and ``forward_backward`` then drags the whole day into that
class — which is exactly what B2 does on a densified corpus, scoring the
majority-class base rate with zero recall on every other class. Shrinking each
transition row toward the *marginal* class distribution instead of toward
uniform keeps the row honest about where mass actually goes.
"""

from __future__ import annotations

import datetime
from collections.abc import Sequence

import numpy as np

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.pipeline.baselines import CLASS_INDEX, N_CLASSES, _as_date
from ci.hbpe.pipeline.hmm import N_DAYPARTS, daypart_of

# Half-life in days for recency weighting. Three weeks: long enough that a
# weekday cell still accumulates ~3 same-weekday observations inside one
# half-life, short enough that a routine change from two months ago is worth
# a quarter of a recent one.
DEFAULT_HALF_LIFE_DAYS = 21.0

# Shrinkage strength, in units of observations. A cell needs k observations of
# its own before it is weighted equally with its parent. 4 is deliberately
# small: the parent is already an informed distribution, unlike uniform.
DEFAULT_K = 4.0

# Transition rows shrink harder. A daypart's from→to row is estimated from
# consecutive-bucket pairs, which on a sparse corpus can be a handful.
DEFAULT_TRANSITION_K = 8.0


def weighted_counts(
    history: Sequence[dict],
    target_date: datetime.date,
    *,
    n_buckets: int = BUCKETS_PER_DAY,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    ``occupancy_counts`` with an exponential recency weight.

    Returns ``(b0, b1, transitions)`` shaped as ``occupancy_counts`` returns
    them, but carrying fractional weights rather than integer counts. Every
    consumer below treats a count as a pseudo-observation, so fractional is
    fine.
    """
    b0 = np.zeros((n_buckets, N_CLASSES), dtype=np.float64)
    b1 = np.zeros((n_buckets, 7, N_CLASSES), dtype=np.float64)
    trans = np.zeros((N_DAYPARTS, N_CLASSES, N_CLASSES), dtype=np.float64)

    decay = np.log(2.0) / max(half_life_days, 1e-6)
    by_day: dict[datetime.date, dict[int, int]] = {}
    weight_of: dict[datetime.date, float] = {}

    for row in history:
        day = _as_date(row["date"])
        idx = CLASS_INDEX.get(str(row.get("token_id") or ""))
        if idx is None:
            continue
        bucket = int(row["bucket_idx"])
        if bucket < 0 or bucket >= n_buckets:
            continue
        if day not in weight_of:
            age = (target_date - day).days
            weight_of[day] = float(np.exp(-decay * max(age, 0)))
        w = weight_of[day]
        b0[bucket, idx] += w
        b1[bucket, day.weekday(), idx] += w
        by_day.setdefault(day, {})[bucket] = idx

    for day, buckets in by_day.items():
        w = weight_of[day]
        prev_b, prev_c = None, None
        for bucket in sorted(buckets):
            cls = buckets[bucket]
            if prev_b is not None and bucket == prev_b + 1:
                trans[daypart_of(bucket, n_buckets), prev_c, cls] += w
            prev_b, prev_c = bucket, cls

    return b0, b1, trans


def _shrink(counts: np.ndarray, prior: np.ndarray, k: float) -> np.ndarray:
    """Blend an empirical count vector toward *prior* with strength *k*."""
    total = float(counts.sum())
    return (counts + k * prior) / (total + k)


def shrunk_emissions(
    b0: np.ndarray,
    b1: np.ndarray,
    dow: int,
    *,
    k: float = DEFAULT_K,
) -> np.ndarray:
    """
    ``(n_buckets, N_CLASSES)`` for *dow*, each cell shrunk through its parents.

    (bucket, dow) → (bucket) → global. Each level is a proper distribution, so
    the result is one too without a final renormalisation.
    """
    n_buckets = b0.shape[0]
    global_counts = b0.sum(axis=0)
    total = float(global_counts.sum())
    p_global = (
        global_counts / total
        if total > 0
        else np.full(N_CLASSES, 1.0 / N_CLASSES, dtype=np.float64)
    )

    out = np.empty((n_buckets, N_CLASSES), dtype=np.float64)
    for bucket in range(n_buckets):
        p_bucket = _shrink(b0[bucket], p_global, k)
        out[bucket] = _shrink(b1[bucket, dow], p_bucket, k)
    return out


def balanced_transitions(
    counts: np.ndarray,
    *,
    k: float = DEFAULT_TRANSITION_K,
) -> np.ndarray:
    """
    Row-normalised transitions shrunk toward the marginal *destination*
    distribution rather than toward uniform.

    ``laplace_transitions`` adds a flat count to every cell, which in a daypart
    dominated by one class leaves a row that is overwhelmingly self-transition.
    Using the marginal as the prior keeps a thin row pointed at where mass
    actually goes across the whole daypart instead of at the diagonal.
    """
    c = np.asarray(counts, dtype=np.float64)
    if c.ndim != 3:
        raise ValueError(f"expected (P, C, C), got {c.shape}")

    out = np.empty_like(c)
    for part in range(c.shape[0]):
        marginal = c[part].sum(axis=0)
        total = float(marginal.sum())
        prior = (
            marginal / total
            if total > 0
            else np.full(c.shape[2], 1.0 / c.shape[2], dtype=np.float64)
        )
        for src in range(c.shape[1]):
            out[part, src] = _shrink(c[part, src], prior, k)
    return out
