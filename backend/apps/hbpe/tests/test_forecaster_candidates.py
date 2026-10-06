"""Densification, shrinkage, balanced transitions, and the macro-recall metric."""

from __future__ import annotations

import datetime

import numpy as np
import pytest

from ci.hbpe.evaluation.candidates import (
    PriorCorrectedForecaster,
    ShrinkageForecaster,
)
from ci.hbpe.evaluation.corpus import densify
from ci.hbpe.evaluation.forecaster import CLASS_INDEX, N_CLASSES, DayFit
from ci.hbpe.evaluation.report import macro_recall
from ci.hbpe.pipeline.rhythm import background_by_bucket, sleep_buckets
from ci.hbpe.pipeline.shrinkage import (
    balanced_transitions,
    shrunk_emissions,
    weighted_counts,
)

DAY = datetime.date(2026, 3, 2)  # a Monday
N_BUCKETS = 8


def _row(day: datetime.date, bucket: int, token: str) -> dict:
    return {"date": day, "bucket_idx": bucket, "token_id": token}


# ── densify ───────────────────────────────────────────────────────────────────


def test_densify_fills_every_bucket_of_an_observed_day():
    rows = densify([_row(DAY, 3, "WORK")], "UNKNOWN", N_BUCKETS)
    assert len(rows) == N_BUCKETS
    by_bucket = {r["bucket_idx"]: r["token_id"] for r in rows}
    assert by_bucket[3] == "WORK"
    assert all(by_bucket[b] == "UNKNOWN" for b in range(N_BUCKETS) if b != 3)


def test_densify_leaves_unobserved_days_absent():
    """A gap in ingestion is not evidence that nothing happened."""
    rows = densify(
        [_row(DAY, 0, "WORK"), _row(DAY + datetime.timedelta(days=3), 0, "WORK")],
        "UNKNOWN",
        N_BUCKETS,
    )
    assert {r["date"] for r in rows} == {DAY, DAY + datetime.timedelta(days=3)}


def test_densify_rejects_a_background_outside_the_taxonomy():
    with pytest.raises(ValueError, match="not an L0 class"):
        densify([_row(DAY, 0, "WORK")], "IDLE", N_BUCKETS)


def test_densify_is_idempotent():
    once = densify([_row(DAY, 3, "WORK")], "UNKNOWN", N_BUCKETS)
    assert densify(once, "UNKNOWN", N_BUCKETS) == once


# ── recency weighting ─────────────────────────────────────────────────────────


def test_recent_days_outweigh_old_ones():
    target = DAY + datetime.timedelta(days=30)
    history = [
        _row(DAY, 0, "WORK"),
        _row(DAY + datetime.timedelta(days=28), 0, "SOCIAL"),
    ]
    b0, _, _ = weighted_counts(history, target, n_buckets=N_BUCKETS, half_life_days=7.0)
    assert b0[0, CLASS_INDEX["SOCIAL"]] > b0[0, CLASS_INDEX["WORK"]]


def test_half_life_is_what_it_says():
    target = DAY + datetime.timedelta(days=7)
    b0, _, _ = weighted_counts(
        [_row(DAY, 0, "WORK")], target, n_buckets=N_BUCKETS, half_life_days=7.0
    )
    assert b0[0, CLASS_INDEX["WORK"]] == pytest.approx(0.5, abs=1e-9)


# ── shrinkage ─────────────────────────────────────────────────────────────────


def test_thin_cell_inherits_from_its_parent_not_from_uniform():
    """
    The whole point of shrinking to the parent. One WORK observation in a
    bucket whose other weekdays are all SOCIAL should still favour SOCIAL over
    the six classes nothing was ever seen in.
    """
    b0 = np.zeros((N_BUCKETS, N_CLASSES))
    b1 = np.zeros((N_BUCKETS, 7, N_CLASSES))
    social, work = CLASS_INDEX["SOCIAL"], CLASS_INDEX["WORK"]
    b0[0, social] = 40.0
    b1[0, 1, social] = 40.0  # Tuesdays
    b0[0, work] = 1.0
    b1[0, 0, work] = 1.0  # the single Monday

    probs = shrunk_emissions(b0, b1, dow=0, k=4.0)[0]
    assert probs[social] > probs[CLASS_INDEX["LEISURE"]]
    assert probs.sum() == pytest.approx(1.0)


