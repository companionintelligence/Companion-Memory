"""Multi-run aggregation shape and determinism."""

from __future__ import annotations

import pytest
from benchmark.aggregation import aggregate_runs, aggregated_to_json
from benchmark.schema import QuestionResult, SystemResult


def _make_run(
    name: str,
    hits: tuple[bool, ...],
    ingest_ms: float,
    flush_ms: float,
    search_lats: tuple[float, ...],
) -> SystemResult:
    qs = []
    cats = ("flat-recall", "flat-recall", "relational")
    ids = ("q1", "q2", "q3")
    for q_id, cat, hit, lat in zip(ids, cats, hits, search_lats, strict=True):
        qs.append(QuestionResult(q_id, "?", cat, ["k"], "ctx", hit, lat, ""))
    return SystemResult(
        system_name=name,
        ingest_total_ms=ingest_ms,
        flush_total_ms=flush_ms,
        question_results=qs,
    )


def _runs() -> list[SystemResult]:
    return [
        _make_run("a", (True, False, True), 100, 10, (1, 2, 3)),
        _make_run("a", (True, True, True), 110, 12, (2, 3, 4)),
        _make_run("a", (False, False, True), 90, 8, (3, 4, 5)),
    ]


def test_aggregate_shape_has_required_fields():
    agg = aggregate_runs(_runs(), categories=["flat-recall", "relational"])
    assert agg.n_runs == 3
    assert len(agg.overall_ratios) == 3
    assert len(agg.ingest_ms) == 3
    assert len(agg.flush_ms) == 3
    assert len(agg.search_ms) == 3
    assert "flat-recall" in agg.category_ratios
    assert "relational" in agg.category_ratios


def test_aggregated_to_json_carries_locked_keys():
    agg = aggregate_runs(_runs(), categories=["flat-recall", "relational"])
    js = aggregated_to_json(agg, categories=["flat-recall", "relational"])
    # Category cells pool every completed run, not just run 0.
    assert js["categories"]["flat-recall"] == [3, 6]  # 1/2 + 2/2 + 0/2
    assert js["categories"]["relational"] == [3, 3]  # 1/1 + 1/1 + 1/1
    assert len(js["questions"]) == 3
    # Multi-run fields
    assert js["runs"] == 3
    assert js["runs_ok"] == 3
    assert js["runs_errored"] == 0
    for key in ("median", "mean", "min", "max", "iqr", "stddev"):
        assert key in js["score"]
        assert key in js["category_stats"]["flat-recall"]
        assert key in js["timings_ms"]["ingest"]
        assert key in js["timings_ms"]["flush"]
        assert key in js["timings_ms"]["search"]


def test_aggregate_is_deterministic_for_fixed_inputs():
    agg1 = aggregate_runs(_runs(), categories=["flat-recall", "relational"])
    agg2 = aggregate_runs(_runs(), categories=["flat-recall", "relational"])
    js1 = aggregated_to_json(agg1, categories=["flat-recall", "relational"])
    js2 = aggregated_to_json(agg2, categories=["flat-recall", "relational"])
    assert js1 == js2


def test_aggregate_empty_raises():
    with pytest.raises(ValueError):
        aggregate_runs([], categories=["flat-recall"])


def test_aggregated_overall_score_pools_runs_and_reports_the_median():
    # score.{hit,total,ratio} pool every completed run; median/IQR/etc.
    # describe the per-run distribution.
    agg = aggregate_runs(_runs(), categories=["flat-recall", "relational"])
    js = aggregated_to_json(agg, categories=["flat-recall", "relational"])
    # Runs scored 2/3, 3/3 and 1/3.
    assert js["score"]["hit"] == 6
    assert js["score"]["total"] == 9
    assert js["score"]["ratio"] == pytest.approx(6 / 9)
    # Median of [2/3, 3/3, 1/3] = 2/3.
    assert js["score"]["median"] == pytest.approx(2 / 3)
    assert js["score"]["min"] == pytest.approx(1 / 3)
    assert js["score"]["max"] == pytest.approx(1.0)
