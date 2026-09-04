"""JudgeCache — persistence + scorer wrapping."""

from __future__ import annotations

from pathlib import Path

import pytest
from benchmark.judge_cache import JudgeCache, cached_scorer
from benchmark.schema import EvalQuestion


def _q(qid: str = "q1", *, answer: str = "Austin") -> EvalQuestion:
    return EvalQuestion(
        id=qid,
        question="Where?",
        keywords=["Austin"],
        category="flat-recall",
        answer=answer,
    )


# ── load / save ──────────────────────────────────────────────────────────────


def test_load_missing_path_returns_empty_cache(tmp_path: Path):
    cache = JudgeCache.load(tmp_path / "does_not_exist.json")
    assert len(cache) == 0
    assert cache.path == tmp_path / "does_not_exist.json"


def test_save_then_load_round_trips_entries(tmp_path: Path):
    cache = JudgeCache.load(tmp_path / "c.json")
    cache.put("modelA", _q(), "Jordan lives in Austin.", (True, "matches gold"))
    cache.put("modelA", _q(qid="q2"), "Unrelated.", (False, "no match"))
    cache.save()

    reloaded = JudgeCache.load(tmp_path / "c.json")
    assert len(reloaded) == 2
    assert reloaded.get("modelA", _q(), "Jordan lives in Austin.") == (
        True,
        "matches gold",
    )
    assert reloaded.get("modelA", _q(qid="q2"), "Unrelated.") == (False, "no match")


def test_save_is_atomic_and_does_not_leave_a_temp_file(tmp_path: Path):
    cache = JudgeCache.load(tmp_path / "c.json")
    cache.put("m", _q(), "ctx", (True, "ok"))
    cache.save()
    # The .tmp sibling must be cleaned up by os.replace.
    leftovers = [p.name for p in tmp_path.iterdir() if p.suffix == ".tmp"]
    assert leftovers == []


def test_corrupt_cache_file_loads_as_empty_rather_than_raising(tmp_path: Path):
    p = tmp_path / "c.json"
    p.write_text("not json {[")
    cache = JudgeCache.load(p)
    assert len(cache) == 0


def test_save_skips_when_no_path_is_set():
    cache = JudgeCache()  # no path
    cache.put("m", _q(), "ctx", (True, "ok"))
    cache.save()  # must not raise


# ── key invalidation ─────────────────────────────────────────────────────────


def test_changing_context_misses_the_cache():
    cache = JudgeCache()
    cache.put("m", _q(), "Jordan lives in Austin.", (True, "ok"))
    assert cache.get("m", _q(), "different context") is None


def test_changing_model_misses_the_cache():
    cache = JudgeCache()
    cache.put("modelA", _q(), "ctx", (True, "ok"))
    assert cache.get("modelB", _q(), "ctx") is None


def test_changing_gold_answer_invalidates_the_entry():
    cache = JudgeCache()
    cache.put("m", _q(answer="Austin"), "ctx", (True, "ok"))
    # The persona's answer changed — the prior verdict no longer applies.
    assert cache.get("m", _q(answer="Seattle"), "ctx") is None


def test_changing_keywords_alone_when_no_gold_answer_invalidates():
    # When ``answer`` is empty, the cache key folds in the keywords as a stand-in.
    q1 = EvalQuestion(id="q", question="?", keywords=["foo"], category="c", answer="")
    q2 = EvalQuestion(id="q", question="?", keywords=["bar"], category="c", answer="")
    cache = JudgeCache()
    cache.put("m", q1, "ctx", (True, ""))
    assert cache.get("m", q2, "ctx") is None


# ── cached_scorer wrapper ────────────────────────────────────────────────────


def test_cached_scorer_calls_inner_on_first_miss_and_caches_for_next_call():
    calls = {"n": 0}

    def inner(q, ctx):
        calls["n"] += 1
        return (True, "verdict")

    cache = JudgeCache()
    scorer = cached_scorer(inner, cache, model="m")
    assert scorer(_q(), "ctx") == (True, "verdict")
    assert scorer(_q(), "ctx") == (True, "verdict")
    assert calls["n"] == 1
    assert cache.hits == 1 and cache.misses == 1
    assert len(cache) == 1


def test_cached_scorer_is_per_context():
    calls: list[str] = []

    def inner(q, ctx):
        calls.append(ctx)
        return (False, "")

    cache = JudgeCache()
    scorer = cached_scorer(inner, cache, model="m")
    scorer(_q(), "ctx-A")
    scorer(_q(), "ctx-B")
    scorer(_q(), "ctx-A")  # cached
    assert calls == ["ctx-A", "ctx-B"]
    assert cache.hits == 1 and cache.misses == 2


def test_cached_scorer_persists_verdicts_across_a_save_load_cycle(tmp_path: Path):
    inner_calls = {"n": 0}

    def inner(q, ctx):
        inner_calls["n"] += 1
        return (True, "from-llm")

    # Run 1: populates the cache.
    cache = JudgeCache.load(tmp_path / "c.json")
    scorer = cached_scorer(inner, cache, model="m")
    scorer(_q(), "ctx")
    cache.save()

    # Run 2: a fresh process loads the cache; the LLM is not called again.
    def boom(_q, _c):
        raise AssertionError("inner scorer must not be called on a cached hit")

    cache2 = JudgeCache.load(tmp_path / "c.json")
    scorer2 = cached_scorer(boom, cache2, model="m")
    assert scorer2(_q(), "ctx") == (True, "from-llm")
    assert cache2.hits == 1


def test_cached_scorer_persists_negative_verdicts_too(tmp_path: Path):
    cache = JudgeCache.load(tmp_path / "c.json")
    scorer = cached_scorer(lambda _q, _c: (False, "no match"), cache, model="m")
    scorer(_q(), "ctx")
    cache.save()

    cache2 = JudgeCache.load(tmp_path / "c.json")
    scorer2 = cached_scorer(
        lambda _q, _c: pytest.fail("should not run"), cache2, model="m"
    )
    assert scorer2(_q(), "ctx") == (False, "no match")
