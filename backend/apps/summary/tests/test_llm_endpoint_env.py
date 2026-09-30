import json
import os

import pytest

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


def test_output_mode_is_auto_unless_set(monkeypatch):
    from ci.summary.config import _default_output_mode

    monkeypatch.delenv("SUMMARY_OUTPUT_MODE", raising=False)
    assert _default_output_mode() == "auto"

    monkeypatch.setenv("SUMMARY_OUTPUT_MODE", "Prompted")
    assert _default_output_mode() == "prompted"


@pytest.fixture
def output_mode(monkeypatch):
    """resolve_output_mode against a stubbed /models listing, with its cache cleared."""
    import ci.summary.config as config

    monkeypatch.setattr(config, "_resolved_output_mode", None)
    monkeypatch.setattr(config.settings, "output_mode", "auto")
    monkeypatch.setattr(
        config.settings, "llm_api_base", "http://ci-hub:5002/api/inference/pool/v1"
    )

    def serve(rows):
        calls = []

        def served():
            calls.append(1)
            if isinstance(rows, Exception):
                raise rows
            return rows

        monkeypatch.setattr(config, "_served_models", served)
        return calls

    return config, serve


def test_output_mode_native_for_lemonade_and_other_json_schema_backends(output_mode):
    config, serve = output_mode
    serve([{"id": "Qwen3.8-27B-GGUF", "owned_by": "lemonade", "labels": ["chat"]}])

    assert config.resolve_output_mode() == "native"


def test_output_mode_prompted_for_vllm_even_behind_the_hub_pool(output_mode):
    config, serve = output_mode
    serve([{"id": "Qwen/Qwen3-8B", "owned_by": "vllm", "max_model_len": 40960}])

    assert config.resolve_output_mode() == "prompted"


def test_output_mode_native_on_ollama_port_without_asking(output_mode):
    config, serve = output_mode
    config.settings.llm_api_base = "http://host.docker.internal:11434/v1"
    calls = serve([{"id": "x", "owned_by": "vllm"}])

    assert config.resolve_output_mode() == "native"
    assert calls == []


def test_output_mode_setting_wins(output_mode):
    config, serve = output_mode
    config.settings.output_mode = "native"
    calls = serve([{"id": "x", "owned_by": "vllm"}])

    assert config.resolve_output_mode() == "native"
    assert calls == []


def test_output_mode_retries_an_unreachable_endpoint(output_mode):
    config, serve = output_mode
    serve(RuntimeError("connection refused"))
    assert config.resolve_output_mode() == "native"

    serve([{"id": "Qwen/Qwen3-8B", "owned_by": "vllm"}])
    assert config.resolve_output_mode() == "prompted"


LEMONADE_ROWS = [
    {"id": "nomic-embed-text-v1.5-GGUF", "labels": ["custom", "embeddings"]},
    {"id": "bge-reranker-v2-m3-GGUF", "labels": ["reranking"]},
    {"id": "Whisper-Large-v3-Turbo", "labels": ["transcription"]},
    {"id": "Qwen3.8-27B-GGUF", "labels": ["chat", "vision"]},
]


def test_pick_chat_model_skips_embedders_rerankers_and_speech(monkeypatch):
    from ci.summary.config import _pick_chat_model

    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    monkeypatch.delenv("LLM_DEFAULT_EMBEDDING_MODEL", raising=False)

    assert _pick_chat_model(LEMONADE_ROWS) == "Qwen3.8-27B-GGUF"
    assert _pick_chat_model(LEMONADE_ROWS[:3]) is None
    # Unlabelled backends are judged by name.
    assert (
        _pick_chat_model([{"id": "BAAI/bge-m3"}, {"id": "Qwen/Qwen3-8B"}])
        == "Qwen/Qwen3-8B"
    )


def test_is_chat_model_excludes_the_configured_embedder(monkeypatch):
    from ci.summary.config import is_chat_model

    monkeypatch.setenv("EMBEDDING_MODEL", "my-vectors")

    assert is_chat_model({"id": "my-vectors:latest"}) is False
    assert is_chat_model({"id": "user.My-Model-GGUF", "labels": ["custom"]}) is True
    assert (
        is_chat_model(
            {"id": "Qwen2.5-Omni-7B-GGUF", "labels": ["chat", "chat-transcription"]}
        )
        is True
    )


def test_embedding_key_follows_the_chat_key_to_the_same_origin(monkeypatch):
    """CI-Hub's pool checks the key; the placeholder there came back as a silent `[]` embedding."""
    from ci.summary.config import resolve_embedding_api_key

    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    monkeypatch.setenv("LLM_API_BASE", "http://ci-hub:5002/api/inference/pool/v1")
    monkeypatch.setenv("LLM_API_KEY", "hub-app-key")

    assert (
        resolve_embedding_api_key("http://ci-hub:5002/api/inference/pool/v1")
        == "hub-app-key"
    )
    # Never to another host: the chat key stays with the chat origin.
    assert resolve_embedding_api_key("http://host.docker.internal:11434/v1") == "ollama"

    monkeypatch.setenv("EMBEDDING_API_KEY", "explicit")
    assert (
        resolve_embedding_api_key("http://host.docker.internal:11434/v1") == "explicit"
    )


def test_embedding_model_takes_only_hubs_names_for_the_indexed_model(
    monkeypatch, caplog
):
    """Lemonade's nomic v1 is a different vector space (cosine ~0.7 against v1.5)."""
    from ci.summary.config import resolve_embedding_model

    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    monkeypatch.setenv("LLM_DEFAULT_EMBEDDING_MODEL", "nomic-embed-text-v1.5-GGUF")
    assert resolve_embedding_model() == "nomic-embed-text-v1.5-GGUF"

    monkeypatch.setenv("LLM_DEFAULT_EMBEDDING_MODEL", "nomic-embed-text-v1-GGUF")
    assert resolve_embedding_model() == "nomic-embed-text"
    assert "nomic-embed-text-v1-GGUF" in caplog.text

    monkeypatch.setenv("EMBEDDING_MODEL", "mxbai-embed-large")
    assert resolve_embedding_model() == "mxbai-embed-large"
