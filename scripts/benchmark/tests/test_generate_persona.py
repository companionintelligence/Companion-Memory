"""Persona generator — deterministic noise injection."""

from __future__ import annotations

import pytest
from benchmark.generate_persona import generate
from benchmark.schema import validate_persona


def _base() -> dict:
    return {
        "persona_id": "p",
        "name": "Test",
        "sessions": [
            {
                "id": "s1",
                "messages": [{"role": "user", "content": "Jordan lives in Austin."}],
            }
        ],
        "eval_questions": [
            {
                "id": "q1",
                "question": "Where?",
                "keywords": ["Austin"],
                "category": "flat-recall",
            }
        ],
    }


def test_zero_noise_returns_a_validated_clone():
    base = _base()
    out = generate(base, noise_sessions=0)
    assert out == base and out is not base  # deep clone
    assert validate_persona(out) == []


def test_noise_sessions_are_appended_and_valid():
    out = generate(_base(), noise_sessions=5, messages_per_noise_session=2, seed=1)
    assert len(out["sessions"]) == 6  # 1 base + 5 noise
    assert all(len(s["messages"]) == 2 for s in out["sessions"][1:])
    assert validate_persona(out) == []


def test_generation_is_deterministic_for_a_fixed_seed():
    a = generate(_base(), noise_sessions=3, seed=42)
    b = generate(_base(), noise_sessions=3, seed=42)
    assert a == b


def test_distinct_session_ids_even_when_pre_existing_ids_collide():
    base = _base()
    base["sessions"].append(
        {"id": "noise_1", "messages": [{"role": "user", "content": "x"}]}
    )
    out = generate(base, noise_sessions=2, seed=0)
    ids = [s["id"] for s in out["sessions"]]
    assert len(ids) == len(set(ids))


def test_base_is_not_mutated():
    base = _base()
    generate(base, noise_sessions=3, seed=0)
    assert len(base["sessions"]) == 1


# ── position parameter ──────────────────────────────────────────────────────


def test_append_position_puts_noise_after_originals_default():
    out = generate(_base(), noise_sessions=3, seed=1)
    ids = [s["id"] for s in out["sessions"]]
    # Originals first, noise second.
    assert ids[0] == "s1"
    assert all(i.startswith("noise_") for i in ids[1:])


def test_prepend_position_puts_noise_before_originals():
    out = generate(_base(), noise_sessions=3, seed=1, position="prepend")
    ids = [s["id"] for s in out["sessions"]]
    assert all(i.startswith("noise_") for i in ids[:3])
    assert ids[-1] == "s1"


def test_interleave_position_scatters_originals_among_noise():
    base = _base()
    # Add a second original session so "scattered" is observable.
    base["sessions"].append(
        {"id": "s2", "messages": [{"role": "user", "content": "second"}]}
    )
    out = generate(base, noise_sessions=8, seed=42, position="interleave")
    ids = [s["id"] for s in out["sessions"]]
    s1, s2 = ids.index("s1"), ids.index("s2")
    # The two original sessions must not be adjacent (with this seed). The point
    # of interleave is to drop facts at arbitrary positions in the timeline.
    assert abs(s1 - s2) > 1


def test_interleave_is_deterministic_for_a_fixed_seed():
    a = generate(_base(), noise_sessions=5, seed=7, position="interleave")
    b = generate(_base(), noise_sessions=5, seed=7, position="interleave")
    assert [s["id"] for s in a["sessions"]] == [s["id"] for s in b["sessions"]]


def test_unknown_position_raises():
    with pytest.raises(ValueError, match="position must be"):
        generate(_base(), noise_sessions=1, position="middle")


def test_every_position_yields_a_valid_persona():
    for pos in ("append", "prepend", "interleave"):
        out = generate(_base(), noise_sessions=5, seed=1, position=pos)
        assert validate_persona(out) == [], pos
