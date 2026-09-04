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

# The endpoint URLs above are written from one machine's point of view and read
# from two: `localhost` is the host's Ollama to the API process and this
# container's own loopback to us. Correct them for wherever this process is
# before anything reads them — see llm_host.py. Loud on every rewrite: a
# labeler pointed at nothing writes zero labels while reporting healthy.
from .llm_host import resolve_env as _resolve_llm_host_env

_resolve_llm_host_env()

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


def _optional_positive_seconds(raw: str | None) -> float | None:
    """Parse HBPE_LABEL_HTTP_TIMEOUT. Empty / 0 / none → wait indefinitely."""
    if raw is None:
        return None
    text = raw.strip().lower()
    if text in ("", "none", "off"):
        return None
    seconds = float(text)
    if seconds <= 0:
        return None
    return seconds


# One dropped Ollama completion parked a nightly for hours when this was None.
# Five minutes is well above a healthy 8B label (~5s here) and still lets the
# drain skip a dead socket and continue. Set HBPE_LABEL_HTTP_TIMEOUT to 0 /
# none to wait forever.
_DEFAULT_LABEL_HTTP_TIMEOUT_SECONDS = 300.0


def _label_http_timeout_seconds() -> float | None:
    raw = os.getenv("HBPE_LABEL_HTTP_TIMEOUT")
    if raw is None:
        return _DEFAULT_LABEL_HTTP_TIMEOUT_SECONDS
    return _optional_positive_seconds(raw)


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

    # ── Qwen labeler ─────────────────────────────────────────────────────────
    # Prefer the Hub-injected OpenAI-compatible chat endpoint (vLLM Qwen3-8B)
    # so we do not load a second GGUF next to the already-resident 8B. GGUF is
    # the fallback when no API base is set (laptop / CI without vLLM).
    # Set QWEN_GGUF_PATH to an absolute local path to skip the HF download.
    # Otherwise the file is fetched from qwen_gguf_repo / qwen_gguf_file and
    # cached under models_dir/qwen/.
    label_api_base: str = Field(
        default_factory=lambda: (
            os.getenv("HBPE_LABEL_API_BASE") or os.getenv("LLM_API_BASE") or ""
        )
    )
    label_api_key: str = Field(
        default_factory=lambda: (
            os.getenv("HBPE_LABEL_API_KEY")
            or os.getenv("LLM_API_KEY")
            or os.getenv("VLLM_API_KEY")
            or ""
        )
    )
    label_chat_model: str = Field(
        default_factory=lambda: (
            os.getenv("HBPE_LABEL_MODEL") or os.getenv("LLM_DEFAULT_CHAT_MODEL") or ""
        )
    )
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
    # Per-call HTTP timeout for the chat labeler. Default 5 minutes so a
    # dropped completion cannot park the nightly. Set
    # HBPE_LABEL_HTTP_TIMEOUT to 0 / "none" to wait until the server responds.
    label_http_timeout_seconds: float | None = Field(
        default_factory=_label_http_timeout_seconds
    )

    # ── Staleness (§1.2) ─────────────────────────────────────────────────────
    cluster_staleness_days: int = Field(
        default_factory=lambda: int(os.getenv("CLUSTER_STALENESS_DAYS", "90"))
    )
    label_budget_seconds: int = Field(
        default_factory=lambda: int(os.getenv("HBPE_LABEL_BUDGET_SECONDS", "14400"))
    )

    # ── Label drain ordering (see nightly_runner.label_unlabeled) ─────────────
    # The drain used to be strictly oldest-first over the whole corpus, so on a
    # real appliance (198k events back to 2006) the labeling front sat years in
    # the past and hbpe.recurrence_profiles — which only reads the last
    # HISTORY_DAYS of hbpe.token_stream — was permanently empty, i.e. /forecast
    # returned clusters:[] for months. The drain now runs the recency window
    # first.
    #
    # The width of that window is bootstrap.SERIALIZE_WINDOW_DAYS, NOT
    # recurrence.HISTORY_DAYS (180). A label reaches the profiler only via
    # hbpe.token_stream, and the only writer of that table serializes the days
    # bootstrap.content_source_days returns; a day that fell out of that list
    # before its events were labeled is never revisited. On a DENSE corpus that
    # list is the trailing SERIALIZE_WINDOW_DAYS, so labeling the 90–180-day
    # band produces zero token_stream rows — on the dev corpus that is 5,775 of
    # the 7,192 unlabeled events inside 180 days, i.e. most of a reserved budget
    # share spent for no forecast at all.
    #
    # That equivalence is no longer unconditional: the list is days-with-data
    # under a tiered budget, so on a SPARSE-event corpus tier A's reserved event
    # days can reach into and past the 90–180-day band, and those days ARE
    # serialized. The setting is still kept equal to the serialize window
    # because a value *smaller*
    # than the serialize window is the harmful direction: it hands days that
    # serialize will write to the oldest-first historical phase, which reaches
    # them last. Kept equal by a test in tests/test_label_drain.py.
    label_recency_days: int = Field(
        default_factory=lambda: int(os.getenv("HBPE_LABEL_RECENCY_DAYS", "90"))
    )
    # Fraction of label_budget_seconds reserved for that recency phase. The
    # remainder is what guarantees the historical backfill still makes progress
    # every night, so old data is never permanently starved. Unused recency time
    # rolls over automatically (both phases share one wall-clock budget), so an
    # already-drained or empty recency window costs one query, not 80% of the
    # night. Clamped to [0, 1] at the use site.
    label_recency_budget_share: float = Field(
        default_factory=lambda: float(os.getenv("HBPE_LABEL_RECENCY_SHARE", "0.8"))
    )

    # ── App GraphQL API ───────────────────────────────────────────────────────
    # Set API_URL to the base URL of the main application service (e.g.
    # http://api:3030).  graphql_client.py posts to {api_url}/graphql.
    # Function-run callbacks go to {api_url}/function-runs/callback — a wrong
    # port leaves pg-boss jobs stuck `active`.
    api_url: str = Field(
        default_factory=lambda: os.getenv("API_URL", "http://api:3030")
    )
    # Shared JWT secret — must match AUTH_JWT_AUTHTOKENSECRET in the app.
    # HBPE self-signs service JWTs with this secret so the app accepts them.
    api_jwt_secret: str = Field(default_factory=lambda: os.getenv("API_JWT_SECRET", ""))
    # How long each service JWT lives (default 24 h).
    api_jwt_expiry_seconds: int = Field(
        default_factory=lambda: int(os.getenv("API_JWT_EXPIRY_SECONDS", "86400"))
    )

    # ── Function runner (pg-boss dispatch from the NestJS API) ───────────────
    # Worker pool size for /functions/run. Defaults to 1: labeling shares a
    # single-flight llama.cpp context and training is CPU-saturating, so
    # concurrent pipeline runs only thrash.
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
