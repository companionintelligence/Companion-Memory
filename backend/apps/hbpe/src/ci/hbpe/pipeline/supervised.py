"""
A supervised head over per-bucket features.

B0, B1 and B2 are contingency tables: each conditions on a fixed key and can
only sharpen a cell by observing that exact cell again. Nothing lets them share
strength between 09:00 and 09:15, or notice that yesterday predicts today
independently of which weekday it was, or use anything outside the token stream.

This fits a multinomial logistic regression over features that carry those
relationships explicitly, refit from scratch on each eval day's history:

    cyclical bucket-of-day at three harmonics   6
    day-of-week one-hot                         7
    weekend flag                                1
    same bucket yesterday, one-hot + missing    9
    same bucket a week ago, one-hot + missing   9
    causal recency-weighted class histogram     8

Features are rebuilt from ``history`` on every call rather than precomputed
once over the corpus. That is slower, and it is what makes the row structurally
leak-proof in the same way the other forecasters are: the model never receives
a row it is not allowed to see, so leaking would take fabricating data rather
than forgetting a cutoff.

Two features that look obvious are deliberately absent. **The previous bucket
of the target day** is the strongest single predictor available and is not
known at prediction time — using it would need sequential decoding, and the
HMM smoother already supplies within-day continuity. **The class histogram
computed as of the eval day** would let a training row from week one see week
ten; the histogram here is accumulated forward, so each row sees only days
before its own.
"""

from __future__ import annotations

import datetime
import warnings
from collections.abc import Sequence

import numpy as np

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.pipeline.baselines import CLASS_INDEX, N_CLASSES, _as_date
from ci.hbpe.pipeline.shrinkage import DEFAULT_HALF_LIFE_DAYS

N_HARMONICS = 3
N_FEATURES = 2 * N_HARMONICS + 7 + 1 + (N_CLASSES + 1) * 2 + N_CLASSES

# Below this many labelled history rows a 40-feature multinomial fit is not
# worth attempting; the caller falls back to the prior it was handed.
MIN_TRAIN_ROWS = 200


def _day_matrix(
    rows: Sequence[dict], n_buckets: int
) -> tuple[list[datetime.date], np.ndarray]:
    """``(days, Y)`` where ``Y[j, b]`` is a class index or -1 for unobserved."""
    by_day: dict[datetime.date, dict[int, int]] = {}
    for row in rows:
        idx = CLASS_INDEX.get(str(row.get("token_id") or ""))
        if idx is None:
            continue
        bucket = int(row["bucket_idx"])
        if bucket < 0 or bucket >= n_buckets:
            continue
        by_day.setdefault(_as_date(row["date"]), {})[bucket] = idx

    days = sorted(by_day)
    y = np.full((len(days), n_buckets), -1, dtype=np.int64)
    for j, day in enumerate(days):
        for bucket, idx in by_day[day].items():
            y[j, bucket] = idx
    return days, y


def _cyclical(n_buckets: int) -> np.ndarray:
    """``(n_buckets, 2 * N_HARMONICS)`` sin/cos of bucket-of-day."""
    frac = np.arange(n_buckets, dtype=np.float64) / n_buckets
    cols = []
    for h in range(1, N_HARMONICS + 1):
        cols.append(np.sin(2.0 * np.pi * h * frac))
        cols.append(np.cos(2.0 * np.pi * h * frac))
    return np.stack(cols, axis=1)


def _onehot_with_missing(values: np.ndarray) -> np.ndarray:
    """``(n, N_CLASSES + 1)``; -1 sets the trailing missing flag instead."""
    out = np.zeros((values.shape[0], N_CLASSES + 1), dtype=np.float64)
    known = values >= 0
    out[known, values[known]] = 1.0
    out[~known, N_CLASSES] = 1.0
    return out


