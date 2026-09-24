"""
Configuration management for CI-Summary Service.
"""

import logging
import os
from functools import lru_cache
from urllib.parse import urlparse

import httpx
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .llm_endpoint_env import apply_persisted_llm_endpoint
from .llm_host import resolve_env as resolve_llm_host_env
from .llm_host import resolve_url as resolve_llm_url

apply_persisted_llm_endpoint()

# Then correct the host for this namespace. `LLM_API_BASE` is written once and
# read from both sides of a container boundary, so the hostname in it is right
# for at most one of them — see llm_host.py. Runs after the shared-config load
# above so it also corrects whatever that wrote. Every rewrite is logged.
resolve_llm_host_env()

logger = logging.getLogger(__name__)


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def openai_v1_base(host: str) -> str:
    """Normalize an Ollama/OpenAI host to a `/v1` base URL."""
    base = host.strip().rstrip("/")
    if not base:
        return ""
    return base if base.endswith("/v1") else f"{base}/v1"


def resolve_embedding_api_base(llm_api_base: str) -> str:
    """
    Embeddings stay on Ollama even when chat is pointed at vLLM.

    The API already splits this (`OLLAMA_EMBED_HOST` vs `LLM_API_BASE`). Summary
    used to POST `/v1/embeddings` at the chat backend, which 404s on a chat-only
    vLLM and silently stores zero vectors.
    """
    explicit = os.getenv("EMBEDDING_API_BASE", "").strip()
    if explicit:
        return openai_v1_base(explicit)

    ollama_host = (
        os.getenv("OLLAMA_EMBED_HOST")
        or os.getenv("CI_OLLAMA_EMBED_HOST")
        or os.getenv("OLLAMA_HOST")
        or ""
    ).strip()
    if ollama_host:
        return openai_v1_base(ollama_host)

    return openai_v1_base(llm_api_base)


def resolve_embedding_api_key() -> str:
    return os.getenv("EMBEDDING_API_KEY", "").strip() or "ollama"


# Where an unconfigured service looks for chat. Written for the container this
# normally runs in; _default_llm_api_base corrects it when it is not.
DEFAULT_LLM_API_BASE = "http://host.docker.internal:11434/v1"


def _default_llm_api_base() -> str:
    """
    LLM_API_BASE, or the compiled-in fallback corrected for this runtime.

    resolve_llm_host_env() above has already fixed the env var, so the only case
    left is the fallback below — which names the docker host and therefore
    resolves nowhere when this service is run directly on a laptop.
    """
    configured = os.getenv("LLM_API_BASE", "")

    if configured.strip():
        return configured

    fixed, note = resolve_llm_url(DEFAULT_LLM_API_BASE)

    if note:
        logger.warning("LLM_API_BASE (default): %s", note)

    return fixed


def _default_output_mode() -> str:
    explicit = os.getenv("SUMMARY_OUTPUT_MODE")
    if explicit:
        return explicit.lower()

    # Native json_schema is an Ollama feature. vLLM typically rejects it (or
    # accepts it and then thinks for minutes); either way the first attempt
    # occupies the GPU before we fall back to prompted. Skip that when chat
    # is not Ollama.
    try:
        port = urlparse(os.getenv("LLM_API_BASE", "")).port
    except ValueError:
        port = None

    if port == 11434:
        return "native"
    if port:
        return "prompted"
    return "native"


