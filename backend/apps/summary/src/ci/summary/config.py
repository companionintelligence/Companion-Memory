"""
Configuration management for CI-Summary Service.
"""

import logging
import os
import re
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


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlparse(url)
    return (parsed.scheme, parsed.hostname or "", parsed.port)


def resolve_embedding_api_key(embedding_base: str | None = None) -> str:
    """
    The bearer token for embedding calls: `EMBEDDING_API_KEY`, else `LLM_API_KEY` when the
    embeddings go to the same origin as chat, else the placeholder Ollama ignores.

    CI-Hub points both at its pool (`http://ci-hub:5002/api/inference/pool`), which checks the key.
    Sending the placeholder there came back as an error that `generate_embedding` turns into `[]`,
    silently. The chat key is only sent to the chat origin, never to some other embedding host.
    """
    explicit = os.getenv("EMBEDDING_API_KEY", "").strip()
    if explicit:
        return explicit

    llm_base = os.getenv("LLM_API_BASE", "").strip()
    llm_key = os.getenv("LLM_API_KEY", "").strip()
    base = (
        embedding_base
        if embedding_base is not None
        else resolve_embedding_api_base(llm_base)
    )
    if llm_key and llm_base and base and _origin(base) == _origin(llm_base):
        return llm_key

    return "ollama"


# Every engine's name for the embedding model the index is built with: nomic-embed-text v1.5
# (Ollama's tags, and the Lemonade registration CI-Hub installs). Mirrors EMBED_MODEL_ALIASES in the
# API's common/embeddings/embedModelIdentity.ts; keep the two in step. Lemonade's own
# `nomic-embed-text-v1-GGUF` is deliberately absent: v1 vectors agree with v1.5's at cosine ~0.7.
NOMIC_V15_EMBED_NAMES = frozenset(
    {
        "nomic-embed-text",
        "nomic-embed-text:latest",
        "nomic-embed-text:v1.5",
        "nomic-embed-text-v1.5-GGUF",
        "user.nomic-embed-text-v1.5-GGUF",
    }
)


def resolve_embedding_model() -> str:
    """
    `EMBEDDING_MODEL` as given; else CI-Hub's `LLM_DEFAULT_EMBEDDING_MODEL` when it names the model
    the index is built with; else `nomic-embed-text`. An older Hub hands out Lemonade's v1, and
    embedding summaries with it would put a different vector space in the same column.
    """
    explicit = os.getenv("EMBEDDING_MODEL", "").strip()
    if explicit:
        return explicit

    handed_out = os.getenv("LLM_DEFAULT_EMBEDDING_MODEL", "").strip()
    if not handed_out or handed_out in NOMIC_V15_EMBED_NAMES:
        return handed_out or "nomic-embed-text"

    logger.error(
        "LLM_DEFAULT_EMBEDDING_MODEL=%s is not the model the index is built with; embedding with "
        "nomic-embed-text instead. Update CI-Hub, or set EMBEDDING_MODEL deliberately.",
        handed_out,
    )
    return "nomic-embed-text"


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
    # `auto` defers the choice to resolve_output_mode(), which asks the endpoint
    # what it is; that needs a network call, so it cannot happen here while
    # Settings is being built at import.
    explicit = os.getenv("SUMMARY_OUTPUT_MODE")
    return explicit.lower() if explicit else "auto"


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
    #   auto     — pick native or prompted from the endpoint (default; see
    #              resolve_output_mode)
    #   native   — json_schema response_format (server-enforced)
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
    embedding_model: str = Field(default_factory=resolve_embedding_model)
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


def _served_models() -> list[dict]:
    """Rows of the OpenAI-compatible endpoint's GET /models listing."""
    url = f"{settings.llm_api_base.rstrip('/')}/models"
    response = httpx.get(
        url, headers={"Authorization": f"Bearer {settings.llm_api_key}"}, timeout=10.0
    )
    response.raise_for_status()
    return [
        model
        for model in response.json().get("data", [])
        if isinstance(model, dict) and model.get("id")
    ]


