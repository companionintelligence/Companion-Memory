"""
OpenAI-compatible LLM client for HBPE event/summary labeling.

Production deployments route through the shared vLLM endpoint
(LLM_API_BASE / LLM_DEFAULT_CHAT_MODEL), matching the API chat and summary
services. Local dev without an endpoint can still fall back to on-device GGUF
via get_qwen() in qwen.py.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from functools import lru_cache

import httpx

from ci.hbpe.config import settings

log = logging.getLogger(__name__)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _strip_thinking(text: str) -> str:
    return _THINK_RE.sub("", text).strip()


def _llm_model_from_env() -> str:
    return (
        os.getenv("HBPE_LLM_MODEL")
        or os.getenv("LLM_DEFAULT_CHAT_MODEL")
        or os.getenv("LLM_MODEL")
        or ""
    )


def _served_model_ids(base_url: str, api_key: str) -> list[str]:
    url = f"{base_url.rstrip('/')}/models"
    response = httpx.get(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=10.0,
    )
    response.raise_for_status()
    return [model["id"] for model in response.json().get("data", []) if model.get("id")]


def _is_served(model: str, served: list[str]) -> bool:
    return any(tag == model or tag.startswith(f"{model}:") for tag in served)


def _pick_chat_model(served: list[str]) -> str | None:
    for tag in served:
        if "embed" not in tag.lower():
            return tag
    return None


@lru_cache(maxsize=1)
def resolve_llm_model() -> str:
    """Resolve the chat model id against the configured OpenAI-compatible endpoint."""
    configured = _llm_model_from_env()
    base_url = settings.llm_api_base.rstrip("/")
    api_key = settings.llm_api_key or "vllm-local"

    try:
        served = _served_model_ids(base_url, api_key)
    except Exception as exc:
        if configured:
            log.warning(
                "Could not list models at %s (%s); using configured model %r unvalidated.",
                base_url,
                exc,
                configured,
            )
            return configured
        raise RuntimeError(
            f"No LLM model configured and model discovery at {base_url} failed ({exc}). "
            "Set LLM_DEFAULT_CHAT_MODEL or make the endpoint reachable."
        ) from exc

    if configured:
        if _is_served(configured, served):
            return configured
        fallback = _pick_chat_model(served)
        if fallback:
            log.warning(
                "Configured model %r is not served by %s; using %r instead.",
                configured,
                base_url,
                fallback,
            )
            return fallback
        return configured

    discovered = _pick_chat_model(served)
    if not discovered:
        raise RuntimeError(f"No chat model available at {base_url}")
    log.info("Discovered HBPE label model %r from %s", discovered, base_url)
    return discovered


class OpenAILabelModel:
    """HBPE labeler backed by an OpenAI-compatible chat completions API (vLLM)."""

    def __init__(self) -> None:
        self.base_url = settings.llm_api_base.rstrip("/")
        self.api_key = settings.llm_api_key or "vllm-local"
        self.model = resolve_llm_model()
        self._client = httpx.Client(timeout=180.0)
        self._gen_lock = threading.Lock()
        log.info(
            "HBPE labeler using OpenAI-compatible API at %s (model=%s)",
            self.base_url,
            self.model,
        )

    def generate(
        self,
        user_message: str,
        system_message: str | None = None,
        max_new_tokens: int = 32,
    ) -> str:
        max_tokens = max_new_tokens
        if settings.qwen_disable_thinking:
            user_message = f"{user_message} /no_think"
            max_tokens = min(max_new_tokens, settings.qwen_max_tokens_no_think)

        messages: list[dict[str, str]] = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": user_message})

        payload: dict = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.15,
        }
        if settings.qwen_disable_thinking:
            payload["chat_template_kwargs"] = {"enable_thinking": False}

        with self._gen_lock:
            response = self._client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=payload,
            )
            response.raise_for_status()
            message = response.json()["choices"][0]["message"]
            raw = message.get("content") or message.get("reasoning") or ""
            raw = str(raw).strip()

        return _strip_thinking(raw)

    def batch_generate(
        self,
        prompts: list[tuple[str, str | None]],
        max_new_tokens: int = 32,
    ) -> list[str]:
        return [
            self.generate(user_msg, sys_msg, max_new_tokens)
            for user_msg, sys_msg in prompts
        ]
