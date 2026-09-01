"""Pure-math tests for the HBPE landing: kernel, HMM, baselines, D3 gate, metric lifts."""

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
from ci.hbpe.pipeline.baselines import (  # noqa: E402
    b0_probs,
    b1_probs,
    b2_day_emissions,
    emit_for_actuals,
    occupancy_counts,
)
from ci.hbpe.pipeline.hmm import (  # noqa: E402
    apply_class_priors,
    forward_backward,
)
from ci.hbpe.pipeline.kernel import (  # noqa: E402
    dow_boost,
    kernel_weight,
    moy_boost,
    recency_weight,
)
from ci.hbpe.pipeline.metric_lifts import (  # noqa: E402
    SLEEP_EVENING,
    SLEEP_MORNING,
    WORK_HOURS,
    class_multipliers,
    coverage_ok,
    day_coverage_weight,
)
from ci.hbpe.pipeline.scoring import per_class_recall  # noqa: E402
from ci.hbpe.pipeline.serve import (  # noqa: E402
    MODEL_B1,
    MODEL_B2,
    MODEL_HMT,
    pick_served_model,
)

WORK, SLEEP, LEISURE = "WORK", "SLEEP", "LEISURE"


def test_recency_yesterday_heavier_than_three_weeks():
    assert recency_weight(0) > recency_weight(20)
    assert recency_weight(7) == pytest.approx(float(__import__("math").exp(-1.0)))


def test_dow_and_moy_boosts():
    assert dow_boost(1, 1) == 2.0
    assert dow_boost(1, 2) == 1.0
    d = datetime.date(2026, 3, 10)
    assert moy_boost(d, datetime.date(2025, 3, 1), distinct_years=1) == 1.0
    assert moy_boost(d, datetime.date(2025, 3, 1), distinct_years=3) > 1.0
    assert moy_boost(d, datetime.date(2025, 8, 1), distinct_years=3) == 1.0


def test_kernel_weight_composes():
    hist = datetime.date(2026, 8, 10)  # Monday
    forecast = datetime.date(2026, 8, 17)  # Monday, same month
    w = kernel_weight(0, hist, forecast, distinct_years=3, day_coverage_weight=1.0)
    assert w > recency_weight(0)  # DoW × month


def test_forward_backward_smooths_flicker():
    # WORK, LEISURE, WORK — middle bucket should keep WORK mass after smoothing
    em = np.array(
        [
            [0.9, 0.1, 0, 0, 0, 0, 0, 0],
            [0.1, 0.9, 0, 0, 0, 0, 0, 0],
            [0.9, 0.1, 0, 0, 0, 0, 0, 0],
        ],
        dtype=np.float64,
    )
    # Sticky transitions
    tr = np.eye(8) * 0.8 + 0.2 / 8
    tr = np.stack([tr] * 4)
    out = forward_backward(em, tr, n_buckets=BUCKETS_PER_DAY)
    assert out.shape == (3, 8)
    assert out[1, 0] > em[1, 0]  # WORK recovered in the flicker bucket
    np.testing.assert_allclose(out.sum(axis=1), 1.0, atol=1e-6)


def test_apply_class_priors_renormalizes():
    em = np.ones((2, 8)) / 8
    priors = np.ones((2, 8))
    priors[:, 6] = 2.0  # SLEEP
    out = apply_class_priors(em, priors)
    assert out[0, 6] > out[0, 0]
    np.testing.assert_allclose(out.sum(axis=1), 1.0, atol=1e-6)


def test_occupancy_b0_b1_and_b2():
    rows = []
    # Two Mondays, bucket 20 always WORK
    for d in (datetime.date(2026, 8, 3), datetime.date(2026, 8, 10)):
        rows.append({"date": d, "bucket_idx": 20, "token_id": WORK})
        rows.append({"date": d, "bucket_idx": 21, "token_id": WORK})
    b0, b1, trans = occupancy_counts(rows, until=datetime.date(2026, 8, 17))
    p0 = b0_probs(b0, 20)
    assert p0[WORK] > p0[SLEEP]
    p1 = b1_probs(b1, 20, datetime.date(2026, 8, 3).weekday())
    assert p1[WORK] >= 0.3
    b2 = b2_day_emissions(b1, trans, datetime.date(2026, 8, 3).weekday())
    assert b2.shape == (BUCKETS_PER_DAY, 8)
    np.testing.assert_allclose(b2.sum(axis=1), 1.0, atol=1e-6)


