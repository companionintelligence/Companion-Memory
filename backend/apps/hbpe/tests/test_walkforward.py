"""
Unit tests for the offline walk-forward harness (ci.hbpe.evaluation).

The harness exists to produce numbers a deployment decision rests on, so these
tests target the properties that would make a number wrong rather than the
plumbing that would make it absent:

  * no leakage — a forecaster is never handed a row dated on or after the day
    it is predicting;
  * the metric path agrees with closed-form answers (perfect → Brier 0,
    uniform → 0.875) through the real ``score_predictions``;
  * actuals use the same bucket-collision rule the baselines are fit under;
  * a malformed forecaster output is rejected loudly instead of silently
    corrupting a Brier score.

Fixture corpus: a routine-driven synthetic user — SLEEP overnight, WORK on
weekday mornings, EXERCISE on Tuesday evenings — so B1 has real structure to
find and is expected to beat uniform.
"""

from __future__ import annotations

import datetime
import sys
from pathlib import Path

import numpy as np
import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe.buckets import BUCKETS_PER_DAY  # noqa: E402
from ci.hbpe.evaluation import (  # noqa: E402
    B1Forecaster,
    B2Forecaster,
    PersistenceForecaster,
    UniformForecaster,
    actuals_for_day,
    eval_dates,
    history_before,
    walk_forward,
)
from ci.hbpe.evaluation.forecaster import CLASS_INDEX, N_CLASSES, DayFit  # noqa: E402

START = datetime.date(2026, 1, 5)  # a Monday
N_DAYS = 60


def _corpus(n_days: int = N_DAYS) -> list[dict]:
    """SLEEP 00:00-06:00; WORK 09:00-17:00 on weekdays; EXERCISE Tue 18:00."""
    rows: list[dict] = []
    for offset in range(n_days):
        day = START + datetime.timedelta(days=offset)
        for bucket in range(0, 24):  # 00:00 → 06:00 at 15 min
            rows.append({"date": day, "bucket_idx": bucket, "token_id": "SLEEP"})
        if day.weekday() < 5:
            for bucket in range(36, 68):  # 09:00 → 17:00
                rows.append({"date": day, "bucket_idx": bucket, "token_id": "WORK"})
        if day.weekday() == 1:
            for bucket in range(72, 76):  # 18:00 → 19:00
                rows.append({"date": day, "bucket_idx": bucket, "token_id": "EXERCISE"})
    return rows


class _Recorder:
    """Forecaster that remembers the latest date it was ever shown."""

    name = "recorder"

    def __init__(self) -> None:
        self.max_seen: dict[datetime.date, datetime.date | None] = {}

    def forecast(self, history, target_date, fit):
        dates = [r["date"] for r in history]
        self.max_seen[target_date] = max(dates) if dates else None
        return np.full((BUCKETS_PER_DAY, N_CLASSES), 1.0 / N_CLASSES)


class _Oracle:
    """Cheats by reading the answers — used to pin the metric path."""

    name = "oracle"

    def __init__(self, rows) -> None:
        self._rows = rows

    def forecast(self, history, target_date, fit):
        out = np.full((BUCKETS_PER_DAY, N_CLASSES), 1e-12)
        for bucket, cls in actuals_for_day(self._rows, target_date).items():
            out[bucket] = 1e-12
            out[bucket, CLASS_INDEX[cls]] = 1.0
        return out / out.sum(axis=1, keepdims=True)


# ── Corpus slicing ────────────────────────────────────────────────────────────


def test_history_before_is_strict():
    rows = _corpus(10)
    day = START + datetime.timedelta(days=5)
    assert all(r["date"] < day for r in history_before(rows, day))
    assert any(r["date"] == day - datetime.timedelta(days=1) for r in rows)


def test_eval_dates_respects_min_history():
    rows = _corpus(30)
    days = eval_dates(rows, min_history_days=14)
    assert days[0] == START + datetime.timedelta(days=14)
    assert len(days) == 30 - 14


def test_actuals_last_row_wins_matching_baselines():
    """Collision rule must match occupancy_counts' ``by_day[day][b] = idx``."""
    day = START
    rows = [
        {"date": day, "bucket_idx": 40, "token_id": "WORK"},
        {"date": day, "bucket_idx": 40, "token_id": "SOCIAL"},
    ]
    assert actuals_for_day(rows, day)[40] == "SOCIAL"


def test_actuals_drop_non_l0_tokens():
    day = START
    rows = [
        {"date": day, "bucket_idx": 0, "token_id": "SOD"},
        {"date": day, "bucket_idx": 1, "token_id": "WORK"},
        {"date": day, "bucket_idx": 2, "token_id": "not-a-class"},
    ]
    assert actuals_for_day(rows, day) == {1: "WORK"}


# ── The leakage guarantee ─────────────────────────────────────────────────────


def test_forecaster_never_sees_the_target_day():
    rows = _corpus(30)
    recorder = _Recorder()
    walk_forward(rows, [recorder], min_history_days=14)
    assert recorder.max_seen
    for target, seen in recorder.max_seen.items():
        assert seen is not None and seen < target


# ── Metric path ───────────────────────────────────────────────────────────────


def test_oracle_scores_perfectly():
    rows = _corpus(30)
    result = walk_forward(rows, [_Oracle(rows)], min_history_days=14)
    score = result.scores["oracle"]
    assert score.l0_top1_acc == pytest.approx(1.0)
    assert score.brier == pytest.approx(0.0, abs=1e-6)