def test_a_well_observed_cell_is_barely_moved():
    b0 = np.zeros((N_BUCKETS, N_CLASSES))
    b1 = np.zeros((N_BUCKETS, 7, N_CLASSES))
    work = CLASS_INDEX["WORK"]
    b0[0, work] = 200.0
    b1[0, 0, work] = 200.0
    assert shrunk_emissions(b0, b1, dow=0, k=4.0)[0, work] > 0.95


def test_shrunk_emissions_are_distributions():
    rng = np.random.default_rng(0)
    b0 = rng.integers(0, 5, size=(N_BUCKETS, N_CLASSES)).astype(float)
    b1 = rng.integers(0, 3, size=(N_BUCKETS, 7, N_CLASSES)).astype(float)
    out = shrunk_emissions(b0, b1, dow=3, k=4.0)
    assert np.allclose(out.sum(axis=1), 1.0)
    assert (out > 0).all()


# ── transitions ───────────────────────────────────────────────────────────────


def test_balanced_transitions_do_not_force_the_diagonal():
    """
    A daypart where WORK always hands over to SOCIAL. Flat Laplace would put
    the largest off-diagonal mass on the diagonal for the unseen rows; shrinking
    toward the destination marginal keeps them pointed at SOCIAL.
    """
    counts = np.zeros((4, N_CLASSES, N_CLASSES))
    work, social = CLASS_INDEX["WORK"], CLASS_INDEX["SOCIAL"]
    counts[0, work, social] = 50.0

    tr = balanced_transitions(counts, k=8.0)
    assert np.allclose(tr.sum(axis=2), 1.0)
    unseen = tr[0, CLASS_INDEX["ERRAND"]]
    assert unseen[social] > unseen[CLASS_INDEX["ERRAND"]]


def test_balanced_transitions_reject_the_wrong_shape():
    with pytest.raises(ValueError, match=r"expected \(P, C, C\)"):
        balanced_transitions(np.zeros((N_CLASSES, N_CLASSES)))


# ── forecaster contract ───────────────────────────────────────────────────────


def test_shrinkage_forecaster_returns_a_valid_simplex():
    history = [
        _row(DAY - datetime.timedelta(days=d), b, "WORK")
        for d in range(1, 15)
        for b in range(3)
    ]
    fit = DayFit.build(history, n_buckets=N_BUCKETS)
    out = ShrinkageForecaster().forecast(history, DAY, fit)
    assert out.shape == (N_BUCKETS, N_CLASSES)
    assert np.isfinite(out).all()
    assert np.allclose(out.sum(axis=1), 1.0)


# ── macro recall ──────────────────────────────────────────────────────────────


class _Score:
    def __init__(self, per_class):
        self.per_class = per_class


def test_macro_recall_ignores_zero_support_classes():
    score = _Score(
        {
            "WORK": {"support": 10, "recall": 0.5},
            "SOCIAL": {"support": 10, "recall": 1.0},
            "SLEEP": {"support": 0, "recall": None},
        }
    )
    assert macro_recall(score) == pytest.approx(0.75)


def test_macro_recall_excludes_the_densification_filler():
    score = _Score(
        {
            "WORK": {"support": 10, "recall": 0.5},
            "UNKNOWN": {"support": 9000, "recall": 1.0},
        }
    )
    assert macro_recall(score, exclude="UNKNOWN") == pytest.approx(0.5)


def test_macro_recall_punishes_majority_class_collapse():
    """The number top-1 and Brier both fail to report on a skewed corpus."""
    collapsed = _Score(
        {
            "UNKNOWN": {"support": 9000, "recall": 1.0},
            "WORK": {"support": 50, "recall": 0.0},
            "SOCIAL": {"support": 20, "recall": 0.0},
        }
    )
    assert macro_recall(collapsed, exclude="UNKNOWN") == pytest.approx(0.0)


# ── declared rhythm ───────────────────────────────────────────────────────────


