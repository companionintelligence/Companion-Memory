"""run_system_repeated — N-run lifecycle and aggregation invariants."""

from __future__ import annotations

from typing import List

import pytest

from benchmark.adapters.base import MemoryAdapter
from benchmark.runner import run_system, run_system_repeated
from benchmark.scoring import score_keyword


def _persona() -> dict:
    return {
        "persona_id": "p1",
        "name": "Test",
        "sessions": [
            {"id": "s1", "messages": [
                {"role": "user", "content": "Jordan lives in Austin, Texas."},
                {"role": "user", "content": "Loves climbing."},
            ]},
        ],
        "eval_questions": [
            {"id": "q1", "question": "Jordan lives where?",
             "keywords": ["Austin"], "category": "flat-recall"},
            {"id": "q2", "question": "submarine trivia please",
             "keywords": ["never-matches"], "category": "flat-recall"},
        ],
    }


class _RecAdapter(MemoryAdapter):
    """Counts every lifecycle invocation so tests can assert N×."""

    def __init__(self) -> None:
        self.setup_count = 0
        self.teardown_count = 0
        self.ingest_count = 0
        self.flush_count = 0
        self._store: List[str] = []
        self.fail_run: int | None = None  # which run-index to fail in
        self._current_run = -1

    @property
    def name(self) -> str:
        return "rec"

    def setup(self, user_id: str) -> None:
        self.setup_count += 1
        self._current_run += 1
        if self.fail_run == self._current_run:
            raise RuntimeError("setup boom")
        self._store = []

    def ingest(self, text: str, session_id: str) -> None:
        self.ingest_count += 1
        self._store.append(text)

    def flush(self) -> None:
        self.flush_count += 1

    def search(self, query: str) -> str:
        return "\n".join(t for t in self._store if any(w.lower() in t.lower() for w in query.split()))

    def teardown(self) -> None:
        self.teardown_count += 1


def test_runs_1_matches_run_system_shape():
    a1 = _RecAdapter()
    a2 = _RecAdapter()
    single = run_system(a1, _persona(), "u", score_keyword)
    repeated = run_system_repeated(a2, _persona(), "u", score_keyword, runs=1)
    assert len(repeated) == 1
    # Same scoring outcome → same counts (counts are deterministic for stub).
    assert single.questions_answered == repeated[0].questions_answered
    assert single.total_questions == repeated[0].total_questions


def test_runs_n_calls_setup_and_teardown_n_times():
    a = _RecAdapter()
    n = 4
    out = run_system_repeated(a, _persona(), "u", score_keyword, runs=n)
    assert len(out) == n
    assert a.setup_count == n
    assert a.teardown_count == n
    assert a.flush_count == n
    # Two user messages × n runs.
    assert a.ingest_count == 2 * n


def test_runs_n_returns_one_result_per_run():
    a = _RecAdapter()
    out = run_system_repeated(a, _persona(), "u", score_keyword, runs=3)
    assert len(out) == 3
    for r in out:
        assert r.system_name == "rec"
        assert r.total_questions == 2


def test_failure_in_one_run_does_not_kill_aggregation():
    a = _RecAdapter()
    a.fail_run = 1  # fail the second run only
    out = run_system_repeated(a, _persona(), "u", score_keyword, runs=3)
    assert len(out) == 3
    # Successful runs have no error; failed one carries an error string.
    assert out[0].error == ""
    assert "setup failed" in out[1].error
    assert out[2].error == ""


def test_runs_zero_raises():
    a = _RecAdapter()
    with pytest.raises(ValueError):
        run_system_repeated(a, _persona(), "u", score_keyword, runs=0)


def test_listener_receives_run_index():
    a = _RecAdapter()
    events: list[tuple[str, int]] = []

    def listen(phase: str, system: str, payload: dict) -> None:
        events.append((phase, payload.get("run_index", -1)))

    run_system_repeated(a, _persona(), "u", score_keyword, runs=2, on_event=listen)
    indices = {idx for phase, idx in events if phase == "start"}
    assert indices == {0, 1}
