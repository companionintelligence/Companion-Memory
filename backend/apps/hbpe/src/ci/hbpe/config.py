"""
Central configuration for the HBPE service.

All tuneable constants are exposed here so they can be overridden via
environment variables without touching code.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

_proj_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../.."))
load_dotenv(os.path.join(_proj_root, ".env.default"))
load_dotenv(os.path.join(_proj_root, ".env"), override=True)

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _get_database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        return url

    host = os.getenv("DATABASE_HOST", "localhost")
    port = os.getenv("DATABASE_PORT", "5432")
    user = os.getenv("DATABASE_USERNAME", "companion")
    password = os.getenv("DATABASE_PASSWORD", "")
    db = os.getenv("DATABASE_NAME", "companion")

    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


class Settings(BaseSettings):
    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = Field(default_factory=_get_database_url)

    # ── Model artifacts ───────────────────────────────────────────────────────
    # In Docker: set MODELS_DIR=/app/models (backed by a named volume).
    # Locally (dev/test): falls back to .cache/hbpe-models/ at the repo root
    # so downloaded models persist across test runs without an env var.
    models_dir: str = Field(
        default_factory=lambda: os.getenv(
            "MODELS_DIR",
            os.path.abspath(
                os.path.join(
                    os.path.dirname(__file__), "../../../../..", ".cache", "hbpe-models"
                )
            ),
        )
    )
    token_corpus_dir: str = Field(
        default_factory=lambda: os.getenv("TOKEN_CORPUS_DIR", "/app/data/token_corpus")
    )

    # ── LLM labeling (vLLM / OpenAI-compatible, or local GGUF fallback) ───────
    # Production: set LLM_API_BASE to the shared vLLM OpenAI endpoint (same as
    # API chat and summary). HBPE uses LLM_DEFAULT_CHAT_MODEL unless HBPE_LLM_MODEL
    # overrides it. Set HBPE_LLM_BACKEND=gguf to force on-device llama.cpp.
    llm_api_base: str = Field(default_factory=lambda: os.getenv("LLM_API_BASE", ""))
    llm_api_key: str = Field(
        default_factory=lambda: os.getenv("LLM_API_KEY", "vllm-local")
    )
    hbpe_llm_backend: str = Field(
        default_factory=lambda: os.getenv("HBPE_LLM_BACKEND", "auto").lower()
    )

    # ── Local GGUF fallback (llama-cpp-python) ────────────────────────────────
    # Used only when HBPE_LLM_BACKEND=gguf or auto with no LLM_API_BASE set.
    # Set QWEN_GGUF_PATH to an absolute local path to skip the HF download.
    # Otherwise the file is fetched from qwen_gguf_repo / qwen_gguf_file and
    # cached under models_dir/qwen/ (~500 MB for Q4_K_M).
    qwen_gguf_path: str = Field(default_factory=lambda: os.getenv("QWEN_GGUF_PATH", ""))
    qwen_gguf_repo: str = Field(
        default_factory=lambda: os.getenv("QWEN_GGUF_REPO", "unsloth/Qwen3.5-0.8B-GGUF")
    )
    qwen_gguf_file: str = Field(
        default_factory=lambda: os.getenv("QWEN_GGUF_FILE", "Qwen3.5-0.8B-Q8_0.gguf")
    )
    # Qwen3.5 is a "thinking" model: by default it emits a long <think> block
    # before the answer. For label generation (a 1-3 word JSON), that chain of
    # thought is pure CPU cost. Disabling it (the /no_think soft switch) is the
    # single biggest throughput win on CPU-only deployments. Set
    # QWEN_DISABLE_THINKING=false to restore reasoning.
    qwen_disable_thinking: bool = Field(
        default_factory=lambda: (
            os.getenv("QWEN_DISABLE_THINKING", "true").lower() in ("1", "true", "yes")
        )
    )
    # Token ceiling applied when thinking is disabled — the response is just a
    # short JSON object, so a small cap keeps each generation cheap.
    qwen_max_tokens_no_think: int = Field(
        default_factory=lambda: int(os.getenv("QWEN_MAX_TOKENS_NO_THINK", "64"))
    )

    # ── Staleness (§1.2) ─────────────────────────────────────────────────────
    cluster_staleness_days: int = Field(
        default_factory=lambda: int(os.getenv("CLUSTER_STALENESS_DAYS", "90"))
    )

    # ── App GraphQL API ───────────────────────────────────────────────────────
    # Set API_URL to the base URL of the main application service (e.g.
    # http://api:3000).  graphql_client.py posts to {api_url}/graphql.
    api_url: str = Field(
        default_factory=lambda: os.getenv("API_URL", "http://api:3000")
    )
    # Shared JWT secret — must match AUTH_JWT_AUTHTOKENSECRET in the app.
    # HBPE self-signs service JWTs with this secret so the app accepts them.
    api_jwt_secret: str = Field(default_factory=lambda: os.getenv("API_JWT_SECRET", ""))
    # How long each service JWT lives (default 24 h).
    api_jwt_expiry_seconds: int = Field(
        default_factory=lambda: int(os.getenv("API_JWT_EXPIRY_SECONDS", "86400"))
    )

    # ── Function runner (pg-boss dispatch from the NestJS API) ───────────────
    function_runner_concurrency: int = Field(
        default_factory=lambda: int(os.getenv("FUNCTION_RUNNER_CONCURRENCY", "1"))
    )

    # ── API ───────────────────────────────────────────────────────────────────
    api_port: int = Field(
        default_factory=lambda: int(os.getenv("HBPE_API_PORT", "8002"))
    )
    log_level: str = Field(default_factory=lambda: os.getenv("HBPE_LOG_LEVEL", "INFO"))

    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)


settings = Settings()


def use_vllm_backend() -> bool:
    """True when HBPE should label via the shared OpenAI-compatible LLM endpoint."""
    backend = settings.hbpe_llm_backend
    if backend == "gguf":
        return False
    if backend == "vllm":
        return True
    return bool(settings.llm_api_base.strip())
