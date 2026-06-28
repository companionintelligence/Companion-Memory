"""Reporter — Markdown and JSON outputs."""

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


def _result(name: str, hits: tuple[bool, bool]) -> SystemResult:
    qs = [
        QuestionResult("q1", "?", "flat-recall", ["x"], "ctx", hits[0], 12.3, ""),
        QuestionResult("q2", "?", "relational", ["y"], "ctx", hits[1], 34.5, "ok"),
    ]
    return SystemResult(system_name=name, ingest_total_ms=100, flush_total_ms=50, question_results=qs)


# ── markdown ────────────────────────────────────────────────────────────────

def test_markdown_table_has_headers_for_each_persona_category():
    md = build_markdown_report(_persona(), [_result("naive", (True, False))])
    assert "| System | Score | flat-recall | relational | Ingest | Flush | Avg search |" in md


def test_markdown_renders_error_row_for_failed_systems():
    md = build_markdown_report(
        _persona(),
        [SystemResult("broken", 0, 0, error="setup failed: oops")],
    )
    assert "broken | ERROR" in md
    assert "setup failed: oops" in md


def test_markdown_includes_per_question_detail_by_default():
    md = build_markdown_report(_persona(), [_result("a", (True, True))])
    assert "## Per-question detail" in md
    assert "| q1 |" in md and "| q2 |" in md


def test_markdown_can_omit_per_question_detail():
    md = build_markdown_report(_persona(), [_result("a", (True, True))], include_question_detail=False)
    assert "## Per-question detail" not in md


# ── json ────────────────────────────────────────────────────────────────────

def test_json_report_carries_per_system_scores_and_timings():
    js = build_json_report(_persona(), [_result("naive", (True, False))])
    sys0 = js["systems"][0]
    assert sys0["score"] == {"hit": 1, "total": 2, "ratio": 0.5}
    assert sys0["categories"]["flat-recall"] == [1, 1]
    assert sys0["categories"]["relational"] == [0, 1]
    assert sys0["timings_ms"]["ingest_total"] == 100
    assert len(sys0["questions"]) == 2


def test_json_report_preserves_category_order_from_persona():
    js = build_json_report(_persona(), [])
    assert js["persona"]["categories"] == ["flat-recall", "relational"]