def test_occupancy_accepts_iso_date_strings():
    rows = [{"date": "2026-08-03", "bucket_idx": 20, "token_id": WORK}]
    b0, _b1, _trans = occupancy_counts(rows, until=datetime.date(2026, 8, 17))
    assert b0[20].sum() == 1.0


def test_emit_for_actuals_walk_forward():
    occ = [
        {"date": datetime.date(2026, 8, 3), "bucket_idx": 10, "token_id": WORK},
        {"date": datetime.date(2026, 8, 10), "bucket_idx": 10, "token_id": WORK},
    ]
    actuals = [
        {
            "horizon_start": datetime.datetime(2026, 8, 17, 0, 0),
            "bucket_index": 10,
            "actual_l0": WORK,
        }
    ]
    emitted = emit_for_actuals(occ, actuals)
    assert len(emitted["b0"]) == 1
    assert emitted["b0"][0]["l0_probs"][WORK] > emitted["b0"][0]["l0_probs"][SLEEP]


def test_per_class_recall_sleep_not_hidden():
    rows = [
        {"l0_probs": {WORK: 0.9, SLEEP: 0.1}, "actual_l0": WORK},
        {"l0_probs": {WORK: 0.9, SLEEP: 0.1}, "actual_l0": SLEEP},
        {"l0_probs": {WORK: 0.9, SLEEP: 0.1}, "actual_l0": SLEEP},
    ]
    rec = per_class_recall(rows)
    assert rec[WORK]["recall"] == 1.0
    assert rec[SLEEP]["recall"] == 0.0
    assert rec[SLEEP]["support"] == 2


def test_d3_picks_hmt_on_brier_and_ece():
    # Misses the +5pp top-1 margin, but better Brier vs B1 and better ECE vs B2.
    hmt = {"l0_top1_acc": 0.72, "brier": 0.20, "ece": 0.05}
    b1 = {"l0_top1_acc": 0.70, "brier": 0.30, "ece": 0.10}
    b2 = {"l0_top1_acc": 0.71, "brier": 0.28, "ece": 0.08}
    assert pick_served_model(hmt, b1, b2, has_checkpoint=True) == MODEL_HMT


def test_d3_picks_hmt_on_margin():
    hmt = {"l0_top1_acc": 0.80, "brier": 0.3, "ece": 0.1}
    b1 = {"l0_top1_acc": 0.70, "brier": 0.4, "ece": 0.1}
    b2 = {"l0_top1_acc": 0.72, "brier": 0.35, "ece": 0.12}
    assert pick_served_model(hmt, b1, b2, has_checkpoint=True) == MODEL_HMT


def test_d3_picks_b2_when_hmt_misses():
    hmt = {"l0_top1_acc": 0.71, "brier": 0.45, "ece": 0.2}
    b1 = {"l0_top1_acc": 0.70, "brier": 0.30, "ece": 0.08}
    b2 = {"l0_top1_acc": 0.72, "brier": 0.32, "ece": 0.07}
    assert pick_served_model(hmt, b1, b2, has_checkpoint=True) == MODEL_B2


def test_d3_cold_start_without_checkpoint():
    assert pick_served_model(None, None, None, has_checkpoint=False) == MODEL_B1


def test_metric_lifts_refuse_below_floor():
    rows = [
        {
            "sleep_minutes": 400,
            "time_at_home": 100,
            "coverage": {"sleep_minutes": 1, "time_at_home": 1},
        }
        for _ in range(5)
    ]
    assert coverage_ok(rows) is False
    m = class_multipliers(2, 500, 100, 420, 600, floor_cleared=False)
    assert m[SLEEP] == 1.0
    assert day_coverage_weight(rows[0], False) == 1.0


