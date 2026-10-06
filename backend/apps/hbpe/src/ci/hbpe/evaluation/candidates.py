"""
``Forecaster`` adapters for the models that live in ``pipeline``.

The maths moved to ``pipeline/shrinkage.py`` and ``pipeline/supervised.py`` so
the serving path can use it without importing an evaluation package. What is
left here is the thin protocol wrapper the walk-forward loop needs: take
history, return ``(n_buckets, 8)``.
"""

from __future__ import annotations

import datetime
from collections.abc import Sequence

import numpy as np

from ci.hbpe.evaluation.forecaster import DayFit
from ci.hbpe.pipeline.hmm import forward_backward
from ci.hbpe.pipeline.shrinkage import (
    DEFAULT_HALF_LIFE_DAYS,
    DEFAULT_K,
    DEFAULT_TRANSITION_K,
    balanced_transitions,
    shrunk_emissions,
    weighted_counts,
)
from ci.hbpe.pipeline.supervised import logit_emissions, prior_correct


class ShrinkageForecaster:
    """Recency-weighted hierarchical shrinkage. Emissions only, no smoothing."""

    name = "shrink"

    def __init__(
        self,
        *,
        half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
        k: float = DEFAULT_K,
        name: str | None = None,
    ) -> None:
        self.half_life_days = half_life_days
        self.k = k
        if name:
            self.name = name

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        b0, b1, _ = weighted_counts(
            history,
            target_date,
            n_buckets=n_buckets,
            half_life_days=self.half_life_days,
        )
        return shrunk_emissions(b0, b1, target_date.weekday(), k=self.k)


class ShrinkageHmmForecaster:
    """
    Shrinkage emissions smoothed by forward-backward over balanced transitions.

    Carried alongside ``shrink`` rather than replacing it so the table shows
    what the smoother contributes on its own. It has never contributed
    positively on either corpus this was run against; see the bead on dwell
    modelling before reaching for it.
    """

    name = "shrink+hmm"

    def __init__(
        self,
        *,
        half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
        k: float = DEFAULT_K,
        transition_k: float = DEFAULT_TRANSITION_K,
        name: str | None = None,
    ) -> None:
        self.half_life_days = half_life_days
        self.k = k
        self.transition_k = transition_k
        if name:
            self.name = name

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        n_buckets = fit.b0.shape[0]
        b0, b1, trans = weighted_counts(
            history,
            target_date,
            n_buckets=n_buckets,
            half_life_days=self.half_life_days,
        )
        emissions = shrunk_emissions(b0, b1, target_date.weekday(), k=self.k)
        smoothed = np.asarray(
            forward_backward(
                emissions,
                balanced_transitions(trans, k=self.transition_k),
                n_buckets=n_buckets,
            ),
            dtype=np.float64,
        )
        return smoothed / np.clip(smoothed.sum(axis=1, keepdims=True), 1e-12, None)


class LogisticForecaster:
    """
    The supervised head, refit on each eval day's history.

    Falls back to *prior* when history is too thin to fit, so an early eval day
    degrades to a known row instead of to noise.
    """

    name = "logit"

    def __init__(
        self,
        prior,
        *,
        half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
        c: float = 1.0,
        max_iter: int = 300,
        class_weight: str | None = None,
        name: str | None = None,
    ) -> None:
        self.prior = prior
        self.half_life_days = half_life_days
        self.c = c
        self.max_iter = max_iter
        self.class_weight = class_weight
        if name:
            self.name = name

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        out = logit_emissions(
            history,
            target_date,
            n_buckets=fit.b0.shape[0],
            half_life_days=self.half_life_days,
            c=self.c,
            max_iter=self.max_iter,
            class_weight=self.class_weight,
        )
        if out is None:
            return self.prior.forecast(history, target_date, fit)
        return out


class PriorCorrectedForecaster:
    """
    A calibrated forecaster's probabilities, reweighted for the *decision*.

    Deployed this is one model: store what the inner forecaster emits, apply
    the correction when choosing what to show. It is a separate row here only
    because ``score_predictions`` derives top-1, Brier and ECE from the same
    vector, so **read only this row's macro-R and per-class recall**. Its Brier
    and ECE describe reweighted numbers that nothing would ever store.
    """

    name = "logit@rule"

    def __init__(self, inner, *, power: float = 1.0, name: str | None = None) -> None:
        self.inner = inner
        self.power = power
        if name:
            self.name = name

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        probs = self.inner.forecast(history, target_date, fit)
        return prior_correct(probs, history, power=self.power)
