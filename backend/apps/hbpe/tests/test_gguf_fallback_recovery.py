"""
The GGUF fallback must not become a permanent GPU tenant.

Background (2026-09-10/11): with the chat endpoint unreachable from the
container, HBPE loaded the GGUF labeler on the GPU next to Ollama and held it
for the life of the process. llama.cpp's HIP scratch pool keeps every
distinct-size buffer it ever hands out, and labeling prompts differ per event,
so VRAM grew ~0.5 MiB per completion — 4.4 GiB after a day — starving the
inference server it was standing in for. Three guards, each pinned here:

  1. prompts are fed in small fixed chunks (bounds the pool's size variety);
  2. the llama.cpp context is rebuilt every N completions (empties the pool);
  3. get_qwen() re-probes the endpoint on an interval and switches back,
     closing the GGUF, so a transient outage does not pin the GPU for hours.
"""

from __future__ import annotations

import sys
import types
from typing import ClassVar

import pytest

from ci.hbpe.inference import qwen

# ── A fake llama_cpp so no model file or GPU is needed ───────────────────────


class _FakeLlama:
    instances: ClassVar[list[_FakeLlama]] = []
    events: ClassVar[list[str]] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.closed = False
        self.calls = 0
        _FakeLlama.instances.append(self)
        _FakeLlama.events.append(f"load#{len(_FakeLlama.instances)}")

    def create_chat_completion(self, **kwargs) -> dict:
        assert not self.closed, "generate on a closed context"
        self.calls += 1
        return {"choices": [{"message": {"content": '{"l0": "WORK"}'}}]}

    def close(self) -> None:
        self.closed = True
        _FakeLlama.events.append(f"close#{_FakeLlama.instances.index(self) + 1}")


@pytest.fixture(autouse=True)
def _fake_llama_cpp(monkeypatch):
    _FakeLlama.instances = []
    _FakeLlama.events = []
    module = types.ModuleType("llama_cpp")
    module.Llama = _FakeLlama  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "llama_cpp", module)
    monkeypatch.setattr(qwen.settings, "qwen_gguf_batch", 64, raising=False)
    monkeypatch.setattr(qwen.settings, "qwen_gguf_recycle_calls", 0, raising=False)
    monkeypatch.setattr(qwen.settings, "qwen_disable_thinking", True, raising=False)
    qwen.reset_qwen_for_tests()
    yield
    qwen.reset_qwen_for_tests()


# ── 1. fixed small batches ────────────────────────────────────────────────────


def test_gguf_is_loaded_with_small_fixed_prompt_chunks(monkeypatch):
    monkeypatch.setattr(qwen.settings, "qwen_gguf_batch", 64, raising=False)

    qwen.QwenModel("/fake.gguf")

    kwargs = _FakeLlama.instances[0].kwargs
    assert kwargs["n_batch"] == 64
    assert kwargs["n_ubatch"] == 64
    assert kwargs["model_path"] == "/fake.gguf"


# ── 2. periodic recycle ───────────────────────────────────────────────────────


def test_context_is_rebuilt_every_n_completions(monkeypatch):
    monkeypatch.setattr(qwen.settings, "qwen_gguf_recycle_calls", 3, raising=False)
    model = qwen.QwenModel("/fake.gguf")

    for _ in range(7):
        assert model.generate("Event: lunch") == '{"l0": "WORK"}'

    # Calls 1-3 on the first context; the 4th triggers a rebuild, then 4-6 on
    # the second, and the 7th triggers another. Three contexts, two retired.
    assert [i.calls for i in _FakeLlama.instances] == [3, 3, 1]
    assert [i.closed for i in _FakeLlama.instances] == [True, True, False]


def test_recycle_releases_the_old_context_before_loading_the_new_one(monkeypatch):
    """On a full card the reverse order cannot load at all."""
    monkeypatch.setattr(qwen.settings, "qwen_gguf_recycle_calls", 1, raising=False)
    model = qwen.QwenModel("/fake.gguf")

    model.generate("a")
    model.generate("b")

    assert _FakeLlama.events == ["load#1", "close#1", "load#2"]


def test_recycle_disabled_by_zero(monkeypatch):
    monkeypatch.setattr(qwen.settings, "qwen_gguf_recycle_calls", 0, raising=False)
    model = qwen.QwenModel("/fake.gguf")

    for _ in range(5):
        model.generate("x")

    assert len(_FakeLlama.instances) == 1