def _llm_model_from_env() -> str:
    # The configured chat model, normally injected by CI Hub via
    # hub_integration.inference (LLM_DEFAULT_CHAT_MODEL). Empty when nothing is
    # configured — there is deliberately NO hardcoded model fallback here:
    # a baked-in tag can name a model the endpoint doesn't serve (this is how
    # "gemma4:latest" 404'd every summary in production). When unset, the
    # model is discovered from the endpoint at startup (see resolve_llm_model).
    return (
        os.getenv("SUMMARY_LLM_MODEL")
        or os.getenv("LLM_DEFAULT_CHAT_MODEL")
        or os.getenv("LLM_MODEL")
        or ""
    )


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Database Configuration
    database_url: str = Field(default_factory=lambda: _require_env("DATABASE_URL"))

    # LLM Configuration
    llm_api_base: str = Field(default_factory=_default_llm_api_base)
    llm_api_key: str = Field(default_factory=lambda: os.getenv("LLM_API_KEY", "ollama"))
    llm_model: str = Field(default_factory=_llm_model_from_env)
    llm_temperature: float = 0.3
    llm_max_tokens: int = 2000

    # Structured-output strategy for the pydantic-ai agents. The default
    # tool-calling path emits assistant messages with content=null, which
    # Ollama's OpenAI-compatible endpoint rejects with the error "invalid
    # message content type: <nil>", and small local models fumble strict
    # schemas. Note the wrapping: a comment line starting with "type:" is
    # parsed by mypy as a PEP 484 type comment and fails as invalid syntax.
    # Options:
    #   native   — Ollama json_schema response_format (server-enforced; default)
    #   prompted — schema in the prompt, parse the text reply (model-agnostic)
    #   tool     — original tool-calling behaviour
    output_mode: str = Field(default_factory=_default_output_mode)
    # How many times pydantic-ai re-asks the model when its output fails schema
    # validation, before the activity gives up.
    output_retries: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_OUTPUT_RETRIES", "3"))
    )

    @field_validator("llm_api_key", mode="before")
    @classmethod
    def _default_llm_api_key(cls, value):
        # An empty/blank LLM_API_KEY (e.g. exported but unset for a local Ollama
        # setup) must not reach the OpenAI client, which rejects empty keys.
        # Fall back to the "ollama" dummy, which Ollama ignores.
        if value is None or (isinstance(value, str) and not value.strip()):
            return "ollama"
        return value

    # Embedding Configuration
    embedding_model: str = Field(
        default_factory=lambda: (
            os.getenv("EMBEDDING_MODEL")
            or os.getenv("LLM_DEFAULT_EMBEDDING_MODEL", "nomic-embed-text")
        )
    )
    embedding_dimensions: int = Field(
        default_factory=lambda: int(os.getenv("EMBEDDING_DIMENSIONS", 768))
    )

    # Agent Configuration
    agent_name: str = Field(
        default_factory=lambda: os.getenv("SUMMARY_AGENT_NAME", "summary-agent")
    )
    agent_version: str = Field(
        default_factory=lambda: os.getenv("SUMMARY_AGENT_VERSION", "1.0.0")
    )
    agent_check_interval_seconds: int = Field(
        default_factory=lambda: int(
            os.getenv("SUMMARY_AGENT_CHECK_INTERVAL_SECONDS", 30)
        )
    )
    schema_detection_max_attempts: int = Field(
        default_factory=lambda: int(
            os.getenv("SUMMARY_SCHEMA_DETECTION_MAX_ATTEMPTS", 0)
        )
    )
    schema_detection_retry_seconds: float = Field(
        default_factory=lambda: float(
            os.getenv("SUMMARY_SCHEMA_DETECTION_RETRY_SECONDS", 2)
        )
    )

    # Summarization Configuration
    summary_overlap_minutes: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_OVERLAP_MINUTES", 5))
    )
    max_items_per_category: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_MAX_ITEMS_PER_CATEGORY", 100))
    )
    dossier_lookback_days: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_DOSSIER_LOOKBACK_DAYS", 30))
    )
    dossier_max_chars: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_DOSSIER_MAX_CHARS", 4000))
    )

    # Function runner (pg-boss dispatch from the NestJS API)
    # Bounded worker pool size for /functions/run — replaces the Temporal
    # high/medium/low task queues with a single concurrency limit.
    function_runner_concurrency: int = Field(
        default_factory=lambda: int(os.getenv("FUNCTION_RUNNER_CONCURRENCY", "2"))
    )
    # Base URL of the main application API; run-completion callbacks POST to
    # {api_url}/function-runs/callback.
    api_url: str = Field(
        default_factory=lambda: os.getenv("API_URL", "http://api:3030")
    )
    # Shared bearer for this service's inbound HTTP surface (see auth.py): the
    # API presents it on every request; the middleware refuses requests without
    # it. Minted by setup-secrets as SIDECAR_AUTH_SECRET. Replaced API_JWT_SECRET,
    # the API's own token-signing secret, which the runner used to self-sign a
    # user token for the callback — the runner now echoes the per-run token the
    # API attached to the run request instead, and signs nothing.
    sidecar_auth_secret: str = Field(
        default_factory=lambda: os.getenv("SIDECAR_AUTH_SECRET", "")
    )

    # Logging
    log_level: str = Field(
        default_factory=lambda: os.getenv("SUMMARY_LOG_LEVEL", "INFO")
    )
    debug_prompts: bool = Field(
        default_factory=lambda: (
            os.getenv("SUMMARY_DEBUG_PROMPTS", "false").lower() == "true"
        )
    )

    model_config = SettingsConfigDict(
        extra="ignore",
        case_sensitive=False,
    )


