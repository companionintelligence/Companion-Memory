import json
import os

from ci.summary.llm_endpoint_env import apply_persisted_llm_endpoint


def test_apply_persisted_llm_endpoint_sets_env(tmp_path, monkeypatch):
    config_path = tmp_path / "llm-endpoint.json"
    config_path.write_text(
        json.dumps(
            {
                "backend": "openai_compatible",
                "port": 8000,
                "apiKey": "vllm-local",
                "hostGateway": "host.docker.internal",
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.delenv("LLM_API_BASE", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setenv("LLM_ENDPOINT_CONFIG_PATH", str(config_path))

    apply_persisted_llm_endpoint()

    assert os.environ["LLM_API_BASE"] == "http://host.docker.internal:8000/v1"
    assert os.environ["LLM_API_KEY"] == "vllm-local"


def test_apply_persisted_llm_endpoint_skips_when_env_set(tmp_path, monkeypatch):
    config_path = tmp_path / "llm-endpoint.json"
    config_path.write_text(
        json.dumps(
            {
                "backend": "openai_compatible",
                "port": 8000,
                "hostGateway": "host.docker.internal",
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("LLM_API_BASE", "http://example.com/v1")
    monkeypatch.setenv("LLM_ENDPOINT_CONFIG_PATH", str(config_path))

    apply_persisted_llm_endpoint()

    assert os.environ["LLM_API_BASE"] == "http://example.com/v1"


def test_embedding_base_prefers_ollama_embed_host(monkeypatch):
    from ci.summary.config import resolve_embedding_api_base, resolve_embedding_api_key

    monkeypatch.setenv("OLLAMA_EMBED_HOST", "http://host.docker.internal:11434")
    monkeypatch.delenv("EMBEDDING_API_BASE", raising=False)
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)

    assert (
        resolve_embedding_api_base("http://host.docker.internal:8000/v1")
        == "http://host.docker.internal:11434/v1"
    )
    assert resolve_embedding_api_key() == "ollama"


def test_embedding_base_honors_explicit_override(monkeypatch):
    from ci.summary.config import resolve_embedding_api_base

    monkeypatch.setenv("EMBEDDING_API_BASE", "http://embedder:8080")
    monkeypatch.setenv("OLLAMA_EMBED_HOST", "http://host.docker.internal:11434")

    assert resolve_embedding_api_base("http://host.docker.internal:8000/v1") == (
        "http://embedder:8080/v1"
    )


def test_output_mode_prompted_for_vllm_port(monkeypatch):
    from ci.summary.config import _default_output_mode

    monkeypatch.delenv("SUMMARY_OUTPUT_MODE", raising=False)
    monkeypatch.setenv("LLM_API_BASE", "http://host.docker.internal:8000/v1")
    assert _default_output_mode() == "prompted"

    monkeypatch.setenv("LLM_API_BASE", "http://host.docker.internal:11434/v1")
    assert _default_output_mode() == "native"

    monkeypatch.setenv("SUMMARY_OUTPUT_MODE", "native")
    monkeypatch.setenv("LLM_API_BASE", "http://host.docker.internal:8000/v1")
    assert _default_output_mode() == "native"