def test_a_failed_reload_is_retried_on_the_next_call(monkeypatch):
    monkeypatch.setattr(qwen.settings, "qwen_gguf_recycle_calls", 1, raising=False)
    model = qwen.QwenModel("/fake.gguf")
    model.generate("a")

    boom = {"armed": True}
    real_load = model._load

    def _flaky_load():
        if boom["armed"]:
            boom["armed"] = False
            raise ValueError("Failed to load model from file")
        return real_load()

    monkeypatch.setattr(model, "_load", _flaky_load)

    with pytest.raises(ValueError):
        model.generate("b")  # old context already released, reload failed
    assert model._llm is None

    assert model.generate("c") == '{"l0": "WORK"}'  # reloaded, not dead
    assert len(_FakeLlama.instances) == 2


def test_close_makes_further_generation_fail_loudly():
    model = qwen.QwenModel("/fake.gguf")
    model.close()

    assert _FakeLlama.instances[0].closed
    with pytest.raises(RuntimeError):
        model.generate("x")


# ── 3. switch back to the chat endpoint ───────────────────────────────────────


def _configure(monkeypatch, *, base: str, model: str) -> None:
    monkeypatch.setattr(qwen.settings, "label_api_base", base, raising=False)
    monkeypatch.setattr(qwen.settings, "label_chat_model", model, raising=False)
    monkeypatch.setattr(qwen.settings, "label_api_key", "", raising=False)
    monkeypatch.setattr(qwen.settings, "label_http_timeout_seconds", 1.0, raising=False)
    monkeypatch.setattr(
        qwen.settings, "label_endpoint_reprobe_seconds", 300.0, raising=False
    )
    monkeypatch.setattr(qwen, "_resolve_model_path", lambda: "/fake.gguf")


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr(qwen.time, "monotonic", c)
    return c


def test_switches_back_to_the_endpoint_once_it_answers(monkeypatch, clock, caplog):
    _configure(monkeypatch, base="http://host.docker.internal:11434/v1", model="q")
    answers = iter([False, True])
    probes: list[float] = []

    def _probe(base, timeout):
        probes.append(timeout)
        return next(answers)

    monkeypatch.setattr(qwen, "_endpoint_reachable", _probe)

    first = qwen.get_qwen()
    assert isinstance(first, qwen.QwenModel)
    assert qwen.get_qwen() is first  # no probe before the interval
    assert len(probes) == 1

    clock.now += 300.0
    with caplog.at_level("WARNING"):
        second = qwen.get_qwen()

    assert isinstance(second, qwen.OpenAIChatLabeler)
    assert len(probes) == 2
    # The re-probe is bounded by its own short timeout, not the label timeout.
    assert probes[1] <= qwen._REPROBE_TIMEOUT_SECONDS
    # The fallback released its GPU memory and stays released.
    assert _FakeLlama.instances[0].closed
    assert qwen.get_qwen() is second
    assert "reachable again" in caplog.text


def test_a_failed_reprobe_keeps_the_fallback_and_waits_a_full_interval(
    monkeypatch, clock
):
    _configure(monkeypatch, base="http://llm:8000/v1", model="q")
    probes: list[str] = []

    def _probe(base, timeout):
        probes.append(base)
        return False

    monkeypatch.setattr(qwen, "_endpoint_reachable", _probe)

    first = qwen.get_qwen()
    clock.now += 300.0
    assert qwen.get_qwen() is first
    assert len(probes) == 2
    clock.now += 10.0
    assert qwen.get_qwen() is first
    assert len(probes) == 2  # not again until another interval has elapsed
    assert not _FakeLlama.instances[0].closed


def test_no_reprobe_when_no_endpoint_is_configured(monkeypatch, clock):
    _configure(monkeypatch, base="", model="q")

    def _boom(base, timeout):  # pragma: no cover - must never run
        raise AssertionError("must not probe without a configured endpoint")

    monkeypatch.setattr(qwen, "_endpoint_reachable", _boom)

    first = qwen.get_qwen()
    clock.now += 10_000.0
    assert qwen.get_qwen() is first


def test_no_reprobe_when_the_interval_is_disabled(monkeypatch, clock):
    _configure(monkeypatch, base="http://llm:8000/v1", model="q")
    monkeypatch.setattr(
        qwen.settings, "label_endpoint_reprobe_seconds", 0, raising=False
    )
    answers = iter([False])
    monkeypatch.setattr(qwen, "_endpoint_reachable", lambda b, t: next(answers))

    first = qwen.get_qwen()
    clock.now += 10_000.0
    assert qwen.get_qwen() is first  # a second probe would exhaust the iterator


def test_chat_backend_is_never_reprobed(monkeypatch, clock):
    _configure(monkeypatch, base="http://llm:8000/v1", model="q")
    probes: list[str] = []

    def _probe(base, timeout):
        probes.append(base)
        return True

    monkeypatch.setattr(qwen, "_endpoint_reachable", _probe)

    first = qwen.get_qwen()
    assert isinstance(first, qwen.OpenAIChatLabeler)
    clock.now += 10_000.0
    assert qwen.get_qwen() is first
    assert len(probes) == 1
