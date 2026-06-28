"""Persona generator — deterministic noise injection."""

from __future__ import annotations

from benchmark.generate_persona import generate
from benchmark.schema import validate_persona


def _base() -> dict:
    return {
        "persona_id": "p",
        "name": "Test",
        "sessions": [
            {"id": "s1", "messages": [{"role": "user", "content": "Jordan lives in Austin."}]}
        ],
        "eval_questions": [
            {"id": "q1", "question": "Where?", "keywords": ["Austin"], "category": "flat-recall"}
        ],
    }


def test_zero_noise_returns_a_validated_clone():
    base = _base()
    out = generate(base, noise_sessions=0)
    assert out == base and out is not base  # deep clone
    assert validate_persona(out) == []


def test_noise_sessions_are_appended_and_valid():
    out = generate(_base(), noise_sessions=5, messages_per_noise_session=2, seed=1)
    assert len(out["sessions"]) == 6     # 1 base + 5 noise
    assert all(len(s["messages"]) == 2 for s in out["sessions"][1:])
    assert validate_persona(out) == []


def test_generation_is_deterministic_for_a_fixed_seed():
    a = generate(_base(), noise_sessions=3, seed=42)
    b = generate(_base(), noise_sessions=3, seed=42)
    assert a == b


def test_distinct_session_ids_even_when_pre_existing_ids_collide():
    base = _base()
    base["sessions"].append({"id": "noise_1", "messages": [{"role": "user", "content": "x"}]})
    out = generate(base, noise_sessions=2, seed=0)
    ids = [s["id"] for s in out["sessions"]]
    assert len(ids) == len(set(ids))


def test_base_is_not_mutated():
    base = _base()
    generate(base, noise_sessions=3, seed=0)
    assert len(base["sessions"]) == 1
