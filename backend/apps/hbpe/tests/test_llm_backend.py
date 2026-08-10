"""Tests for HBPE LLM backend selection."""

from __future__ import annotations

from ci.hbpe.config import Settings, use_vllm_backend


def test_use_vllm_auto_when_api_base_set(monkeypatch):
    monkeypatch.setenv("LLM_API_BASE", "http://host.docker.internal:8000/v1")
    monkeypatch.setenv("HBPE_LLM_BACKEND", "auto")
    import ci.hbpe.config as config_module

    config_module.settings = Settings()
    assert use_vllm_backend() is True


def test_use_gguf_when_forced(monkeypatch):
    monkeypatch.setenv("LLM_API_BASE", "http://host.docker.internal:8000/v1")
    monkeypatch.setenv("HBPE_LLM_BACKEND", "gguf")
    import ci.hbpe.config as config_module

    config_module.settings = Settings()
    assert use_vllm_backend() is False
