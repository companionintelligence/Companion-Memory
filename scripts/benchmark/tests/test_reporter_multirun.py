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


def _result(
    name: str, hits: tuple[bool, bool], ingest=100, flush=50, lat=(10.0, 20.0)
) -> SystemResult:
    qs = [
        QuestionResult("q1", "?", "flat-recall", ["x"], "ctx", hits[0], lat[0], ""),
        QuestionResult("q2", "?", "relational", ["y"], "ctx", hits[1], lat[1], ""),
    ]
    return SystemResult(
        system_name=name,
        ingest_total_ms=ingest,
        flush_total_ms=flush,
        question_results=qs,
    )


def test_multirun_json_has_runs_field_and_stats():
    runs = [
        _result("naive", (True, False), ingest=100),
        _result("naive", (True, True), ingest=110),
        _result("naive", (False, True), ingest=90),
    ]
    js = build_json_report(_persona(), [runs])
    sys0 = js["systems"][0]
    assert sys0["runs"] == 3
    assert sys0["runs_ok"] == 3
    assert sys0["runs_errored"] == 0
    # Score pools every completed run and carries the distribution stats.
    assert sys0["score"]["hit"] == 4  # 1 + 2 + 1
    assert sys0["score"]["total"] == 6  # 2 questions x 3 runs
    for key in ("median", "mean", "min", "max", "iqr", "stddev"):
        assert key in sys0["score"]
        assert key in sys0["timings_ms"]["ingest"]
        assert key in sys0["timings_ms"]["flush"]
        assert key in sys0["timings_ms"]["search"]
        assert key in sys0["category_stats"]["flat-recall"]


def test_multirun_json_categories_and_questions_span_every_run():
    runs = [
        _result("naive", (True, False)),
        _result("naive", (False, True)),
    ]
    js = build_json_report(_persona(), [runs])
    sys0 = js["systems"][0]
    # Each category was hit in one of the two runs.
    assert sys0["categories"]["flat-recall"] == [1, 2]
    assert sys0["categories"]["relational"] == [1, 2]
    # Questions carry a hit count across runs, not run 0's boolean.
    assert sys0["questions"][0]["hits"] == 1
    assert sys0["questions"][0]["runs"] == 2
    assert sys0["questions"][1]["hits"] == 1


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


def test_multirun_markdown_per_question_detail_counts_hits_across_runs():
    runs = [_result("naive", (True, False)), _result("naive", (False, False))]
    md = build_markdown_report(_persona(), [runs])
    assert "Per-question detail" in md
    assert "run 0" not in md
    # q1 hit in one of two runs, q2 in neither.
    assert "| q1 | flat-recall | 1/2 |" in md
    assert "| q2 | relational | 0/2 |" in md


def _errored(name: str, msg: str) -> SystemResult:
    return SystemResult(
        system_name=name, ingest_total_ms=0, flush_total_ms=0, error=msg
    )


def test_multirun_markdown_reports_how_many_runs_survived():
    runs = [
        _result("naive", (True, True)),
        _errored("naive", "flush failed: boom"),
        _result("naive", (True, True)),
    ]
    md = build_markdown_report(_persona(), [runs])
    # The table must say 2 of 3 runs produced data, and name the failure —
    # otherwise a mostly-broken system renders as a clean 100%.
    assert "2/3" in md
    assert "flush failed: boom" in md


def test_multirun_markdown_categories_survive_a_failed_run0():
    runs = [_errored("naive", "setup failed: boom"), _result("naive", (True, False))]
    md = build_markdown_report(_persona(), [runs])
    # Run 0 errored but run 1 scored; the row is not an ERROR row and the
    # category cells come from the run that completed.
    assert "ERROR" not in md
    assert "| 1/1 |" in md


def test_multirun_markdown_all_runs_errored_is_an_error_row():
    runs = [_errored("naive", "setup failed: boom"), _errored("naive", "again")]
    md = build_markdown_report(_persona(), [runs])
    assert "ERROR" in md
