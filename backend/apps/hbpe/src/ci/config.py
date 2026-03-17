"""
Central configuration for the HBPE service.

All tuneable constants are exposed here so they can be overridden via
environment variables without touching code.
"""
from __future__ import annotations

import os
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


class Settings(BaseSettings):
    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = Field(default_factory=lambda: _require_env("DATABASE_URL"))

    # ── Temporal ──────────────────────────────────────────────────────────────
    temporal_address: str = Field(
        default_factory=lambda: os.getenv("TEMPORAL_ADDRESS", "localhost:7233")
    )
    temporal_namespace: str = Field(
        default_factory=lambda: os.getenv("TEMPORAL_NAMESPACE", "default")
    )
    task_queue: str = Field(
        default_factory=lambda: os.getenv("HBPE_TASK_QUEUE", "hbpe")
    )

    # ── Model artifacts ───────────────────────────────────────────────────────
    models_dir: str = Field(
        default_factory=lambda: os.getenv("MODELS_DIR", "/app/models")
    )
    token_corpus_dir: str = Field(
        default_factory=lambda: os.getenv("TOKEN_CORPUS_DIR", "/app/data/token_corpus")
    )

    # ── Qwen labeler ─────────────────────────────────────────────────────────
    # HuggingFace model ID for the on-device label generator.
    # The model is downloaded on first use; ensure /app/models has enough space (~1.5 GB).
    # Qwen3.5-0.8B is a hybrid DeltaNet/Attention instruct model. Without
    # flash-linear-attention + causal-conv1d CUDA kernels it falls back to
    # pure-torch (slow on CPU). Override with QWEN_MODEL_NAME if needed.
    qwen_model_name: str = Field(
        default_factory=lambda: os.getenv("QWEN_MODEL_NAME", "Qwen/Qwen3.5-0.8B")
    )

    # ── Staleness (§1.2) ─────────────────────────────────────────────────────
    cluster_staleness_days: int = Field(
        default_factory=lambda: int(os.getenv("CLUSTER_STALENESS_DAYS", "90"))
    )

    # ── API ───────────────────────────────────────────────────────────────────
    api_port: int = Field(
        default_factory=lambda: int(os.getenv("HBPE_API_PORT", "8002"))
    )
    log_level: str = Field(
        default_factory=lambda: os.getenv("HBPE_LOG_LEVEL", "INFO")
    )

    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)


settings = Settings()