def test_sleep_window_that_does_not_wrap_midnight():
    """This user's real onboarding answer: 02:00 → 09:00, inside one day."""
    got = sleep_buckets({"sleep_time": "02:00", "wake_time": "09:00"}, 96)
    assert got == set(range(8, 36))
    assert len(got) == 28


def test_sleep_window_uses_the_requested_bucket_count():
    """A 24-bucket day is hourly. 02:00–09:00 must stay inside 0..23."""
    got = sleep_buckets({"sleep_time": "02:00", "wake_time": "09:00"}, 24)
    assert got == set(range(2, 9))


def test_sleep_window_wraps_midnight():
    got = sleep_buckets({"sleep_time": "22:00", "wake_time": "07:00"}, 96)
    assert got == set(range(88, 96)) | set(range(0, 28))
    assert len(got) == 36


def test_sleep_window_absent_or_unusable():
    assert sleep_buckets(None, 96) == set()
    assert sleep_buckets({}, 96) == set()
    assert sleep_buckets({"sleep_time": "nope", "wake_time": "07:00"}, 96) == set()
    # Degenerate: bed and wake at the same minute is not a 24-hour sleep.
    assert sleep_buckets({"sleep_time": "07:00", "wake_time": "07:00"}, 96) == set()


def test_background_marks_sleep_and_leaves_the_rest_flat():
    row = background_by_bucket(
        {"sleep_time": "02:00", "wake_time": "09:00"}, "UNKNOWN", 96
    )
    assert row[8] == "SLEEP"
    assert row[35] == "SLEEP"
    assert row[36] == "UNKNOWN"
    assert row[0] == "UNKNOWN"


def test_densify_applies_a_per_bucket_background():
    # N_BUCKETS is 8, so each bucket is three hours. 00:00–06:00 covers 0 and 1.
    background = background_by_bucket(
        {"sleep_time": "00:00", "wake_time": "06:00"}, "UNKNOWN", N_BUCKETS
    )
    rows = densify([_row(DAY, 5, "WORK")], background, N_BUCKETS)
    by_bucket = {r["bucket_idx"]: r["token_id"] for r in rows}
    assert by_bucket[5] == "WORK"  # an observed token always beats the filler
    assert by_bucket[0] == "SLEEP"


def test_densify_rejects_a_background_of_the_wrong_length():
    with pytest.raises(ValueError, match="expected"):
        densify([_row(DAY, 0, "WORK")], ["UNKNOWN"] * 3, N_BUCKETS)


def test_densify_rejects_a_callable_background_outside_the_taxonomy():
    def bad(_day: datetime.date) -> list[str]:
        return ["IDLE"] * N_BUCKETS

    with pytest.raises(ValueError, match="L0"):
        densify([_row(DAY, 0, "WORK")], bad, N_BUCKETS)


def test_densify_rejects_a_callable_background_of_the_wrong_length():
    def short(_day: datetime.date) -> list[str]:
        return ["UNKNOWN"]

    with pytest.raises(ValueError, match="expected"):
        densify([_row(DAY, 0, "WORK")], short, N_BUCKETS)


# ── decision rule ─────────────────────────────────────────────────────────────


class _Fixed:
    name = "fixed"

    def __init__(self, probs):
        self.probs = probs

    def forecast(self, history, target_date, fit):
        return self.probs


def test_prior_correction_lifts_a_rare_class_over_a_common_one():
    """
    The posterior prefers UNKNOWN 0.6 to LEISURE 0.4, but history is 95%
    UNKNOWN, so 0.4 on LEISURE is the more surprising claim.
    """
    unknown, leisure = CLASS_INDEX["UNKNOWN"], CLASS_INDEX["LEISURE"]
    probs = np.zeros((N_BUCKETS, N_CLASSES))
    probs[:, unknown] = 0.6
    probs[:, leisure] = 0.4

    history = [_row(DAY, b % N_BUCKETS, "UNKNOWN") for b in range(95)]
    history += [_row(DAY, b % N_BUCKETS, "LEISURE") for b in range(5)]
    fit = DayFit.build(history, n_buckets=N_BUCKETS)

    out = PriorCorrectedForecaster(_Fixed(probs), power=1.0).forecast(history, DAY, fit)
    assert out[0, leisure] > out[0, unknown]
    assert np.allclose(out.sum(axis=1), 1.0)


