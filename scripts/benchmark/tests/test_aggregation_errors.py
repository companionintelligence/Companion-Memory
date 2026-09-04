"""Aggregation must not let run 0 speak for the whole set, and must not
score an errored run as a zero.

These are the two halves of the same failure mode: a multi-run benchmark
that quietly reports a clean number for a system that mostly fell over.
"""

from __future__ import annotations

import pytest
from benchmark.aggregation import aggregate_runs, aggregated_to_json
from benchmark.schema import QuestionResult, SystemResult

CATS = ["flat-recall", "relational"]


def _ok(
    hits: tuple[bool, bool, bool],
    *,
    ingest: float = 100.0,
    flush: float = 10.0,
    lats: tuple[float, float, float] = (5.0, 5.0, 5.0),
) -> SystemResult:
    cats = ("flat-recall", "flat-recall", "relational")
    qs = [
        QuestionResult(f"q{i + 1}", "?", cats[i], ["k"], "ctx", hits[i], lats[i], "")
        for i in range(3)
    ]
    return SystemResult("a", ingest, flush, question_results=qs)


def _err(msg: str = "ingest failed: boom") -> SystemResult:
    """Exactly what ``run_system`` returns on a failed run: no questions."""
    return SystemResult("a", 0.0, 0.0, error=msg)


# ── errored runs are excluded, not counted as zeros ──────────────────────────


def test_errored_runs_do_not_drag_the_score_median_to_zero():
    runs = [_ok((True, True, True)), _err(), _err()]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    # One run completed and it scored 100%. Folding the two failures in as
    # 0.0 would report a median of 0% for a system that never scored 0%.
    assert js["score"]["median"] == pytest.approx(1.0)
    assert js["score"]["min"] == pytest.approx(1.0)
    assert js["score"]["stddev"] == pytest.approx(0.0)


def test_errored_runs_do_not_understate_latency():
    runs = [_ok((True, True, True), ingest=100, flush=20, lats=(8, 8, 8)), _err()]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    t = js["timings_ms"]
    assert t["ingest"]["median"] == pytest.approx(100.0)
    assert t["flush"]["median"] == pytest.approx(20.0)
    assert t["search"]["median"] == pytest.approx(8.0)


def test_errored_runs_do_not_fabricate_variance():
    runs = [_ok((True, True, True)), _ok((True, True, True)), _err()]
    agg = aggregate_runs(runs, categories=CATS)
    js = aggregated_to_json(agg, categories=CATS)
    # Two identical successful runs: zero spread. The failure must not
    # invent an IQR out of a phantom 0.0 sample.
    assert js["score"]["iqr"] == pytest.approx(0.0)
    assert js["score"]["stddev"] == pytest.approx(0.0)
    assert len(agg.overall_ratios) == 2


def test_errored_runs_are_counted_and_reported_alongside():
    runs = [_ok((True, True, True)), _err("flush failed: nope"), _err("boom")]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    assert js["runs"] == 3
    assert js["runs_ok"] == 1
    assert js["runs_errored"] == 2
    assert js["errors"] == ["flush failed: nope", "boom"]


def test_no_errors_reports_zero_errored_runs():
    runs = [_ok((True, False, True)), _ok((True, True, True))]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    assert js["runs_ok"] == 2
    assert js["runs_errored"] == 0
    assert js["errors"] == []
    assert js["error"] is None


# ── run 0 does not speak for the set ─────────────────────────────────────────


def test_error_is_set_only_when_every_run_errored():
    all_bad = aggregated_to_json(
        aggregate_runs([_err("a"), _err("b")], categories=CATS), categories=CATS
    )
    assert all_bad["error"] == "a"
    assert all_bad["runs_ok"] == 0

    # Run 0 errored but a later run succeeded: the system is not "errored".
    mixed = aggregated_to_json(
        aggregate_runs([_err("a"), _ok((True, True, True))], categories=CATS),
        categories=CATS,
    )
    assert mixed["error"] is None
    assert mixed["score"]["ratio"] == pytest.approx(1.0)


def test_run0_error_does_not_blank_the_categories_of_later_runs():
    runs = [_err(), _ok((True, False, True))]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    assert js["categories"]["flat-recall"] == [1, 2]
    assert js["categories"]["relational"] == [1, 1]


def test_score_pools_every_ok_run_not_just_run0():
    # run 0 = 2/3, run 1 = 3/3, run 2 = 1/3  →  6/9 pooled.
    runs = [
        _ok((True, False, True)),
        _ok((True, True, True)),
        _ok((False, False, True)),
    ]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    assert js["score"]["hit"] == 6
    assert js["score"]["total"] == 9
    assert js["score"]["ratio"] == pytest.approx(6 / 9)


def test_categories_pool_every_ok_run_not_just_run0():
    runs = [
        _ok((True, False, True)),  # flat 1/2, rel 1/1
        _ok((True, True, False)),  # flat 2/2, rel 0/1
    ]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    assert js["categories"]["flat-recall"] == [3, 4]
    assert js["categories"]["relational"] == [1, 2]


def test_categories_exclude_errored_runs_from_the_denominator():
    runs = [_ok((True, False, True)), _err()]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    # The failed run contributed no questions, so it must not inflate the
    # denominator into "1 of 4" either.
    assert js["categories"]["flat-recall"] == [1, 2]


def test_questions_report_hits_across_runs_not_run0():
    runs = [
        _ok((True, False, True), lats=(10, 10, 10)),
        _ok((False, False, True), lats=(20, 20, 20)),
        _err(),
    ]
    js = aggregated_to_json(aggregate_runs(runs, categories=CATS), categories=CATS)
    by_id = {q["id"]: q for q in js["questions"]}
    assert by_id["q1"]["hits"] == 1
    assert by_id["q1"]["runs"] == 2
    assert by_id["q1"]["hit_ratio"] == pytest.approx(0.5)
    assert by_id["q2"]["hits"] == 0
    assert by_id["q3"]["hits"] == 2
    assert by_id["q3"]["hit_ratio"] == pytest.approx(1.0)
    assert by_id["q1"]["latency_ms"] == pytest.approx(15.0)


# ── degenerate inputs stay total ─────────────────────────────────────────────


def test_all_runs_errored_yields_zeroed_stats_without_crashing():
    js = aggregated_to_json(
        aggregate_runs([_err("x"), _err("y")], categories=CATS), categories=CATS
    )
    assert js["runs"] == 2
    assert js["runs_ok"] == 0
    assert js["score"] == {
        "hit": 0,
        "total": 0,
        "ratio": 0.0,
        "median": 0.0,
        "mean": 0.0,
        "min": 0.0,
        "max": 0.0,
        "iqr": 0.0,
        "stddev": 0.0,
    }
    assert js["categories"]["flat-recall"] == [0, 0]
    assert js["questions"] == []
    for phase in ("ingest", "flush", "search"):
        assert js["timings_ms"][phase]["median"] == 0.0


def test_aggregate_exposes_ok_and_errored_partitions():
    runs = [_ok((True, True, True)), _err(), _ok((False, False, False))]
    agg = aggregate_runs(runs, categories=CATS)
    assert agg.n_runs == 3
    assert agg.n_ok == 2
    assert agg.n_errored == 1
    assert not agg.all_errored
    assert agg.errors == ["ingest failed: boom"]
