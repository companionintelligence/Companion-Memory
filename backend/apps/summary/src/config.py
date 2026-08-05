"""
Configuration management for CI-Summary Service.
"""
import logging
import os
from functools import lru_cache
from typing import List, Optional

import httpx
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def _llm_model_from_env() -> str:
    # The configured chat model, normally injected by CI Hub via
    # hub_integration.inference (LLM_DEFAULT_CHAT_MODEL). Empty when nothing is
    # configured — there is deliberately NO hardcoded model fallback here:
    # a baked-in tag can name a model the endpoint doesn't serve (this is how
    # "gemma4:latest" 404'd every summary in production). When unset, the
    # model is discovered from the endpoint at startup (see resolve_llm_model).
    return os.getenv("SUMMARY_LLM_MODEL") or os.getenv("LLM_DEFAULT_CHAT_MODEL") or os.getenv("LLM_MODEL") or ""


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Database Configuration
    database_url: str = Field(default_factory=lambda: _require_env("DATABASE_URL"))

    # LLM Configuration
    llm_api_base: str = Field(default_factory=lambda: os.getenv("LLM_API_BASE", "http://host.docker.internal:11434/v1"))
    llm_api_key: str = Field(default_factory=lambda: os.getenv("LLM_API_KEY", "ollama"))
    llm_model: str = Field(default_factory=_llm_model_from_env)
    llm_temperature: float = 0.3
    llm_max_tokens: int = 2000

    # Structured-output strategy for the pydantic-ai agents. The default
    # tool-calling path emits assistant messages with content=null, which
    # Ollama's OpenAI-compatible endpoint rejects ("invalid message content
    # type: <nil>"), and small local models fumble strict schemas. Options:
    #   native   — Ollama json_schema response_format (server-enforced; default)
    #   prompted — schema in the prompt, parse the text reply (model-agnostic)
    #   tool     — original tool-calling behaviour
    output_mode: str = Field(default_factory=lambda: os.getenv("SUMMARY_OUTPUT_MODE", "native").lower())
    # How many times pydantic-ai re-asks the model when its output fails schema
    # validation, before the activity gives up.
    output_retries: int = Field(default_factory=lambda: int(os.getenv("SUMMARY_OUTPUT_RETRIES", "3")))

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
    embedding_model: str = Field(default_factory=lambda: os.getenv("EMBEDDING_MODEL") or os.getenv("LLM_DEFAULT_EMBEDDING_MODEL", "nomic-embed-text"))
    embedding_dimensions: int = Field(default_factory=lambda: int(os.getenv("EMBEDDING_DIMENSIONS", 768)))

    # Agent Configuration
    agent_name: str = Field(default_factory=lambda: os.getenv("SUMMARY_AGENT_NAME", "summary-agent"))
    agent_version: str = Field(default_factory=lambda: os.getenv("SUMMARY_AGENT_VERSION", "1.0.0"))
    agent_check_interval_seconds: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_AGENT_CHECK_INTERVAL_SECONDS", 30))
    )
    schema_detection_max_attempts: int = Field(
        default_factory=lambda: int(os.getenv("SUMMARY_SCHEMA_DETECTION_MAX_ATTEMPTS", 0))
    )
    schema_detection_retry_seconds: float = Field(
        default_factory=lambda: float(os.getenv("SUMMARY_SCHEMA_DETECTION_RETRY_SECONDS", 2))
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

    # Logging
    log_level: str = Field(default_factory=lambda: os.getenv("SUMMARY_LOG_LEVEL", "INFO"))
    debug_prompts: bool = Field(default_factory=lambda: os.getenv("SUMMARY_DEBUG_PROMPTS", "false").lower() == "true")

    # Temporal Configuration
    temporal_address: str = Field(default_factory=lambda: os.getenv("TEMPORAL_ADDRESS", "orchestrator:7233"))
    temporal_namespace: str = Field(default_factory=lambda: os.getenv("TEMPORAL_NAMESPACE", "default"))

    # Task Queue Configuration (shared across all systems)
    task_queue_high: str = Field(default_factory=lambda: os.getenv("TEMPORAL_TASK_QUEUE_HIGH", "high"))
    task_queue_medium: str = Field(default_factory=lambda: os.getenv("TEMPORAL_TASK_QUEUE_MEDIUM", "medium"))
    task_queue_low: str = Field(default_factory=lambda: os.getenv("TEMPORAL_TASK_QUEUE_LOW", "low"))

    # Worker Concurrency Configuration
    max_concurrent_activities_high: int = Field(default_factory=lambda: int(os.getenv("TEMPORAL_MAX_CONCURRENT_ACTIVITIES_HIGH", 5)))
    max_concurrent_activities_medium: int = Field(default_factory=lambda: int(os.getenv("TEMPORAL_MAX_CONCURRENT_ACTIVITIES_MEDIUM", 3)))
    max_concurrent_activities_low: int = Field(default_factory=lambda: int(os.getenv("TEMPORAL_MAX_CONCURRENT_ACTIVITIES_LOW", 1)))

    model_config = SettingsConfigDict(
        extra="ignore",
        case_sensitive=False,
    )


# Global settings instance
settings = Settings()


def _served_model_ids() -> List[str]:
    """Model ids served by the OpenAI-compatible endpoint (GET /models)."""
    url = f"{settings.llm_api_base.rstrip('/')}/models"
    response = httpx.get(url, headers={"Authorization": f"Bearer {settings.llm_api_key}"}, timeout=10.0)
    response.raise_for_status()
    return [model["id"] for model in response.json().get("data", []) if model.get("id")]


def _is_served(model: str, served: List[str]) -> bool:
    # Ollama aliases a bare model name to its ":latest" tag, so treat
    # "name" as served when "name:latest" (or any "name:tag") is listed.
    return any(tag == model or tag.startswith(f"{model}:") for tag in served)


def _pick_chat_model(served: List[str]) -> Optional[str]:
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
            logger.warning("Could not list models at %s (%s); using configured model %r unvalidated.", settings.llm_api_base, exc, configured)
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
            logger.warning("Configured model %r is not served by %s; using available model %r instead.", configured, settings.llm_api_base, fallback)
            return fallback
        logger.warning("Configured model %r is not served by %s and no alternative chat model is available; keeping it.", configured, settings.llm_api_base)
        return configured

    discovered = _pick_chat_model(served)
    if not discovered:
        raise RuntimeError(
            f"No LLM model configured and {settings.llm_api_base} serves no chat model. "
            "Pull a model via CI Hub or set LLM_DEFAULT_CHAT_MODEL."
        )
    logger.info("No LLM model configured; discovered %r from %s.", discovered, settings.llm_api_base)
    return discovered