def test_prior_correction_with_zero_power_changes_nothing():
    probs = np.full((N_BUCKETS, N_CLASSES), 1.0 / N_CLASSES)
    probs[:, CLASS_INDEX["WORK"]] = 0.5
    probs /= probs.sum(axis=1, keepdims=True)
    history = [_row(DAY, 0, "WORK")] * 10
    fit = DayFit.build(history, n_buckets=N_BUCKETS)
    out = PriorCorrectedForecaster(_Fixed(probs), power=0.0).forecast(history, DAY, fit)
    assert np.allclose(out, probs)


def test_prior_correction_survives_a_class_absent_from_history():
    """A zero-count class must not divide by zero and take every bucket."""
    probs = np.full((N_BUCKETS, N_CLASSES), 1.0 / N_CLASSES)
    history = [_row(DAY, 0, "WORK")] * 10
    fit = DayFit.build(history, n_buckets=N_BUCKETS)
    out = PriorCorrectedForecaster(_Fixed(probs), power=1.0).forecast(history, DAY, fit)
    assert np.isfinite(out).all()
    assert np.allclose(out.sum(axis=1), 1.0)


def test_prior_correction_passes_through_empty_history():
    probs = np.full((N_BUCKETS, N_CLASSES), 1.0 / N_CLASSES)
    fit = DayFit.build([], n_buckets=N_BUCKETS)
    out = PriorCorrectedForecaster(_Fixed(probs)).forecast([], DAY, fit)
    assert np.allclose(out, probs)


def test_prior_correction_inverts_when_given_the_wrong_history():
    """
    Regression: the prior must be counted over the *same* history the emissions
    were fit on.

    The serving path fits on a densified history and once counted the prior
    over the sparse token stream instead. The sparse view contains no SLEEP and
    no background at all, so dividing by it boosted exactly the classes the
    correction exists to discount, and every morning bucket came back SLEEP.
    This pins the mechanism so the two can never drift apart silently again.
    """
    sleep, social = CLASS_INDEX["SLEEP"], CLASS_INDEX["SOCIAL"]
    probs = np.zeros((N_BUCKETS, N_CLASSES))
    probs[:, social] = 0.7
    probs[:, sleep] = 0.3

    dense = [_row(DAY, b % N_BUCKETS, "SLEEP") for b in range(90)]
    dense += [_row(DAY, b % N_BUCKETS, "SOCIAL") for b in range(10)]
    sparse = [_row(DAY, b % N_BUCKETS, "SOCIAL") for b in range(10)]
    fit = DayFit.build(dense, n_buckets=N_BUCKETS)

    right = PriorCorrectedForecaster(_Fixed(probs)).forecast(dense, DAY, fit)
    wrong = PriorCorrectedForecaster(_Fixed(probs)).forecast(sparse, DAY, fit)

    # Fit on the dense history, SLEEP is common and gets discounted further.
    assert right[0, social] > right[0, sleep]
    # Counted over the sparse history, SLEEP looks rare and overtakes SOCIAL —
    # the exact inversion that produced an all-SLEEP morning.
    assert wrong[0, sleep] > wrong[0, social]


# ── declared rhythm is local, stored buckets are UTC ──────────────────────────


def test_sleep_window_converts_local_to_utc():
    """
    The FTUE stores local clock times; token_stream buckets are UTC. A
    New York user who sleeps 02:00-09:00 must land on 06:00-13:00 UTC in
    summer, not on buckets 8-35.
    """
    rhythm = {"sleep_time": "02:00", "wake_time": "09:00"}
    got = sleep_buckets(rhythm, 96, tz="America/New_York", on=datetime.date(2026, 7, 1))
    assert min(got) == 24  # 06:00 UTC
    assert max(got) == 51  # 12:45 UTC, window ends at 13:00
    assert len(got) == 28


def test_sleep_window_follows_dst():
    rhythm = {"sleep_time": "02:00", "wake_time": "09:00"}
    summer = sleep_buckets(
        rhythm, 96, tz="America/New_York", on=datetime.date(2026, 7, 1)
    )
    winter = sleep_buckets(
        rhythm, 96, tz="America/New_York", on=datetime.date(2026, 1, 15)
    )
    assert min(winter) - min(summer) == 4  # one hour later in UTC
    assert len(summer) == len(winter) == 28


