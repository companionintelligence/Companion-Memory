"""
The walk-forward loop.

For each eligible day D, ascending:

    history = every token_stream row strictly before D
    fit     = occupancy_counts(history)          # shared across baselines
    for each forecaster:  probs = f.forecast(history, D, fit)
    score probs against the L0 tokens actually observed on D

Rows accumulate across days and are scored once at the end through
``pipeline.scoring.score_predictions`` — the same Brier / top-1 / ECE /
per-class-recall path that scores the served model, so a number produced here
is directly comparable to a number in ``hbpe.prediction_score``.

Why the history is filtered here rather than inside each forecaster: a
forecaster is handed only the rows it is allowed to see, so leaking future data
requires fabricating it rather than merely forgetting a cutoff.  The assertion
in ``_assert_no_leak`` is a second line of defence over the corpus slice, not
the primary one.
"""

from __future__ import annotations

import datetime
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.evaluation.corpus import actuals_for_day, eval_dates, history_before
from ci.hbpe.evaluation.forecaster import (
    DEFAULT_FORECASTERS,
    N_CLASSES,
    DayFit,
    Forecaster,
)
from ci.hbpe.pipeline.baselines import _as_date
from ci.hbpe.pipeline.scoring import ScoreResult, score_predictions
from ci.hbpe.pipeline.serve import MODEL_HMT, pick_served_model
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

log = logging.getLogger(__name__)


@dataclass
class Coverage:
    """How much of the corpus the run actually scored."""

    eval_days: int = 0
    scored_buckets: int = 0
    buckets_per_day: int = BUCKETS_PER_DAY
    first_day: datetime.date | None = None
    last_day: datetime.date | None = None

    @property
    def buckets_per_eval_day(self) -> float:
        return self.scored_buckets / self.eval_days if self.eval_days else 0.0

    @property
    def occupancy_rate(self) -> float:
        """Fraction of a day's buckets carrying an observed L0 token."""
        denom = self.eval_days * self.buckets_per_day
        return self.scored_buckets / denom if denom else 0.0

    def as_dict(self) -> dict:
        return {
            "eval_days": self.eval_days,
            "scored_buckets": self.scored_buckets,
            "buckets_per_day": self.buckets_per_day,
            "buckets_per_eval_day": self.buckets_per_eval_day,
            "occupancy_rate": self.occupancy_rate,
            "first_day": self.first_day.isoformat() if self.first_day else None,
            "last_day": self.last_day.isoformat() if self.last_day else None,
        }


@dataclass
class WalkForwardResult:
    scores: dict[str, ScoreResult] = field(default_factory=dict)
    coverage: Coverage = field(default_factory=Coverage)

    def served_verdict(self, candidate: str) -> str | None:
        """
        Would the live D3 gate serve *candidate*? ``"serve"``, ``"bench"``, or
        ``None`` when the comparison cannot be made.

        ``serve.pick_served_model`` answers in its own vocabulary — it returns
        the literal string ``"hmt"`` for "serve the candidate" and ``"b2"`` for
        "fall back" — because it was written for one candidate. Comparing its
        answer to the candidate's *name* would therefore report a candidate
        that happens to be called ``b2`` as having cleared a gate it actually
        failed. Translate the verdict instead of echoing it.

        Missing metrics are reported as ``None`` rather than passed through:
        the gate defaults to serving when top-1 is absent, which is a sensible
        production behaviour and a meaningless benchmark result.
        """
        cand = self.scores.get(candidate)
        b1 = self.scores.get("b1")
        if cand is None or b1 is None:
            return None
        if cand.l0_top1_acc is None or b1.l0_top1_acc is None:
            return None
        b2 = self.scores.get("b2")
        decision = pick_served_model(
            cand.as_dict(),
            b1.as_dict(),
            b2.as_dict() if b2 else None,
            has_checkpoint=True,
        )
        return "serve" if decision == MODEL_HMT else "bench"

    def as_dict(self) -> dict:
        return {
            "coverage": self.coverage.as_dict(),
            "models": {n: s.as_dict() for n, s in self.scores.items()},
        }


def _assert_no_leak(history: Sequence[dict], day: datetime.date) -> None:
    for row in history:
        if _as_date(row["date"]) >= day:
            raise AssertionError(
                f"history for {day} contains a row dated {row['date']}"
            )


def _validate(probs: np.ndarray, name: str, day: datetime.date, n_buckets: int) -> None:
    if probs.shape != (n_buckets, N_CLASSES):
        raise ValueError(
            f"{name} returned {probs.shape} for {day}, expected "
            f"{(n_buckets, N_CLASSES)}"
        )
    if not np.isfinite(probs).all():
        raise ValueError(f"{name} returned non-finite probabilities for {day}")
    sums = probs.sum(axis=1)
    if not np.allclose(sums, 1.0, atol=1e-3):
        worst = int(np.argmax(np.abs(sums - 1.0)))
        raise ValueError(
            f"{name} row {worst} for {day} sums to {sums[worst]:.6f}, not 1.0"
        )


def walk_forward(
    rows: Sequence[dict],
    forecasters: Sequence[Forecaster] = DEFAULT_FORECASTERS,
    *,
    min_history_days: int = 14,
    start: datetime.date | None = None,
    end: datetime.date | None = None,
    n_buckets: int = BUCKETS_PER_DAY,
) -> WalkForwardResult:
    """
    Score *forecasters* walk-forward over the token-stream *rows*.

    ``rows`` are ``{date, bucket_idx, token_id}`` dicts at ``level = 'L0'`` —
    the shape ``baselines.fetch_occupancy_rows`` returns.
    """
    days = eval_dates(
        rows,
        min_history_days=min_history_days,
        start=start,
        end=end,
        n_buckets=n_buckets,
    )
    if not days:
        log.warning(
            "no eligible eval days (corpus=%d rows, min_history_days=%d)",
            len(rows),
            min_history_days,
        )
        return WalkForwardResult()

    emitted: dict[str, list[dict]] = {f.name: [] for f in forecasters}
    coverage = Coverage(buckets_per_day=n_buckets, first_day=days[0], last_day=days[-1])

    for day in days:
        history = history_before(rows, day)
        _assert_no_leak(history, day)
        actuals = actuals_for_day(rows, day, n_buckets)
        if not actuals:
            continue

        fit = DayFit.build(history, n_buckets=n_buckets)
        coverage.eval_days += 1
        coverage.scored_buckets += len(actuals)

        for forecaster in forecasters:
            probs = np.asarray(forecaster.forecast(history, day, fit), dtype=np.float64)
            _validate(probs, forecaster.name, day, n_buckets)
            for bucket, actual in actuals.items():
                emitted[forecaster.name].append(
                    {
                        "l0_probs": {
                            cls: float(probs[bucket, i])
                            for i, cls in enumerate(L0_CLASSES)
                        },
                        "actual_l0": actual,
                    }
                )

    scores = {
        name: score_predictions(model_rows)
        for name, model_rows in emitted.items()
        if model_rows
    }
    return WalkForwardResult(scores=scores, coverage=coverage)
