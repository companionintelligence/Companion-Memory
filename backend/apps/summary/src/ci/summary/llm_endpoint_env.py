"""
Apply LLM endpoint settings saved by the API Settings UI.

The API persists shared config to ${APP_DATA_DIR}/data/llm-endpoint.json when
APP_DATA_DIR is mounted at /app-data. Summary reads it before Settings() so
LLM_API_BASE / LLM_API_KEY match the API container (chat, actions, insights).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_PATH = "/app-data/data/llm-endpoint.json"


def _config_path() -> Path:
    return Path(os.getenv("LLM_ENDPOINT_CONFIG_PATH", DEFAULT_CONFIG_PATH))


def _base_path(raw: object) -> str:
    """
    The OpenAI-compatible root the API saved with the endpoint (`basePath`): `/v1` for vLLM,
    llama.cpp and SGLang, `/api/v1` for Lemonade. Mirrors `normalizeBasePath` in the API's
    llmEndpointShared.ts: empty means `/v1`, slashes are normalised.
    """
    text = raw.strip().rstrip("/") if isinstance(raw, str) else ""
    if not text:
        return "/v1"
    return text if text.startswith("/") else f"/{text}"


def _api_base(
    host_gateway: str, backend: str, port: int, base_path: object = None
) -> str:
    path = _base_path(base_path) if backend == "openai_compatible" else "/v1"
    return f"http://{host_gateway}:{port}{path}"


def apply_persisted_llm_endpoint() -> None:
    """Load shared endpoint config into os.environ when Hub did not inject LLM_*."""
    if os.getenv("LLM_API_BASE", "").strip():
        return

    path = _config_path()

    if not path.is_file():
        return

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read shared LLM endpoint config at %s: %s", path, exc)
        return

    backend = raw.get("backend")
    port = raw.get("port")
    host_gateway = (raw.get("hostGateway") or "host.docker.internal").strip()
    api_key = raw.get("apiKey")

    if backend not in ("ollama", "openai_compatible"):
        return

    if not isinstance(port, int) or port <= 0 or port > 65535:
        return

    os.environ["LLM_API_BASE"] = _api_base(
        host_gateway, backend, port, raw.get("basePath")
    )

    if isinstance(api_key, str) and api_key.strip():
        os.environ["LLM_API_KEY"] = api_key.strip()

    logger.info(
        "Applied shared LLM endpoint from %s (backend=%s port=%s base=%s)",
        path,
        backend,
        port,
        os.environ["LLM_API_BASE"],
    )