def test_sleep_window_without_a_timezone_is_unshifted():
    rhythm = {"sleep_time": "02:00", "wake_time": "09:00"}
    assert sleep_buckets(rhythm, 96) == set(range(8, 36))
    assert sleep_buckets(rhythm, 96, tz=None) == set(range(8, 36))


def test_unknown_timezone_does_not_shift_or_raise():
    rhythm = {"sleep_time": "02:00", "wake_time": "09:00"}
    assert sleep_buckets(rhythm, 96, tz="Mars/Olympus") == set(range(8, 36))


def test_conversion_can_wrap_the_window_past_midnight_utc():
    """22:00-06:00 in Tokyo (UTC+9) is 13:00-21:00 UTC, no wrap; the same
    window in Los Angeles (UTC-7) is 05:00-13:00 UTC. Neither loses buckets."""
    rhythm = {"sleep_time": "22:00", "wake_time": "06:00"}
    on = datetime.date(2026, 7, 1)
    assert len(sleep_buckets(rhythm, 96, tz="Asia/Tokyo", on=on)) == 32
    assert len(sleep_buckets(rhythm, 96, tz="America/Los_Angeles", on=on)) == 32


def test_schedule_records_every_bucket_a_short_event_crosses():
    from ci.hbpe.evaluation.schedule import covered_buckets

    # 10:14–10:16 crosses 10:00–10:15 and 10:15–10:30. Starting at 10:14 and
    # stepping 15 minutes used to skip the second bucket.
    start = datetime.datetime(2026, 7, 1, 10, 14)
    finish = datetime.datetime(2026, 7, 1, 10, 16)
    assert covered_buckets(start, finish) == [
        (datetime.date(2026, 7, 1), 40),
        (datetime.date(2026, 7, 1), 41),
    ]


def test_densify_accepts_a_per_day_background():
    from ci.hbpe.pipeline.rhythm import background_factory

    build = background_factory(
        {"sleep_time": "02:00", "wake_time": "09:00"},
        "UNKNOWN",
        96,
        tz="America/New_York",
    )
    rows = densify([_row(datetime.date(2026, 7, 1), 40, "WORK")], build, 96)
    by_bucket = {r["bucket_idx"]: r["token_id"] for r in rows}
    assert by_bucket[24] == "SLEEP"  # 06:00 UTC
    assert by_bucket[40] == "WORK"  # observed beats the filler
    assert by_bucket[0] == "UNKNOWN"


# ── confidence quantiles ──────────────────────────────────────────────────────


def test_logit_reports_the_probability_of_the_shown_class():
    from ci.hbpe.pipeline.inference_engine import confidence_quantiles
    from ci.hbpe.pipeline.serve import MODEL_LOGIT

    # Transformer-window confidences exist but describe a different model; they
    # must not leak into a bucket the head is labelling.
    assert confidence_quantiles(MODEL_LOGIT, [0.9, 0.95, 0.99], 0.31) == (
        0.31,
        0.31,
        0.31,
    )


def test_logit_quantiles_are_nonzero_with_no_transformer_samples():
    """No checkpoint means no window samples; the wash must still have weight."""
    from ci.hbpe.pipeline.inference_engine import confidence_quantiles
    from ci.hbpe.pipeline.serve import MODEL_LOGIT

    assert confidence_quantiles(MODEL_LOGIT, [], 0.74)[1] == 0.74


def test_other_models_keep_the_window_spread():
    from ci.hbpe.pipeline.inference_engine import confidence_quantiles
    from ci.hbpe.pipeline.serve import MODEL_B1

    q10, q50, q90 = confidence_quantiles(MODEL_B1, [0.2, 0.4, 0.6, 0.8], 0.5)
    assert q10 < q50 < q90


def test_baselines_without_samples_stay_zero():
    from ci.hbpe.pipeline.inference_engine import confidence_quantiles
    from ci.hbpe.pipeline.serve import MODEL_B1

    assert confidence_quantiles(MODEL_B1, [], 0.5) == (0.0, 0.0, 0.0)