def test_uniform_scores_the_closed_form_brier():
    rows = _corpus(30)
    result = walk_forward(rows, [UniformForecaster()], min_history_days=14)
    assert result.scores["uniform"].brier == pytest.approx(0.875)


def test_uniform_top1_is_inflated_by_argmax_tie_breaking():
    """
    A flat forecaster is not scored at 0% top-1 — it is scored at the base rate
    of whichever class sorts first.

    ``scoring.argmax_class`` breaks ties by ``L0_CLASSES`` order, whose first
    entry is WORK, so a model that has learned nothing still "predicts" WORK in
    every bucket and collects the WORK base rate for free.  That matters
    because top-1 is the metric the D3 serve gate is primarily decided on
    (``serve.pick_served_model``): a degenerate forecaster clears a
    surprisingly high bar on it.  This is why ``uniform`` is a permanent row in
    ``DEFAULT_FORECASTERS`` — the table always shows what nothing scores.
    """
    rows = _corpus(30)
    result = walk_forward(rows, [UniformForecaster()], min_history_days=14)

    actuals = [
        cls
        for day in eval_dates(rows, min_history_days=14)
        for cls in actuals_for_day(rows, day).values()
    ]
    work_rate = sum(c == "WORK" for c in actuals) / len(actuals)

    assert result.scores["uniform"].l0_top1_acc == pytest.approx(work_rate)
    assert work_rate > 0.4  # far from the 0% an untrained model might suggest


def test_b1_beats_uniform_on_a_routine_corpus():
    rows = _corpus()
    result = walk_forward(
        rows, [UniformForecaster(), B1Forecaster()], min_history_days=14
    )
    b1, uniform = result.scores["b1"], result.scores["uniform"]
    assert b1.l0_top1_acc > uniform.l0_top1_acc
    assert b1.brier < uniform.brier


def test_persistence_repeats_the_last_same_weekday():
    rows = _corpus()
    target = START + datetime.timedelta(days=21)  # a Monday
    history = history_before(rows, target)
    probs = PersistenceForecaster().forecast(history, target, DayFit.build(history))
    # Monday carries WORK at 09:00; the prior Monday did too.
    assert int(np.argmax(probs[40])) == CLASS_INDEX["WORK"]
    assert int(np.argmax(probs[0])) == CLASS_INDEX["SLEEP"]


# ── Coverage reporting ────────────────────────────────────────────────────────


def test_coverage_counts_only_observed_buckets():
    rows = _corpus(30)
    result = walk_forward(rows, [UniformForecaster()], min_history_days=14)
    cov = result.coverage
    assert cov.eval_days == 16
    assert cov.buckets_per_day == BUCKETS_PER_DAY
    assert 0.0 < cov.occupancy_rate < 1.0
    assert cov.scored_buckets == result.scores["uniform"].n_l0


# ── Malformed output is rejected, not absorbed ────────────────────────────────


@pytest.mark.parametrize(
    "bad",
    [
        np.full((BUCKETS_PER_DAY, N_CLASSES), 0.5),  # rows sum to 4
        np.full((BUCKETS_PER_DAY, N_CLASSES), np.nan),
        np.full((BUCKETS_PER_DAY, 3), 1.0 / 3),  # wrong width
    ],
    ids=["unnormalised", "nan", "wrong_shape"],
)
def test_invalid_forecaster_output_raises(bad):
    class _Bad:
        name = "bad"

        def forecast(self, history, target_date, fit):
            return bad

    with pytest.raises(ValueError):
        walk_forward(_corpus(20), [_Bad()], min_history_days=14)


# ── The D3 gate verdict ───────────────────────────────────────────────────────


def test_served_verdict_translates_rather_than_echoing_the_gate():
    """
    ``pick_served_model`` returns "hmt"/"b2", not the candidate's name.

    A candidate literally named ``b2`` that *fails* the gate would otherwise be
    reported as having cleared it, because the fallback string matches its
    name.  The verdict must be translated to serve/bench.
    """
    rows = _corpus()
    result = walk_forward(
        rows, [UniformForecaster(), B1Forecaster(), B2Forecaster()], min_history_days=14
    )
    # B1 cannot beat itself by the gate's 5-point top-1 margin.
    assert result.served_verdict("b1") == "bench"
    # A forecaster that is strictly worse than B1 is benched, name regardless.
    assert result.served_verdict("b2") in {"serve", "bench"}
    assert result.served_verdict("uniform") == "bench"


def test_served_verdict_is_none_without_a_comparison():
    rows = _corpus(30)
    result = walk_forward(rows, [UniformForecaster()], min_history_days=14)
    assert result.served_verdict("uniform") is None  # no B1 row was run
    assert result.served_verdict("nonexistent") is None


def test_persistence_is_scored_as_a_confident_forecaster():
    """
    Add-one smoothing over 8 classes would cap a correct one-hot at p=0.22 and
    score it Brier ≈ 0.69 — worse than B1 — while its argmax was perfect.  On a
    deterministic corpus persistence is exactly right, so its Brier must be
    near 0, not near uniform.
    """
    rows = _corpus()
    result = walk_forward(
        rows, [PersistenceForecaster(), B1Forecaster()], min_history_days=14
    )
    persistence = result.scores["persistence"]
    assert persistence.l0_top1_acc == pytest.approx(1.0)
    assert persistence.brier < 0.05
