"""
Configuration management for CI-Summary Service.
"""
import os
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def _llm_model_from_env() -> str:
    model = os.getenv("SUMMARY_LLM_MODEL") or os.getenv("LLM_DEFAULT_CHAT_MODEL") or os.getenv("LLM_MODEL", "qwen/qwen3-vl-30b")
    return model


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
