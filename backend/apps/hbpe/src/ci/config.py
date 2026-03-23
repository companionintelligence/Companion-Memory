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
    # In Docker: set MODELS_DIR=/app/models (backed by a named volume).
    # Locally (dev/test): falls back to .cache/hbpe-models/ at the repo root
    # so downloaded models persist across test runs without an env var.
    models_dir: str = Field(
        default_factory=lambda: os.getenv(
            "MODELS_DIR",
            os.path.abspath(os.path.join(
                os.path.dirname(__file__), "../../../../..", ".cache", "hbpe-models"
            )),
        )
    )
    token_corpus_dir: str = Field(
        default_factory=lambda: os.getenv("TOKEN_CORPUS_DIR", "/app/data/token_corpus")
    )

    # ── Qwen labeler (GGUF via llama-cpp-python) ─────────────────────────────
    # Set QWEN_GGUF_PATH to an absolute local path to skip the HF download.
    # Otherwise the file is fetched from qwen_gguf_repo / qwen_gguf_file and
    # cached under models_dir/qwen/ (~500 MB for Q4_K_M).
    qwen_gguf_path: str = Field(
        default_factory=lambda: os.getenv("QWEN_GGUF_PATH", "")
    )
    qwen_gguf_repo: str = Field(
        default_factory=lambda: os.getenv("QWEN_GGUF_REPO", "unsloth/Qwen3.5-0.8B-GGUF")
    )
    qwen_gguf_file: str = Field(
        default_factory=lambda: os.getenv("QWEN_GGUF_FILE", "Qwen3.5-0.8B-Q8_0.gguf")
    )

    # ── Staleness (§1.2) ─────────────────────────────────────────────────────
    cluster_staleness_days: int = Field(
        default_factory=lambda: int(os.getenv("CLUSTER_STALENESS_DAYS", "90"))
    )

    # ── App GraphQL API ───────────────────────────────────────────────────────
    # Set API_URL to the base URL of the main application service (e.g.
    # http://application:3000).  graphql_client.py posts to {api_url}/graphql.
    api_url: str = Field(
        default_factory=lambda: os.getenv("API_URL", "http://application:3000")
    )
    # Shared JWT secret — must match AUTH_JWT_AUTHTOKENSECRET in the app.
    # HBPE self-signs service JWTs with this secret so the app accepts them.
    api_jwt_secret: str = Field(
        default_factory=lambda: os.getenv("API_JWT_SECRET", "")
    )
    # How long each service JWT lives (default 24 h).
    api_jwt_expiry_seconds: int = Field(
        default_factory=lambda: int(os.getenv("API_JWT_EXPIRY_SECONDS", "86400"))
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
