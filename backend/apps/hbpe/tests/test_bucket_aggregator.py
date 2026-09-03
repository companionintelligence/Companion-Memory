"""One L0+L1 per 15-min bucket; anchor salience beats ambient duration."""

from __future__ import annotations

from decimal import Decimal

from ci.hbpe.tokenizer.bucket_aggregator import aggregate_day
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES


def test_anchor_beats_longer_ambient():
    tokens = aggregate_day(
        [
            {
                "start_min": 540,
                "end_min": 554,
                "default_duration_min": 3,
                "tier": "ambient",
                "l0_class": "LEISURE",
                "l1_cluster_id": "listening",
                "l1_sim": 1.0,
            },
            {
                "start_min": 545,
                "end_min": 545.5,
                "default_duration_min": 30,
                "tier": "anchor",
                "l0_class": "ERRAND",
                "l1_cluster_id": "dentist",
                "l1_sim": 1.0,
            },
        ]
    )
    l0 = [t for t in tokens if t["level"] == "L0"]
    l1 = [t for t in tokens if t["level"] == "L1"]
    assert {t["token_id"] for t in l0} == {"ERRAND"}
    assert {t["token_id"] for t in l1} == {"dentist"}


def test_occupancy_keeps_loser_mass():
    tokens = aggregate_day(
        [
            {
                "start_min": 0,
                "end_min": 15,
                "tier": "ambient",
                "l0_class": "LEISURE",
                "l1_cluster_id": "listening",
                "l1_sim": 1.0,
            },
            {
                "start_min": 0,
                "end_min": 1,
                "tier": "anchor",
                "l0_class": "WORK",
                "l1_cluster_id": "standup",
                "l1_sim": 1.0,
            },
        ]
    )
    l0 = next(t for t in tokens if t["level"] == "L0")
    assert l0["token_id"] == "WORK"
    leisure_idx = L0_CLASSES.index("LEISURE")
    work_idx = L0_CLASSES.index("WORK")
    assert l0["soft_prob_vector"][leisure_idx] > 0
    assert l0["soft_prob_vector"][work_idx] > 0


def test_one_pair_per_bucket():
    tokens = aggregate_day(
        [
            {
                "start_min": 0,
                "end_min": 10,
                "tier": "anchor",
                "l0_class": "WORK",
                "l1_cluster_id": "a",
                "l1_sim": 1.0,
            },
            {
                "start_min": 2,
                "end_min": 8,
                "tier": "anchor",
                "l0_class": "SOCIAL",
                "l1_cluster_id": "b",
                "l1_sim": 1.0,
            },
        ]
    )
    assert sum(1 for t in tokens if t["level"] == "L0") == 1
    assert sum(1 for t in tokens if t["level"] == "L1") == 1


def test_decimal_start_and_end_min_from_postgres_extract():
    """get_token_events_for_day computes start_min/end_min via
    EXTRACT(epoch FROM ...) / 60.0, which Postgres returns as numeric ->
    decimal.Decimal. aggregate_day must not raise TypeError when mixing
    that with the float defaults used elsewhere."""
    tokens = aggregate_day(
        [
            {
                "l0_class": "LEISURE",
                "l1_cluster_id": "c1",
                "l1_sim": 1.0,
                "tier": "ambient",
                "start_min": Decimal("603.2"),
                "end_min": Decimal("606.75"),
                "default_duration_min": 3,
                "priority": None,
            }
        ]
    )
    l0 = [t for t in tokens if t["level"] == "L0"]
    l1 = [t for t in tokens if t["level"] == "L1"]
    assert len(l0) == 1
    assert l0[0]["token_id"] == "LEISURE"
    assert l0[0]["bucket_idx"] == 40
    assert len(l1) == 1
    assert l1[0]["token_id"] == "c1"