# Global settings instance
settings = Settings()


def _served_model_ids() -> list[str]:
    """Model ids served by the OpenAI-compatible endpoint (GET /models)."""
    url = f"{settings.llm_api_base.rstrip('/')}/models"
    response = httpx.get(
        url, headers={"Authorization": f"Bearer {settings.llm_api_key}"}, timeout=10.0
    )
    response.raise_for_status()
    return [model["id"] for model in response.json().get("data", []) if model.get("id")]


def _is_served(model: str, served: list[str]) -> bool:
    # Ollama aliases a bare model name to its ":latest" tag, so treat
    # "name" as served when "name:latest" (or any "name:tag") is listed.
    return any(tag == model or tag.startswith(f"{model}:") for tag in served)


def _pick_chat_model(served: list[str]) -> str | None:
    # /models has no capability metadata, so exclude embedding models by name.
    for tag in served:
        if "embed" not in tag.lower():
            return tag
    return None


@lru_cache(maxsize=1)
def resolve_llm_model() -> str:
    """
    The chat model the service should use.

    The configured model (CI Hub-injected LLM_DEFAULT_CHAT_MODEL, or an
    operator-set SUMMARY_LLM_MODEL / LLM_MODEL) wins when the endpoint serves
    it. Otherwise the model is discovered from the endpoint's /models listing,
    so the service always names a model that actually exists — never a
    hardcoded default.
    """
    configured = settings.llm_model

    try:
        served = _served_model_ids()
    except Exception as exc:
        if configured:
            # Endpoint not reachable yet: trust the configured model rather
            # than failing startup — it is validated per-request anyway.
            logger.warning(
                "Could not list models at %s (%s); using configured model %r unvalidated.",
                settings.llm_api_base,
                exc,
                configured,
            )
            return configured
        raise RuntimeError(
            f"No LLM model configured and model discovery at {settings.llm_api_base} failed ({exc}). "
            "Set LLM_DEFAULT_CHAT_MODEL (normally injected by CI Hub) or make the endpoint reachable."
        ) from exc

    if configured:
        if _is_served(configured, served):
            return configured
        fallback = _pick_chat_model(served)
        if fallback:
            logger.warning(
                "Configured model %r is not served by %s; using available model %r instead.",
                configured,
                settings.llm_api_base,
                fallback,
            )
            return fallback
        logger.warning(
            "Configured model %r is not served by %s and no alternative chat model is available; keeping it.",
            configured,
            settings.llm_api_base,
        )
        return configured

    discovered = _pick_chat_model(served)
    if not discovered:
        raise RuntimeError(
            f"No LLM model configured and {settings.llm_api_base} serves no chat model. "
            "Pull a model via CI Hub or set LLM_DEFAULT_CHAT_MODEL."
        )
    logger.info(
        "No LLM model configured; discovered %r from %s.",
        discovered,
        settings.llm_api_base,
    )
    return discovered