def _build(
    days: Sequence[datetime.date],
    y: np.ndarray,
    n_buckets: int,
    half_life_days: float,
    *,
    target_date: datetime.date | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Features for every row of *y*, plus one extra block for *target_date*.

    Sweeps days ascending maintaining a decayed per-bucket class histogram, and
    snapshots it *before* folding each day in, so row ``j`` sees only days
    ``< j``. When *target_date* is given the final snapshot is returned as an
    extra ``n_buckets`` rows at the end, carrying label -1.

    Returns ``(features, labels, sample_weights)``.
    """
    cyc = _cyclical(n_buckets)
    index_of = {day: j for j, day in enumerate(days)}
    decay_per_day = 0.5 ** (1.0 / max(half_life_days, 1e-6))

    hist = np.zeros((n_buckets, N_CLASSES), dtype=np.float64)
    blocks: list[np.ndarray] = []
    labels: list[np.ndarray] = []

    plan: list[tuple[datetime.date, int]] = [(day, j) for j, day in enumerate(days)]
    if target_date is not None:
        plan.append((target_date, -1))

    # Per-row recency weight, on the same half-life as the histogram feature.
    # The fit itself used to weight every row equally, which was harmless on a
    # 90-day corpus and wrong on a 527-day one: six years of history drowned
    # the recent weeks, and WORK recall fell to 0.117 while `persistence` —
    # literally the most recent matching weekday — led the table at 0.475.
    anchor = target_date or (days[-1] if days else None)
    weights: list[np.ndarray] = []

    previous: datetime.date | None = None
    for day, j in plan:
        if previous is not None:
            gap = (day - previous).days
            if gap > 0:
                hist *= decay_per_day**gap
        previous = day

        snapshot = hist.copy()
        totals = snapshot.sum(axis=1, keepdims=True)
        hist_feat = np.divide(
            snapshot,
            totals,
            out=np.full_like(snapshot, 1.0 / N_CLASSES),
            where=totals > 0,
        )

        lag1 = np.full(n_buckets, -1, dtype=np.int64)
        prev_idx = index_of.get(day - datetime.timedelta(days=1))
        if prev_idx is not None:
            lag1 = y[prev_idx]
        lag7 = np.full(n_buckets, -1, dtype=np.int64)
        week_idx = index_of.get(day - datetime.timedelta(days=7))
        if week_idx is not None:
            lag7 = y[week_idx]

        dow = np.zeros((n_buckets, 7), dtype=np.float64)
        dow[:, day.weekday()] = 1.0
        weekend = np.full((n_buckets, 1), 1.0 if day.weekday() >= 5 else 0.0)

        blocks.append(
            np.hstack(
                [
                    cyc,
                    dow,
                    weekend,
                    _onehot_with_missing(lag1),
                    _onehot_with_missing(lag7),
                    hist_feat,
                ]
            )
        )
        labels.append(y[j] if j >= 0 else np.full(n_buckets, -1, dtype=np.int64))
        age = (anchor - day).days if anchor is not None else 0
        weights.append(
            np.full(n_buckets, 0.5 ** (max(age, 0) / max(half_life_days, 1e-6)))
        )

        if j >= 0:
            observed = y[j] >= 0
            hist[observed, y[j][observed]] += 1.0

    return np.vstack(blocks), np.concatenate(labels), np.concatenate(weights)


def logit_emissions(
    history: Sequence[dict],
    target_date: datetime.date,
    *,
    n_buckets: int = BUCKETS_PER_DAY,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
    c: float = 1.0,
    max_iter: int = 300,
    class_weight: str | None = None,
) -> np.ndarray | None:
    """
    Fit the head on *history* and return ``(n_buckets, N_CLASSES)`` for
    *target_date*, or None when history is too thin to fit.

    None rather than a fallback distribution: the caller already holds the
    baselines and is better placed to decide what to serve instead.
    """
    from sklearn.linear_model import LogisticRegression

    days, y = _day_matrix(history, n_buckets)
    if not days:
        return None

    x_all, y_all, w_all = _build(
        days, y, n_buckets, half_life_days, target_date=target_date
    )
    x_target = x_all[-n_buckets:]
    x_train, y_train = x_all[:-n_buckets], y_all[:-n_buckets]
    w_train = w_all[:-n_buckets]

    keep = y_train >= 0
    x_train, y_train, w_train = x_train[keep], y_train[keep], w_train[keep]
    if x_train.shape[0] < MIN_TRAIN_ROWS or len(np.unique(y_train)) < 2:
        return None

    # No multi_class argument: scikit-learn 1.7 deprecated it and 1.9 removed
    # it. lbfgs is multinomial by default, which is what this wants.
    model = LogisticRegression(
        C=c, max_iter=max_iter, solver="lbfgs", class_weight=class_weight
    )
    with warnings.catch_warnings():
        # An unconverged fit is still a usable probability vector.
        warnings.simplefilter("ignore")
        model.fit(x_train, y_train, sample_weight=w_train)
        partial = model.predict_proba(x_target)

    out = np.zeros((n_buckets, N_CLASSES), dtype=np.float64)
    out[:, model.classes_] = partial
    return out / np.clip(out.sum(axis=1, keepdims=True), 1e-12, None)


# Minimum calibrated probability the corrected class must still hold before the
# correction is allowed to override the plain argmax. Without a floor, full
# correction will relabel a bucket the model calls UNKNOWN at p=0.97 as
# EXERCISE at p=0.004, purely because EXERCISE is rare. That maximises macro
# recall, which counts a rare class hit regardless of confidence, and produces
# a label no one should act on. 0.15 keeps the corrections that reflect real
# signal and drops the ones that are only arithmetic on a tiny prior.
#
# Swept walk-forward on the 76-day densified corpus (macro-R / Brier):
#
#     0.00   0.789 / 0.1876      labels down to p=0.004
#     0.02   0.739 / 0.1492
#     0.05   0.693 / 0.1240
#     0.10   0.696 / 0.1129
#     0.15   0.697 / 0.1109
#
# Read that honestly: nearly all of the unfloored row's macro-recall advantage
# is built from labels the model gives less than 5% probability. Macro recall
# counts a rare-class hit regardless of confidence, so it rewards guessing; a
# served label cannot. 0.15 dominates 0.05 and 0.10 on both axes, so there is
# no trade being made inside the floored range — take the top of it.
DECISION_FLOOR = 0.15


def prior_correct(
    probs: np.ndarray,
    history: Sequence[dict],
    *,
    power: float = 1.0,
    floor: float = DECISION_FLOOR,
) -> np.ndarray:
    """
    Reweight a calibrated posterior for the *decision*, without refitting.

    ``argmax`` over a posterior on a background-dominated corpus answers the
    background almost everywhere even when the posterior is exactly right,
    because being right about a rare class still leaves it below the common
    one. Dividing by the class prior moves the operating point:

        p'(c) ∝ p(c) / prior(c) ** power

    The prior is counted from *history* only. Apply this when choosing what to
    display; store the uncorrected probabilities, which are the calibrated
    ones.
    """
    probs = np.asarray(probs, dtype=np.float64)
    counts = np.zeros(N_CLASSES, dtype=np.float64)
    for row in history:
        idx = CLASS_INDEX.get(str(row.get("token_id") or ""))
        if idx is not None:
            counts[idx] += 1.0
    total = counts.sum()
    if total <= 0:
        return probs

    # Laplace the prior itself: a class absent from history would otherwise
    # divide by zero and take every bucket.
    prior = (counts + 1.0) / (total + N_CLASSES)
    adjusted = probs / np.power(prior, power)[None, :]
    adjusted = adjusted / np.clip(adjusted.sum(axis=1, keepdims=True), 1e-12, None)

    if floor > 0.0:
        # Where the correction would promote a class the model barely believes
        # in, keep the uncorrected row so the argmax stays the honest one.
        promoted = np.argmax(adjusted, axis=1)
        believed = probs[np.arange(probs.shape[0]), promoted]
        adjusted = np.where((believed < floor)[:, None], probs, adjusted)
    return adjusted
