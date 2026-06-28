"""Runner — drives the full lifecycle against a stub adapter."""

from __future__ import annotations

from typing import List

import pytest

from benchmark.adapters.base import MemoryAdapter
from benchmark.runner import run_all, run_system
from benchmark.scoring import score_keyword


def _persona() -> dict:
    return {
        "persona_id": "p1",
        "name": "Test",
        "sessions": [
            {"id": "s1", "messages": [
                {"role": "user", "content": "Jordan lives in Austin, Texas."},
                {"role": "assistant", "content": "Noted."},  # filtered out
                {"role": "user", "content": "Loves climbing."},
            ]},
            {"id": "s2", "messages": [
                {"role": "user", "content": "Adopted a dog named Mango."},
            ]},
        ],
        # Queries are worded so each word appears verbatim in the fragment the
        # recording adapter is supposed to surface — the toy adapter does plain
        # substring matching, not stemming.
        "eval_questions": [
            {"id": "q1", "question": "Jordan lives where?",
             "keywords": ["Austin"], "category": "flat-recall"},
            {"id": "q2", "question": "dog named what?",
             "keywords": ["Mango"], "category": "relational"},
            {"id": "q3", "question": "submarine trivia please",
             "keywords": ["nothing-in-context"], "category": "flat-recall"},
        ],
    }


class _RecordingAdapter(MemoryAdapter):
    """Captures every lifecycle call so the harness can assert on the contract."""

    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self._store: List[str] = []
        self._fail_in: str | None = None

    @property
    def name(self) -> str:
        return "rec"

    def setup(self, user_id: str) -> None:
        self.calls.append(("setup", user_id))
        if self._fail_in == "setup":
            raise RuntimeError("setup boom")
        self._store = []

    def ingest(self, text: str, session_id: str) -> None:
        self.calls.append(("ingest", session_id, text))
        if self._fail_in == "ingest":
            raise RuntimeError("ingest boom")
        self._store.append(text)

    def flush(self) -> None:
        self.calls.append(("flush",))
        if self._fail_in == "flush":
            raise RuntimeError("flush boom")

    def search(self, query: str) -> str:
        self.calls.append(("search", query))
        return "\n".join(t for t in self._store if any(w.lower() in t.lower() for w in query.split()))

    def teardown(self) -> None:
        self.calls.append(("teardown",))


# ── happy path ──────────────────────────────────────────────────────────────

def test_runner_iterates_only_user_messages_then_flushes_then_searches():
    a = _RecordingAdapter()
    result = run_system(a, _persona(), "u1", score_keyword)
    ingested = [c for c in a.calls if c[0] == "ingest"]
    assert len(ingested) == 3  # 3 user messages, the assistant one is skipped
    # setup must come before any ingest, flush between ingest and search,
    # teardown last.
    phases = [c[0] for c in a.calls]
    assert phases.index("setup") < phases.index("ingest")
    assert phases.index("ingest") < phases.index("flush")
    assert phases.index("flush") < phases.index("search")
    assert phases[-1] == "teardown"
    assert result.total_questions == 3
    assert result.questions_answered == 2  # q1 + q2 hit, q3 has no overlap


def test_runner_emits_lifecycle_events():
    events: list[tuple[str, str]] = []
    a = _RecordingAdapter()
    run_system(a, _persona(), "u1", score_keyword,
               on_event=lambda phase, sys, _: events.append((phase, sys)))
    phases = [p for p, _ in events]
    assert phases[0] == "start"
    assert phases.count("question") == 3
    assert phases[-1] == "done"


# ── failure handling — adapter exceptions never crash the run ────────────────

def test_setup_failure_records_error_and_skips_ingest():
    a = _RecordingAdapter()
    a._fail_in = "setup"
    result = run_system(a, _persona(), "u1", score_keyword)
    assert "setup failed" in result.error
    assert result.total_questions == 0
    assert ("ingest", "s1", "Jordan lives in Austin, Texas.") not in a.calls


def test_ingest_failure_still_calls_teardown():
    a = _RecordingAdapter()
    a._fail_in = "ingest"
    result = run_system(a, _persona(), "u1", score_keyword)
    assert "ingest failed" in result.error
    assert ("teardown",) in a.calls


def test_run_all_returns_one_result_per_adapter():
    results = run_all([_RecordingAdapter(), _RecordingAdapter()], _persona(), "u1", score_keyword)
    assert len(results) == 2


# ── scoring rollups ─────────────────────────────────────────────────────────

def test_overall_score_and_category_score_match_question_results():
    a = _RecordingAdapter()
    result = run_system(a, _persona(), "u1", score_keyword)
    assert result.overall_score == pytest.approx(2 / 3)
    assert result.score_for_category("flat-recall") == (1, 2)   # q1 hit, q3 miss
    assert result.score_for_category("relational") == (1, 1)


