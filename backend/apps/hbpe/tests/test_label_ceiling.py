"""
The chat labeler's request ceiling.

What matters: consecutive requests are spaced by ``60 / max_per_minute``
seconds, the first request never waits, a caller that arrives after the gap
has already passed never waits, the ceiling is off at 0, and the HTTP labeler
consults it on the request path — after the yield, before the request.
"""

from __future__ import annotations

import io
import urllib.request

import pytest

from ci.hbpe import label_ceiling
from ci.hbpe.inference import qwen


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture(autouse=True)
def _fresh_ceiling(monkeypatch):
    label_ceiling.reset_for_tests()
    monkeypatch.setattr(
        label_ceiling.settings, "label_max_requests_per_minute", 6.0, raising=False
    )
    yield
    label_ceiling.reset_for_tests()


def test_first_request_goes_immediately():
    clock = _Clock()

    assert label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep) == 0.0
    assert clock.sleeps == []


def test_back_to_back_requests_are_spaced_to_the_gap():
    clock = _Clock()

    label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep)
    clock.now += 3.0  # a 3 s generation
    waited = label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep)

    # 6 per minute is one every 10 s; 3 s have passed, so 7 s of waiting.
    assert waited == pytest.approx(7.0)
    assert clock.now == pytest.approx(10.0)


def test_a_request_after_the_gap_has_passed_does_not_wait():
    clock = _Clock()

    label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep)
    clock.now += 45.0

    assert label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep) == 0.0


def test_the_gap_is_measured_from_request_start_not_completion():
    """Even spacing, not 'gap after each finishes': a long generation eats into the gap."""
    clock = _Clock()

    label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep)
    clock.now += 12.0  # a generation longer than the gap

    assert label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep) == 0.0


def test_explicit_limit_overrides_settings():
    clock = _Clock()

    label_ceiling.wait_for_request_slot(
        max_per_minute=30, clock=clock, sleep=clock.sleep
    )
    waited = label_ceiling.wait_for_request_slot(
        max_per_minute=30, clock=clock, sleep=clock.sleep
    )

    assert waited == pytest.approx(2.0)


def test_zero_disables_the_ceiling(monkeypatch):
    monkeypatch.setattr(
        label_ceiling.settings, "label_max_requests_per_minute", 0, raising=False
    )
    clock = _Clock()

    for _ in range(5):
        assert (
            label_ceiling.wait_for_request_slot(clock=clock, sleep=clock.sleep) == 0.0
        )

    assert label_ceiling.minimum_gap_seconds() == 0.0


def test_the_chat_labeler_waits_for_a_slot_after_yielding_before_each_request(
    monkeypatch,
):
    order: list[str] = []

    monkeypatch.setattr(qwen, "wait_for_chat_idle", lambda: order.append("yield"))
    monkeypatch.setattr(qwen, "wait_for_request_slot", lambda: order.append("slot"))
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
    labeler.batch_generate([("first", None), ("second", None)], max_new_tokens=16)

    assert order == ["yield", "slot", "request", "yield", "slot", "request"]