def test_metric_lifts_sleep_morning_when_floor_cleared():
    m = class_multipliers(2, 840, None, 420, 600, floor_cleared=True)
    assert m[SLEEP] == pytest.approx(2.0)
    # 10:00 local — work hours on the current 15-minute grid (bucket 40).
    work_bucket = (10 * 60) // 15
    m_work = class_multipliers(work_bucket, None, 1200, 420, 600, floor_cleared=True)
    assert m_work[WORK] < 1.0
    assert m_work[LEISURE] > 1.0


def test_metric_lifts_windows_track_bucket_minutes():
    """Sleep/work ranges are wall-clock hours, not leftover 30-minute indices."""
    assert list(SLEEP_MORNING)[0] == 0
    assert list(SLEEP_MORNING)[-1] == (8 * 60) // 15 - 1
    assert 42 not in SLEEP_EVENING  # 10:30 was the old 30-min "evening" start
    assert (21 * 60) // 15 in SLEEP_EVENING
    assert (8 * 60) // 15 in WORK_HOURS
    assert (18 * 60) // 15 - 1 in WORK_HOURS
    assert (18 * 60) // 15 not in WORK_HOURS


def test_hierarchical_mask_blocks_upward_flow():
    torch = pytest.importorskip("torch")
    from ci.hbpe.model.transformer import N_HEADS, hierarchical_src_mask

    # sequence: L0, L1, L0
    levels = torch.tensor([[0, 1, 0]])
    mask = hierarchical_src_mask(levels)
    assert mask.shape == (N_HEADS, 3, 3)
    # L0 query (row 0) cannot attend to L1 key (col 1)
    assert bool(mask[0, 0, 1]) is True
    # L1 query (row 1) can attend to L0 keys
    assert bool(mask[0, 1, 0]) is False
    assert bool(mask[0, 1, 2]) is False


def test_l2_head_skipped_below_token_floor(monkeypatch):
    from ci.hbpe.pipeline import l2_gate

    monkeypatch.setattr(l2_gate, "count_l2_tokens", lambda _uid: 3)
    assert l2_gate.l2_head_enabled("user") is False
    monkeypatch.setattr(l2_gate, "count_l2_tokens", lambda _uid: 50)
    assert l2_gate.l2_head_enabled("user") is True


def test_histogram_keeps_b1_ready_while_still_learning():
    from ci.hbpe.pipeline.histogram_api import build_histogram

    class _Engine:
        last_model_version = "b1"
        last_still_learning = True

        def predict(self, horizon_start=None):
            return [
                {
                    "bucket_index": 0,
                    "start_time": "2026-08-18T00:00:00Z",
                    "l0_probs": {WORK: 0.6, SLEEP: 0.4},
                    "l1_probs": {},
                    "l2_probs": {},
                }
            ]

    out = build_histogram(_Engine(), user_id=None)
    assert out["still_learning"] is True
    assert out["model_version"] == "b1"
    assert out["system_status"] == "READY"
    assert out["buckets"][0]["l2_probs"] == {}

    # The API used to pass COLD_START from checkpoint absence and skip this override.
    overridden = build_histogram(_Engine(), user_id=None, system_status="COLD_START")
    assert overridden["system_status"] == "READY"


def test_histogram_keeps_pipeline_step_while_still_learning(monkeypatch):
    from ci.hbpe.pipeline.histogram_api import build_histogram

    class _Engine:
        last_model_version = "b1"
        last_still_learning = True

        def predict(self, horizon_start=None):
            return [
                {
                    "bucket_index": 0,
                    "start_time": "2026-08-18T00:00:00Z",
                    "l0_probs": {WORK: 0.6, SLEEP: 0.4},
                    "l1_probs": {},
                    "l2_probs": {},
                }
            ]

    monkeypatch.setattr(
        "ci.hbpe.pipeline.histogram_api._log_prediction", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "ci.hbpe.pipeline.histogram_api._pipeline_progress",
        lambda _uid: {"eta_seconds": 2700, "detail": "3 of 50"},
    )
    out = build_histogram(
        _Engine(),
        user_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        system_status="NIGHTLY:train",
    )
    assert out["system_status"] == "NIGHTLY:train"
    assert out["pipeline_eta_seconds"] == 2700
    assert out["pipeline_detail"] == "3 of 50"
    assert out["still_learning"] is True
    assert out["model_version"] == "b1"
