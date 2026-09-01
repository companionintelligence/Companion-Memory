"""
HBPE's copy of the namespace-correcting resolver.

The full behavioural suite lives with the summary copy
(backend/apps/summary/tests/test_llm_host.py), which also asserts the two files
are byte-identical. What is tested here is the part that is HBPE's own: that the
labeler's endpoint is corrected before #2484's reachability probe judges it, so
a container holding `LLM_API_BASE=http://localhost:11434/v1` uses the chat model
on the host instead of quietly demoting itself to the 0.8B GGUF.
"""

from __future__ import annotations

from ci.hbpe import llm_host


def test_loopback_becomes_the_gateway_inside_a_container():
    url, note = llm_host.resolve_url(
        "http://localhost:11434/v1", in_container=True, resolves=lambda host: True
    )

    assert url == "http://host.docker.internal:11434/v1"
    assert note


def test_gateway_becomes_loopback_on_the_host():
    url, note = llm_host.resolve_url(
        "http://host.docker.internal:11434/v1",
        in_container=False,
        resolves=lambda host: False,
    )

    assert url == "http://localhost:11434/v1"
    assert note


def test_resolve_env_corrects_the_hbpe_specific_override(monkeypatch):
    """HBPE_LABEL_API_BASE wins over LLM_API_BASE in config.py; fix it too."""
    monkeypatch.setattr(llm_host, "running_in_container", lambda: True)
    monkeypatch.setattr(llm_host, "hostname_resolves", lambda host: True)
    env = {"HBPE_LABEL_API_BASE": "http://127.0.0.1:8000/v1"}

    llm_host.resolve_env(env)

    assert env["HBPE_LABEL_API_BASE"] == "http://host.docker.internal:8000/v1"


def test_a_corrected_endpoint_is_the_one_the_probe_sees(monkeypatch):
    """
    The whole point, end to end: with the URL corrected, #2484's probe finds a
    server and the chat labeler is chosen over the GGUF fallback.
    """
    from ci.hbpe.inference import qwen

    monkeypatch.setattr(llm_host, "running_in_container", lambda: True)
    monkeypatch.setattr(llm_host, "hostname_resolves", lambda host: True)
    env = {"LLM_API_BASE": "http://localhost:11434/v1"}
    llm_host.resolve_env(env)

    probed: list[str] = []

    def _reachable(base: str, timeout: float) -> bool:
        probed.append(base)
        return True

    monkeypatch.setattr(qwen, "_endpoint_reachable", _reachable)
    monkeypatch.setattr(qwen.settings, "label_api_base", env["LLM_API_BASE"])
    monkeypatch.setattr(qwen.settings, "label_chat_model", "gemma4:31b")
    monkeypatch.setattr(qwen.settings, "label_api_key", "ollama")

    labeler = qwen._build_labeler()

    assert isinstance(labeler, qwen.OpenAIChatLabeler)
    assert probed == ["http://host.docker.internal:11434/v1"]
