"""run_system_repeated — N-run lifecycle, independence, and error isolation."""

from __future__ import annotations

import pytest
from benchmark.adapters.base import MemoryAdapter
from benchmark.runner import run_system, run_system_repeated
from benchmark.scoring import score_keyword


def _persona() -> dict:
    return {
        "persona_id": "p1",
        "name": "Test",
        "sessions": [
            {
                "id": "s1",
                "messages": [
                    {"role": "user", "content": "Jordan lives in Austin, Texas."},
                    {"role": "user", "content": "Loves climbing."},
                ],
            },
        ],
        "eval_questions": [
            {
                "id": "q1",
                "question": "Jordan lives where?",
                "keywords": ["Austin"],
                "category": "flat-recall",
            },
            {
                "id": "q2",
                "question": "submarine trivia please",
                "keywords": ["never-matches"],
                "category": "flat-recall",
            },
        ],
    }


class _RecAdapter(MemoryAdapter):
    """Counts every lifecycle invocation so tests can assert N×."""

    def __init__(self) -> None:
        self.setup_count = 0
        self.teardown_count = 0
        self.ingest_count = 0
        self.flush_count = 0
        self.user_ids: list[str] = []
        self._store: list[str] = []
        self.fail_on_setup = False

    @property
    def name(self) -> str:
        return "rec"

    def setup(self, user_id: str) -> None:
        self.setup_count += 1
        self.user_ids.append(user_id)
        if self.fail_on_setup:
            raise RuntimeError("setup boom")
        self._store = []

    def ingest(self, text: str, session_id: str) -> None:
        self.ingest_count += 1
        self._store.append(text)

    def flush(self) -> None:
        self.flush_count += 1

    def search(self, query: str) -> str:
        return "\n".join(
            t for t in self._store if any(w.lower() in t.lower() for w in query.split())
        )

    def teardown(self) -> None:
        self.teardown_count += 1


class _Factory:
    """Adapter factory that keeps every instance it minted."""

    def __init__(self, fail_runs: tuple[int, ...] = ()) -> None:
        self.made: list[_RecAdapter] = []
        self._fail_runs = fail_runs

    def __call__(self) -> _RecAdapter:
        a = _RecAdapter()
        a.fail_on_setup = len(self.made) in self._fail_runs
        self.made.append(a)
        return a


def test_runs_1_matches_run_system_shape():
    single = run_system(_RecAdapter(), _persona(), "u", score_keyword)
    repeated = run_system_repeated(_Factory(), _persona(), "u", score_keyword, runs=1)
    assert len(repeated) == 1
    assert single.questions_answered == repeated[0].questions_answered
    assert single.total_questions == repeated[0].total_questions


def test_runs_n_calls_setup_and_teardown_once_per_run():
    f = _Factory()
    n = 4
    out = run_system_repeated(f, _persona(), "u", score_keyword, runs=n)
    assert len(out) == n
    assert len(f.made) == n
    for a in f.made:
        assert a.setup_count == 1
        assert a.teardown_count == 1
        assert a.flush_count == 1
        assert a.ingest_count == 2  # two user messages


def test_each_run_gets_its_own_adapter_instance():
    f = _Factory()
    run_system_repeated(f, _persona(), "u", score_keyword, runs=3)
    # A repeated run against one instance carries caches and accumulated
    # per-adapter state between runs, so the runs are not independent.
    assert len({id(a) for a in f.made}) == 3


def test_each_run_gets_its_own_user_id():
    f = _Factory()
    run_system_repeated(f, _persona(), "benchmark_user", score_keyword, runs=3)
    seen = [uid for a in f.made for uid in a.user_ids]
    assert len(seen) == 3
    assert len(set(seen)) == 3, "runs must not share per-user state"
    assert all(uid.startswith("benchmark_user") for uid in seen)


def test_state_does_not_leak_between_runs():
    """An adapter that never clears its store must still see a clean run 2."""

    class _Leaky(_RecAdapter):
        def setup(self, user_id: str) -> None:
            self.setup_count += 1
            self.user_ids.append(user_id)
            # Deliberately does NOT reset self._store.

    made: list[_Leaky] = []

    def factory() -> _Leaky:
        a = _Leaky()
        made.append(a)
        return a

    out = run_system_repeated(factory, _persona(), "u", score_keyword, runs=2)
    assert len(out) == 2
    for a in made:
        assert a.ingest_count == 2


def test_runs_n_returns_one_result_per_run():
    out = run_system_repeated(_Factory(), _persona(), "u", score_keyword, runs=3)
    assert len(out) == 3
    for r in out:
        assert r.system_name == "rec"
        assert r.total_questions == 2


def test_failure_in_one_run_does_not_kill_aggregation():
    f = _Factory(fail_runs=(1,))
    out = run_system_repeated(f, _persona(), "u", score_keyword, runs=3)
    assert len(out) == 3
    assert out[0].error == ""
    assert "setup failed" in out[1].error
    assert out[2].error == ""


def test_a_factory_that_raises_is_recorded_as_a_failed_run():
    calls = {"n": 0}

    def factory() -> MemoryAdapter:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("cannot construct")
        return _RecAdapter()

    out = run_system_repeated(factory, _persona(), "u", score_keyword, runs=3)
    assert len(out) == 3
    assert out[0].error == ""
    assert "cannot construct" in out[1].error
    assert out[2].error == ""


def test_runs_zero_raises():
    with pytest.raises(ValueError):
        run_system_repeated(_Factory(), _persona(), "u", score_keyword, runs=0)


def test_listener_receives_run_index():
    events: list[tuple[str, int]] = []

    def listen(phase: str, system: str, payload: dict) -> None:
        events.append((phase, payload.get("run_index", -1)))

    run_system_repeated(
        _Factory(), _persona(), "u", score_keyword, runs=2, on_event=listen
    )
    indices = {idx for phase, idx in events if phase == "start"}
    assert indices == {0, 1}
