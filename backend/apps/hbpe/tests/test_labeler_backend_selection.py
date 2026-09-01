"""
Which labeler backend gets built, and what happens when the configured one is
not there.

The bug these cover: `_build_labeler` used to hand back an `OpenAIChatLabeler`
for any non-empty (base, model) pair without ever checking that something was
listening. The singleton is built once per process, so an unreachable endpoint
meant every `label_event` for the life of the service raised URLError — the
nightly drain burned its whole multi-hour budget writing nothing, and the
forecast could never fill, while a perfectly good GGUF labeler sat unused.
"""

from __future__ import annotations

import urllib.error

import pytest

from ci.hbpe.inference import qwen


class _FakeGGUF:
    """Stands in for QwenModel so no real model file is needed."""

    def __init__(self, path: str = "") -> None:
        self.path = path


@pytest.fixture(autouse=True)
def _no_real_gguf(monkeypatch):
    monkeypatch.setattr(qwen, "QwenModel", _FakeGGUF)
    monkeypatch.setattr(qwen, "_resolve_model_path", lambda: "/nonexistent.gguf")


def _configure(monkeypatch, *, base: str, model: str, key: str = "") -> None:
    monkeypatch.setattr(qwen.settings, "label_api_base", base, raising=False)
    monkeypatch.setattr(qwen.settings, "label_chat_model", model, raising=False)
    monkeypatch.setattr(qwen.settings, "label_api_key", key, raising=False)
    monkeypatch.setattr(qwen.settings, "label_http_timeout_seconds", 1.0, raising=False)


def test_uses_the_chat_api_when_the_endpoint_answers(monkeypatch):
    monkeypatch.setattr(qwen, "_endpoint_reachable", lambda base, timeout: True)
    _configure(monkeypatch, base="http://llm:8000/v1", model="qwen3-8b")

    labeler = qwen._build_labeler()

    assert isinstance(labeler, qwen.OpenAIChatLabeler)


def test_falls_back_to_gguf_when_the_endpoint_is_unreachable(monkeypatch, caplog):
    """The actual regression: a wrong host must degrade, not kill labeling."""
    monkeypatch.setattr(qwen, "_endpoint_reachable", lambda base, timeout: False)
    _configure(monkeypatch, base="http://localhost:11434/v1", model="gemma4:31b")

    with caplog.at_level("ERROR"):
        labeler = qwen._build_labeler()

    assert isinstance(labeler, _FakeGGUF)
    # The operator has to be able to find this: a silent downgrade to a slower
    # labeler is its own trap.
    assert "unreachable" in caplog.text
    assert "host.docker.internal" in caplog.text


def test_still_falls_back_when_the_model_is_unset(monkeypatch):
    """Pre-existing behaviour, pinned so the new branch does not swallow it."""
    monkeypatch.setattr(qwen, "_endpoint_reachable", lambda base, timeout: True)
    _configure(monkeypatch, base="http://llm:8000/v1", model="")

    assert isinstance(qwen._build_labeler(), _FakeGGUF)


def test_no_endpoint_configured_uses_gguf_without_probing(monkeypatch):
    def _boom(base, timeout):  # pragma: no cover - must never run
        raise AssertionError("must not probe when no base is configured")

    monkeypatch.setattr(qwen, "_endpoint_reachable", _boom)
    _configure(monkeypatch, base="", model="qwen3-8b")

    assert isinstance(qwen._build_labeler(), _FakeGGUF)


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_probe_counts_an_http_error_as_reachable(monkeypatch):
    """A 401/404 means a server answered — that is reachable enough."""

    def _raise(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(qwen.urllib.request, "urlopen", _raise)

    assert qwen._endpoint_reachable("http://llm:8000/v1", 1.0) is True


def test_probe_counts_connection_refused_as_unreachable(monkeypatch):
    def _raise(req, timeout):
        raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))

    monkeypatch.setattr(qwen.urllib.request, "urlopen", _raise)

    assert qwen._endpoint_reachable("http://localhost:11434/v1", 1.0) is False


def test_probe_asks_the_models_route_of_the_configured_base(monkeypatch):
    seen: list[str] = []

    def _capture(req, timeout):
        seen.append(req.full_url)
        return _Resp()

    monkeypatch.setattr(qwen.urllib.request, "urlopen", _capture)

    # Trailing slash must not produce a doubled separator.
    assert qwen._endpoint_reachable("http://llm:8000/v1/", 1.0) is True
    assert seen == ["http://llm:8000/v1/models"]
