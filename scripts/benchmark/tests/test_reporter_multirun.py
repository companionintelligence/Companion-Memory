"""Reporter — multi-run JSON and markdown branches.

The single-run paths are covered by ``test_reporter.py`` and must remain
byte-identical to round-3; these tests only exercise the new shapes.
"""

from __future__ import annotations

from benchmark.reporter import build_json_report, build_markdown_report
from benchmark.schema import QuestionResult, SystemResult


def _persona() -> dict:
    return {
        "persona_id": "p",
        "name": "Test",
        "description": "smoke",
        "eval_questions": [
            {"id": "q1", "question": "?", "keywords": ["x"], "category": "flat-recall"},
            {"id": "q2", "question": "?", "keywords": ["y"], "category": "relational"},
        ],
    }


def _result(name: str, hits: tuple[bool, bool], ingest=100, flush=50, lat=(10.0, 20.0)) -> SystemResult:
    qs = [
        QuestionResult("q1", "?", "flat-recall", ["x"], "ctx", hits[0], lat[0], ""),
        QuestionResult("q2", "?", "relational", ["y"], "ctx", hits[1], lat[1], ""),
    ]
    return SystemResult(system_name=name, ingest_total_ms=ingest, flush_total_ms=flush,
                        question_results=qs)


def test_multirun_json_has_runs_field_and_stats():
    runs = [
        _result("naive", (True, False), ingest=100),
        _result("naive", (True, True), ingest=110),
        _result("naive", (False, True), ingest=90),
    ]
    js = build_json_report(_persona(), [runs])
    sys0 = js["systems"][0]
    assert sys0["runs"] == 3
    # Score includes both run-0 scalar and stats fields.
    assert sys0["score"]["hit"] == 1     # from run 0
    assert sys0["score"]["total"] == 2
    for key in ("median", "mean", "min", "max", "iqr", "stddev"):
        assert key in sys0["score"]
        assert key in sys0["timings_ms"]["ingest"]
        assert key in sys0["timings_ms"]["flush"]
        assert key in sys0["timings_ms"]["search"]
        assert key in sys0["category_stats"]["flat-recall"]


def test_multirun_json_categories_and_questions_from_run0():
    runs = [
        _result("naive", (True, False)),
        _result("naive", (False, True)),
    ]
    js = build_json_report(_persona(), [runs])
    sys0 = js["systems"][0]
    # Run 0: flat-recall hit, relational miss.
    assert sys0["categories"]["flat-recall"] == [1, 1]
    assert sys0["categories"]["relational"] == [0, 1]
    # Questions also from run 0.
    assert sys0["questions"][0]["hit"] is True
    assert sys0["questions"][1]["hit"] is False


def test_singlerun_json_path_unchanged():
    # Passing a flat list of SystemResult must still produce the legacy shape.
    js = build_json_report(_persona(), [_result("naive", (True, False))])
    sys0 = js["systems"][0]
    assert "runs" not in sys0
    assert sys0["score"] == {"hit": 1, "total": 2, "ratio": 0.5}
    assert "category_stats" not in sys0


def test_multirun_markdown_shows_median_iqr_and_run_count():
    runs = [
        _result("naive", (True, False)),
        _result("naive", (True, True)),
        _result("naive", (False, True)),
    ]
    md = build_markdown_report(_persona(), [runs])
    assert "Runs per system: **3**" in md
    assert "median ±IQR" in md
    # Avg search column header still present.
    assert "Avg search" in md


def test_multirun_markdown_per_question_detail_says_run0():
    runs = [_result("naive", (True, False)), _result("naive", (False, False))]
    md = build_markdown_report(_persona(), [runs])
    assert "Per-question detail (run 0)" in md