def _is_served(model: str, served: list[str]) -> bool:
    # Ollama aliases a bare model name to its ":latest" tag, so treat
    # "name" as served when "name:latest" (or any "name:tag") is listed.
    return any(tag == model or tag.startswith(f"{model}:") for tag in served)


# Mirrors the API's domains/llm/services/servedModels.ts; keep the two in step.
# Tags naming a job other than chat. Lemonade publishes these on /models; every
# chat model it lists also carries `chat`, and a hand-registered one only
# `custom`, so a model is dropped only for a non-chat tag without `chat`.
_NON_CHAT_LABELS = frozenset(
    {
        "3d",
        "audio-generation",
        "classification",
        "edit",
        "embedding",
        "embeddings",
        "image",
        "realtime-transcription",
        "rerank",
        "reranking",
        "transcription",
        "tts",
        "upscaling",
        "voice-design",
    }
)
# For backends that publish no tags (vLLM, Ollama): name fragments of model
# families that never chat. Short on purpose; a false match hides a chat model.
_NON_CHAT_NAME = re.compile(
    r"embed|rerank|whisper|kokoro|minilm|(^|[^a-z0-9])(tts|bge)([^a-z0-9]|$)", re.I
)


def is_chat_model(row: dict) -> bool:
    """Whether a /models row can take a chat request."""
    model_id = str(row.get("id", ""))
    embedder = resolve_embedding_model()
    if model_id.removesuffix(":latest") == embedder.removesuffix(":latest"):
        return False

    labels = row.get("labels")
    labels = (
        [label for label in labels if isinstance(label, str)]
        if isinstance(labels, list)
        else []
    )
    if "chat" in labels:
        return True
    if any(label in _NON_CHAT_LABELS for label in labels):
        return False
    return not _NON_CHAT_NAME.search(model_id)


def _pick_chat_model(served: list[dict]) -> str | None:
    for row in served:
        if is_chat_model(row):
            return str(row["id"])
    return None


_resolved_output_mode: str | None = None


def resolve_output_mode() -> str:
    """
    The pydantic-ai output mode: SUMMARY_OUTPUT_MODE when set, else chosen from
    what the endpoint is.

    `native` (json_schema response_format, enforced while decoding) works on
    Ollama, llama.cpp and so Lemonade, and SGLang. vLLM stays on `prompted`, as
    it did under the port rule (402be25e2): it typically rejects json_schema, or
    accepts it and then thinks for minutes on the GPU. vLLM is recognised by `owned_by: "vllm"` on
    its /models rows, which CI-Hub's pool passes through, instead of by port:
    the old rule (anything but 11434 is prompted) put every backend behind the
    Hub pool, and Lemonade on 13305, on the weaker mode. Any other backend that
    refuses json_schema still falls back per call (llm_config.run_agent_sync).

    Cached once decided; an endpoint that cannot be read yet answers `native`
    for this call only and is asked again next time.
    """
    global _resolved_output_mode

    if _resolved_output_mode is not None:
        return _resolved_output_mode

    configured = (settings.output_mode or "auto").lower()
    if configured != "auto":
        _resolved_output_mode = configured
        return configured

    try:
        port = urlparse(settings.llm_api_base).port
    except ValueError:
        port = None
    if port == 11434:
        _resolved_output_mode = "native"
        return "native"

    try:
        rows = _served_models()
    except Exception as exc:
        logger.warning(
            "Could not list models at %s (%s); using native output mode for now.",
            settings.llm_api_base,
            exc,
        )
        return "native"

    is_vllm = any(str(row.get("owned_by", "")).lower() == "vllm" for row in rows)
    _resolved_output_mode = "prompted" if is_vllm else "native"
    return _resolved_output_mode


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
        rows = _served_models()
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

    served = [str(row["id"]) for row in rows]

    if configured:
        if _is_served(configured, served):
            return configured
        fallback = _pick_chat_model(rows)
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

    discovered = _pick_chat_model(rows)
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
