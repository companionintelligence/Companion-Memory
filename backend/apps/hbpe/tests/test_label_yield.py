"""
The chat labeler standing aside for an interactive chat turn.

What matters: it waits while ``ci.threads`` says a turn is queued or running,
resumes the moment that clears, gives up after the cap rather than parking the
nightly on a stale row, fails OPEN on a database error, and the HTTP labeler
actually consults it before every request.
"""

from __future__ import annotations

import io
import urllib.request

import pytest

from ci.hbpe import database as db
from ci.hbpe import label_yield
from ci.hbpe.inference import qwen


class _Cursor:
    def __init__(self, counts: list[int], executed: list[tuple]) -> None:
        self._counts = counts
        self._executed = executed

    def execute(self, sql: str, params: tuple) -> None:
        self._executed.append((sql, params))

    def fetchone(self) -> tuple[int]:
        # The last configured answer repeats, so a test can say "pending,
        # pending, then idle forever" without counting polls exactly.
        if len(self._counts) > 1:
            return (self._counts.pop(0),)
        return (self._counts[0],)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, counts: list[int], executed: list[tuple]) -> None:
        self._counts = counts
        self._executed = executed

    def cursor(self, **_kw):
        return _Cursor(self._counts, self._executed)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture(autouse=True)
def _yield_on(monkeypatch):
    monkeypatch.setattr(
        label_yield.settings, "label_yield_to_chat", True, raising=False
    )
    monkeypatch.setattr(
        label_yield.settings, "label_yield_max_seconds", 600.0, raising=False
    )
    monkeypatch.setattr(
        label_yield.settings, "label_yield_poll_seconds", 2.0, raising=False
    )


def _threads(monkeypatch, counts: list[int]) -> list[tuple]:
    executed: list[tuple] = []
    monkeypatch.setattr(db, "get_conn", lambda: _Conn(counts, executed))
    return executed


def test_does_not_wait_when_no_turn_is_pending(monkeypatch):
    executed = _threads(monkeypatch, [0])
    clock = _Clock()

    waited = label_yield.wait_for_chat_idle(clock=clock, sleep=clock.sleep)

    assert waited == 0.0
    assert len(executed) == 1
    # The read is bounded on updated_at by the API's llm-queue expiry, so a
    # `running` row left behind by a dead process cannot hold the labeler off.
    sql, params = executed[0]
    assert "generation_status IN ('queued', 'running')" in sql
    assert "updated_at >" in sql
    assert params == (label_yield.PENDING_GENERATION_FRESHNESS_SECONDS,)


def test_waits_until_the_turn_clears_then_resumes(monkeypatch):
    executed = _threads(monkeypatch, [1, 1, 1, 0])
    clock = _Clock()

    waited = label_yield.wait_for_chat_idle(clock=clock, sleep=clock.sleep)

    # Three polls found a turn pending, the fourth found it gone: three sleeps.
    assert waited == pytest.approx(6.0)
    assert len(executed) == 4


def test_gives_up_after_the_cap_rather_than_parking_the_nightly(monkeypatch):
    _threads(monkeypatch, [1])
    clock = _Clock()

    waited = label_yield.wait_for_chat_idle(
        max_wait_seconds=7.0, poll_seconds=2.0, clock=clock, sleep=clock.sleep
    )

    # Polls at t=0,2,4,6 all pending; at t=8 the cap has passed and it proceeds.
    assert waited == pytest.approx(8.0)


def test_fails_open_on_a_database_error(monkeypatch):
    def _boom():
        raise RuntimeError("connection reset")

    monkeypatch.setattr(db, "get_conn", _boom)
    clock = _Clock()

    waited = label_yield.wait_for_chat_idle(clock=clock, sleep=clock.sleep)

    assert waited == 0.0


def test_is_a_no_op_when_switched_off(monkeypatch):
    monkeypatch.setattr(
        label_yield.settings, "label_yield_to_chat", False, raising=False
    )
    executed = _threads(monkeypatch, [1])
    clock = _Clock()

    waited = label_yield.wait_for_chat_idle(clock=clock, sleep=clock.sleep)

    assert waited == 0.0
    assert executed == []


def test_the_chat_labeler_stands_aside_before_every_request(monkeypatch):
    """The gate is consulted on the request path itself, not only at batch start."""
    order: list[str] = []

    monkeypatch.setattr(qwen, "wait_for_chat_idle", lambda: order.append("yield"))
    monkeypatch.setattr(qwen.settings, "qwen_disable_thinking", False, raising=False)
    monkeypatch.setattr(qwen.settings, "label_http_timeout_seconds", 1.0, raising=False)

    class _Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def _urlopen(req, timeout):
        order.append("request")
        return _Response(
            b'{"choices": [{"message": {"content": "{\\"l0\\": \\"WORK\\"}"}}]}'
        )

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)

    labeler = qwen.OpenAIChatLabeler("http://ollama:11434/v1", "qwen3.6:27b")
    outputs = labeler.batch_generate(
        [("first", None), ("second", None)], max_new_tokens=16
    )

    assert outputs == ['{"l0": "WORK"}', '{"l0": "WORK"}']
    assert order == ["yield", "request", "yield", "request"]
