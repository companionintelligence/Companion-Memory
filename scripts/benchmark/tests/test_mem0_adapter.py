"""Mem0Adapter — drives the lifecycle through stubbed mem0 + embedding seams.

We never import the real ``mem0`` package, so the test runs in any environment.
A :class:`FakeMemory` plays the role of ``mem0.Memory.from_config(...)``: it
records ``add`` / ``search`` calls and returns scripted results.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from typing import Any

import pytest
from benchmark.adapters.mem0 import Mem0Adapter, _cosine


class FakeMemory:
    """Stand-in for ``mem0.Memory`` that captures calls + returns scripted results."""

    def __init__(self) -> None:
        self.adds: list[tuple[str, str, dict]] = []  # (text, user_id, metadata)
        self.searches: list[tuple[str, int, dict]] = []  # (query, top_k, filters)
        # ``script`` is consulted in FIFO order on search(); a dict means the
        # raw Mem0-style response, a list is the convenience "just the memories".
        self.script: list[Any] = []

    def add(self, text: str, user_id: str, metadata: dict | None = None) -> None:
        self.adds.append((text, user_id, dict(metadata or {})))

    def search(self, query: str, top_k: int, filters: dict | None = None) -> Any:
        self.searches.append((query, top_k, dict(filters or {})))
        if not self.script:
            return {"results": []}
        return self.script.pop(0)


# ── lifecycle wiring ─────────────────────────────────────────────────────────


def test_setup_builds_config_with_user_namespaced_collection():
    seen: dict = {}

    def factory(cfg):
        seen["cfg"] = cfg
        return FakeMemory()

    a = Mem0Adapter(memory_factory=factory, embed_fn=lambda _t: [])
    a.setup("user-42")
    assert (
        seen["cfg"]["vector_store"]["config"]["collection_name"] == "benchmark_user-42"
    )
    # LLM defaults to local Ollama unless MEM0_LLM_BASE_URL points elsewhere.
    assert seen["cfg"]["llm"]["provider"] == "ollama"
    assert seen["cfg"]["embedder"]["provider"] == "ollama"


def test_setup_routes_llm_to_openai_compat_when_base_url_set(monkeypatch):
    monkeypatch.setenv("MEM0_LLM_BASE_URL", "http://lm-studio:1234")
    seen: dict = {}
    a = Mem0Adapter(
        memory_factory=lambda c: seen.setdefault("cfg", c) or FakeMemory(),
        embed_fn=lambda _t: [],
    )
    a.setup("u")
    assert seen["cfg"]["llm"]["provider"] == "openai"
    assert seen["cfg"]["llm"]["config"]["openai_base_url"] == "http://lm-studio:1234"


# ── ingest ───────────────────────────────────────────────────────────────────


def test_ingest_passes_text_user_and_session_metadata():
    fake = FakeMemory()
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=lambda _t: [])
    a.setup("u1")
    a.ingest("Jordan lives in Austin.", session_id="sess_1")
    assert fake.adds == [("Jordan lives in Austin.", "u1", {"session_id": "sess_1"})]


def test_ingest_before_setup_raises():
    a = Mem0Adapter(memory_factory=lambda _c: FakeMemory(), embed_fn=lambda _t: [])
    with pytest.raises(RuntimeError):
        a.ingest("text", "s1")


# ── search ───────────────────────────────────────────────────────────────────


def _vec_for(text: str) -> list[float]:
    """Cheap, deterministic embedding for tests: counts a few keyword markers."""
    return [
        text.lower().count("austin"),
        text.lower().count("mango"),
        text.lower().count("climbing"),
    ]


def test_search_calls_mem0_with_top_k_huge_and_user_filter():
    fake = FakeMemory()
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=_vec_for)
    a.setup("u1")
    a.search("where?")
    q, top_k, filters = fake.searches[0]
    assert q == "where?"
    assert top_k == 10000  # defeats Mem0's wrong-end truncation
    assert filters == {"user_id": "u1"}


def test_search_returns_empty_string_when_mem0_finds_nothing():
    fake = FakeMemory()
    fake.script = [{"results": []}]
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=_vec_for)
    a.setup("u1")
    assert a.search("anything") == ""


def test_search_reranks_with_cosine_using_the_injected_embedder():
    # Mem0 returns 3 memories in arbitrary (broken) order; the re-rank should
    # put the Austin one first when the query embeds as the Austin axis.
    fake = FakeMemory()
    fake.script = [
        {
            "results": [
                {"memory": "Adopted a dog named Mango."},
                {"memory": "Loves climbing on weekends."},
                {"memory": "Jordan lives in Austin, Texas."},
            ]
        }
    ]
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=_vec_for)
    a.setup("u")
    out = a.search("Where does Jordan live? Austin?")
    # Top of the joined result is the Austin memory.
    assert out.split("\n\n")[0] == "Jordan lives in Austin, Texas."


def test_search_falls_back_to_mem0_order_when_embedder_returns_empty_vector():
    fake = FakeMemory()
    fake.script = [
        {
            "results": [
                {"memory": "first"},
                {"memory": "second"},
            ]
        }
    ]
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=lambda _t: [])  # always []
    a.setup("u")
    out = a.search("q")
    assert out.split("\n\n") == ["first", "second"]


def test_search_handles_results_returned_as_bare_list():
    # Older mem0 versions returned a list rather than {"results": [...]}.
    fake = FakeMemory()
    fake.script = [[{"memory": "X"}, {"memory": "Y"}]]
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=lambda _t: [])
    a.setup("u")
    assert a.search("q") == "X\n\nY"


def test_embed_cache_collapses_repeat_lookups():
    calls = {"n": 0}

    def counting_embed(text: str) -> list[float]:
        calls["n"] += 1
        return [1.0, 0.0, 0.0]

    fake = FakeMemory()
    fake.script = [{"results": [{"memory": "X"}, {"memory": "X"}]}]
    a = Mem0Adapter(memory_factory=lambda _c: fake, embed_fn=counting_embed)
    a.setup("u")
    a.search("q")
    # query (1) + the unique memory text (1) = 2; the dup must hit the cache.
    assert calls["n"] == 2


# ── teardown ─────────────────────────────────────────────────────────────────


def test_teardown_removes_chroma_dir():
    tmp = tempfile.mkdtemp(prefix="bench-mem0-")
    try:
        a = Mem0Adapter(
            chroma_path=tmp,
            memory_factory=lambda _c: FakeMemory(),
            embed_fn=lambda _t: [],
        )
        a.setup("u")
        assert os.path.isdir(tmp)
        a.teardown()
        assert not os.path.isdir(tmp)
    finally:
        # Defensive — teardown should already have cleaned this up.
        shutil.rmtree(tmp, ignore_errors=True)


def test_teardown_when_chroma_dir_does_not_exist_is_a_noop():
    a = Mem0Adapter(
        chroma_path="/does/not/exist",
        memory_factory=lambda _c: FakeMemory(),
        embed_fn=lambda _t: [],
    )
    a.setup("u")
    a.teardown()  # must not raise


# ── cosine math ──────────────────────────────────────────────────────────────


def test_cosine_helper_basic_cases():
    assert _cosine([1, 0], [1, 0]) == pytest.approx(1.0)
    assert _cosine([1, 0], [0, 1]) == pytest.approx(0.0)
    assert _cosine([], [1, 1]) == 0.0
    assert _cosine([0, 0], [1, 1]) == 0.0  # zero-norm guard
