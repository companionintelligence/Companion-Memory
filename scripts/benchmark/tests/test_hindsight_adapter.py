"""HindsightAdapter — driven through a fake SDK client + injected sleep."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from benchmark.adapters.hindsight import HindsightAdapter, _results


@dataclass
class _Result:
    text: str


class FakeHindsight:
    """Stand-in for ``hindsight_client.Hindsight`` capturing every SDK call."""

    def __init__(self, *, scripted_recalls: list[Any] | None = None) -> None:
        self.retains: list[dict] = []
        self.recalls: list[dict] = []
        self.delete_bank_calls: list[str] = []
        self.close_called = False
        self._scripted = list(scripted_recalls or [])

    def retain(
        self, *, bank_id: str, content: str, document_id: str, retain_async: bool
    ) -> None:
        self.retains.append(
            {
                "bank_id": bank_id,
                "content": content,
                "document_id": document_id,
                "retain_async": retain_async,
            }
        )

    def recall(self, *, bank_id: str, query: str, max_tokens: int, budget: str) -> Any:
        self.recalls.append(
            {
                "bank_id": bank_id,
                "query": query,
                "max_tokens": max_tokens,
                "budget": budget,
            }
        )
        if self._scripted:
            return self._scripted.pop(0)
        return type("R", (), {"results": []})()

    def delete_bank(self, *, bank_id: str) -> None:
        self.delete_bank_calls.append(bank_id)

    def close(self) -> None:
        self.close_called = True


def _adapter(fake: FakeHindsight, *, bank_id: str = "test-bank") -> HindsightAdapter:
    return HindsightAdapter(
        client_factory=lambda _u, _t: fake,
        sleep=lambda _s: None,  # no real sleep — keeps the suite fast
        bank_id=bank_id,
    )


# ── lifecycle ────────────────────────────────────────────────────────────────


def test_setup_creates_a_client_with_base_url_and_timeout():
    seen: dict = {}
    a = HindsightAdapter(
        base_url="http://h:8888",
        timeout=42.0,
        client_factory=lambda u, t: (
            seen.setdefault("kwargs", (u, t)) or FakeHindsight()
        ),
        sleep=lambda _s: None,
        bank_id="b",
    )
    a.setup("u")
    assert seen["kwargs"] == ("http://h:8888", 42.0)


def test_bank_id_default_uses_user_id_and_a_random_suffix():
    a = HindsightAdapter(
        client_factory=lambda _u, _t: FakeHindsight(), sleep=lambda _s: None
    )
    a.setup("alice")
    assert a._bank.startswith("bench_alice_")
    assert len(a._bank) > len("bench_alice_")


def test_ingest_before_setup_raises():
    a = HindsightAdapter(
        client_factory=lambda _u, _t: FakeHindsight(),
        sleep=lambda _s: None,
        bank_id="b",
    )
    with pytest.raises(RuntimeError):
        a.ingest("text", "s")


# ── ingest ───────────────────────────────────────────────────────────────────


def test_ingest_retain_is_synchronous_and_carries_document_id():
    fake = FakeHindsight()
    a = _adapter(fake)
    a.setup("u")
    a.ingest("a fact", session_id="sess_1")
    assert fake.retains == [
        {
            "bank_id": "test-bank",
            "content": "a fact",
            "document_id": "sess_1",
            "retain_async": False,
        }
    ]


# ── flush poll loop ──────────────────────────────────────────────────────────


def _result_count_response(n: int) -> Any:
    return type("R", (), {"results": [_Result(text=f"r{i}") for i in range(n)]})()


def test_flush_returns_when_result_count_is_stable_for_two_rounds():
    # Counts: 0 → 0 (stable=1) → 1 (reset) → 1 (stable=1) → 1 (stable=2 ⇒ stop)
    fake = FakeHindsight(
        scripted_recalls=[
            _result_count_response(0),
            _result_count_response(0),  # stable=1
            _result_count_response(1),  # reset
            _result_count_response(1),  # stable=1
            _result_count_response(1),  # stable=2 — return
            _result_count_response(1),  # safety; should not be consumed
        ]
    )
    a = _adapter(fake)
    a.setup("u")
    a.flush()
    # First scripted call is consumed by the initial probe; we expect 5 of them.
    assert len(fake.recalls) == 5
    # Every probe uses the high budget and the canned query.
    for r in fake.recalls:
        assert r["query"] == "what do you know about the user"
        assert r["budget"] == "high"
        assert r["max_tokens"] == 4096


def test_flush_treats_recall_exceptions_as_no_change():
    class _Throws(FakeHindsight):
        def recall(self, **kw):
            self.recalls.append(kw)
            raise RuntimeError("temporary blip")

    fake = _Throws()
    sleeps: list[float] = []
    a = HindsightAdapter(
        client_factory=lambda _u, _t: fake,
        sleep=sleeps.append,
        bank_id="b",
    )
    a.setup("u")
    # With n always == last (-1) once the first throw lands, two stable rounds
    # close the loop without raising.
    a.flush()
    # And at least one sleep happened between probes.
    assert sleeps


# ── search ───────────────────────────────────────────────────────────────────


def test_search_passes_caller_budget_and_max_tokens_and_joins_text_chunks():
    fake = FakeHindsight(
        scripted_recalls=[type("R", (), {"results": [_Result("A"), _Result("B")]})()]
    )
    a = HindsightAdapter(
        budget="low",
        max_tokens=512,
        client_factory=lambda _u, _t: fake,
        sleep=lambda _s: None,
        bank_id="b",
    )
    a.setup("u")
    out = a.search("where?")
    assert out == "A\n\nB"
    assert fake.recalls[0]["query"] == "where?"
    assert fake.recalls[0]["budget"] == "low"
    assert fake.recalls[0]["max_tokens"] == 512


def test_search_handles_dict_shaped_response_and_dict_shaped_results():
    fake = FakeHindsight(scripted_recalls=[{"results": [{"text": "X"}, {"text": "Y"}]}])
    a = _adapter(fake)
    a.setup("u")
    assert a.search("q") == "X\n\nY"


def test_search_returns_empty_string_when_recall_has_no_results():
    fake = FakeHindsight(scripted_recalls=[type("R", (), {"results": []})()])
    a = _adapter(fake)
    a.setup("u")
    assert a.search("q") == ""


# ── teardown ─────────────────────────────────────────────────────────────────


def test_teardown_deletes_the_bank_and_closes_the_client():
    fake = FakeHindsight()
    a = _adapter(fake)
    a.setup("u")
    a.teardown()
    assert fake.delete_bank_calls == ["test-bank"]
    assert fake.close_called is True
    assert a._client is None


def test_teardown_tolerates_missing_sdk_methods():
    class _Minimal:
        pass

    a = HindsightAdapter(
        client_factory=lambda _u, _t: _Minimal(), sleep=lambda _s: None, bank_id="b"
    )
    a.setup("u")
    a.teardown()  # must not raise


def test_teardown_swallows_exceptions_from_delete_bank():
    class _Boom(FakeHindsight):
        def delete_bank(self, *, bank_id: str) -> None:
            raise RuntimeError("server down")

    fake = _Boom()
    a = _adapter(fake)
    a.setup("u")
    a.teardown()
    assert fake.close_called is True  # close still attempted


def test_teardown_before_setup_is_a_noop():
    a = HindsightAdapter(
        client_factory=lambda _u, _t: FakeHindsight(),
        sleep=lambda _s: None,
        bank_id="b",
    )
    a.teardown()  # must not raise


# ── helpers ──────────────────────────────────────────────────────────────────


def test_results_helper_handles_attr_dict_and_none_shapes():
    assert _results(type("R", (), {"results": [1, 2]})()) == [1, 2]
    assert _results({"results": [3, 4]}) == [3, 4]
    assert _results(None) == []
    assert _results(type("R", (), {})()) == []
