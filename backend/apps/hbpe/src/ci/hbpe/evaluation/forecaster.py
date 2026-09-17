"""
The forecaster interface, plus adapters for everything already in the tree.

A forecaster answers one question: given only the days before *target_date*,
what is the probability of each L0 class in each bucket of that day?  It
returns an ``(n_buckets, 8)`` array over ``L0_CLASSES`` order.

That signature is deliberately narrower than ``InferenceEngine.predict``.  It
takes no model checkpoint, no database handle and no serve gate, so a candidate
forecaster can be written and measured as a pure function of history before any
of the serving machinery exists.

``DayFit`` is the shared ``occupancy_counts`` fit for one target day.  B0, B1
and B2 are all read off the same counts, so the walk-forward loop computes it
once per day rather than three times.  It carries no information that is not
already in ``history`` — it is a cache, not an extra input — so a forecaster
that ignores it is not thereby disadvantaged.
"""

from __future__ import annotations

import datetime
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.pipeline.baselines import (
    _as_date,
    b0_probs,
    b1_probs,
    b2_day_emissions,
    occupancy_counts,
)
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

N_CLASSES = len(L0_CLASSES)
CLASS_INDEX = {c: i for i, c in enumerate(L0_CLASSES)}

# Smoothing for the persistence one-hot. Deliberately *not* ``hmm.LAPLACE``
# (1.0): add-one over 8 classes drags a one-hot down to p=0.22 for the class it
# is actually asserting, which scores Brier 0.69 — worse than B1 — for a
# forecaster whose argmax may be perfect. That would misreport persistence as
# weak when it is merely being described as uncertain. Persistence *is* a
# confident forecaster; it should be scored as one, and punished accordingly
# when it is wrong. This constant only keeps the distribution off zero.
PERSISTENCE_SMOOTHING = 0.02


@dataclass(frozen=True)
class DayFit:
    """``occupancy_counts`` fit on one day's history. Derived, never extra."""

    b0: np.ndarray  # (n_buckets, C)
    b1: np.ndarray  # (n_buckets, 7, C)
    transitions: np.ndarray  # (n_dayparts, C, C)

    @classmethod
    def build(cls, history: Sequence[dict], n_buckets: int = BUCKETS_PER_DAY) -> DayFit:
        # ``until=None``: history is already filtered by the walk-forward loop.
        b0, b1, trans = occupancy_counts(history, until=None, n_buckets=n_buckets)
        return cls(b0=b0, b1=b1, transitions=trans)


@runtime_checkable
class Forecaster(Protocol):
    """Produces a next-day L0 distribution from prior history alone."""

    name: str

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:  # (n_buckets, N_CLASSES)
        ...


def _to_arr(probs: dict[str, float]) -> np.ndarray:
    return np.array([probs.get(c, 0.0) for c in L0_CLASSES], dtype=np.float64)


# ── Reference forecasters ─────────────────────────────────────────────────────


class UniformForecaster:
    """
    Floor. Every class equally likely in every bucket.

    Worth carrying because it pins the top of the Brier scale: a uniform
    8-class prediction scores exactly 0.875, so any number near that is a
    forecaster that has learned nothing, regardless of how it was built.
    """

    name = "uniform"

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        return np.full((n_buckets, N_CLASSES), 1.0 / N_CLASSES, dtype=np.float64)


class B0Forecaster:
    """Per-bucket Laplace occupancy, day-of-week blind."""

    name = "b0"

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        return np.stack([_to_arr(b0_probs(fit.b0, b)) for b in range(n_buckets)])


class B1Forecaster:
    """
    Per-(bucket, day-of-week) occupancy — the bar the D3 serve gate sets.

    ``pipeline/serve.py`` benches the transformer unless it beats this on top-1
    by a margin, so this row is the one a candidate forecaster has to clear.
    """

    name = "b1"

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        dow = target_date.weekday()
        return np.stack([_to_arr(b1_probs(fit.b1, b, dow)) for b in range(n_buckets)])


class B2Forecaster:
    """Daypart Markov: one step from B1[t-1] through the daypart transitions."""

    name = "b2"

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        return b2_day_emissions(
            fit.b1, fit.transitions, target_date.weekday(), n_buckets
        )


class PersistenceForecaster:
    """
    Repeat the most recent earlier day sharing the target's weekday.

    Not currently in the tree, and included because it is the baseline a
    routine-driven corpus is most likely to lose to: "last Tuesday, again" uses
    no aggregation at all.  A forecaster that cannot beat it is not modelling
    routine, it is smoothing.

    Observed buckets become a lightly smoothed one-hot; buckets that day did
    not observe fall back to uniform rather than to B1, so the row measures
    persistence alone and not a persistence/occupancy hybrid.
    """

    name = "persistence"

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        out = np.full((n_buckets, N_CLASSES), 1.0 / N_CLASSES, dtype=np.float64)

        dow = target_date.weekday()
        candidates = [
            d for d in {_as_date(r["date"]) for r in history} if d.weekday() == dow
        ]
        if not candidates:
            return out
        source = max(candidates)

        eps = PERSISTENCE_SMOOTHING
        denom = 1.0 + N_CLASSES * eps
        for row in history:
            if _as_date(row["date"]) != source:
                continue
            idx = CLASS_INDEX.get(str(row.get("token_id") or ""))
            if idx is None:
                continue
            bucket = int(row["bucket_idx"])
            if bucket < 0 or bucket >= n_buckets:
                continue
            vec = np.full(N_CLASSES, eps / denom, dtype=np.float64)
            vec[idx] = (1.0 + eps) / denom
            out[bucket] = vec
        return out


DEFAULT_FORECASTERS: tuple[Forecaster, ...] = (
    UniformForecaster(),
    PersistenceForecaster(),
    B0Forecaster(),
    B1Forecaster(),
    B2Forecaster(),
)
