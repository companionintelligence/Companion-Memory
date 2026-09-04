"""Schema validation + persona-file integrity tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from benchmark.schema import EvalQuestion, validate_persona


def _valid_persona() -> dict:
    return {
        "persona_id": "p1",
        "name": "Test",
        "sessions": [
            {"id": "s1", "messages": [{"role": "user", "content": "hi"}]},
        ],
        "eval_questions": [
            {
                "id": "q1",
                "question": "what?",
                "keywords": ["x"],
                "category": "flat-recall",
            },
        ],
    }


# ── happy path ──────────────────────────────────────────────────────────────


def test_valid_persona_has_no_errors():
    assert validate_persona(_valid_persona()) == []


def test_eval_question_from_dict_round_trip():
    q = EvalQuestion.from_dict(
        {"id": "q", "question": "?", "keywords": ["k"], "category": "c", "answer": "A"}
    )
    assert q.id == "q"
    assert q.answer == "A"
    assert q.keywords == ["k"]


# ── failure modes ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "missing", ["persona_id", "name", "sessions", "eval_questions"]
)
def test_missing_top_level_field_reports_error(missing):
    p = _valid_persona()
    del p[missing]
    errors = validate_persona(p)
    assert any(missing in e for e in errors), errors


def test_session_must_have_messages():
    p = _valid_persona()
    p["sessions"][0]["messages"] = []
    assert any("non-empty" in e for e in validate_persona(p))


def test_question_must_have_keywords():
    p = _valid_persona()
    p["eval_questions"][0]["keywords"] = []
    assert any("keywords" in e for e in validate_persona(p))


def test_duplicate_session_id_flagged():
    p = _valid_persona()
    p["sessions"].append({"id": "s1", "messages": [{"role": "user", "content": "x"}]})
    assert any("duplicate session id" in e for e in validate_persona(p))


def test_duplicate_question_id_flagged():
    p = _valid_persona()
    p["eval_questions"].append(
        {"id": "q1", "question": "?", "keywords": ["x"], "category": "c"}
    )
    assert any("duplicate question id" in e for e in validate_persona(p))


def test_not_an_object_returns_clear_error():
    assert validate_persona("not a dict") == ["persona must be a JSON object"]


# ── shipped persona files must validate ─────────────────────────────────────

PERSONAS = sorted((Path(__file__).resolve().parent.parent / "personas").glob("*.json"))


@pytest.mark.parametrize("path", PERSONAS, ids=[p.name for p in PERSONAS])
def test_shipped_persona_validates(path: Path):
    data = json.loads(path.read_text())
    errors = validate_persona(data)
    assert errors == [], f"{path.name}: {errors}"
