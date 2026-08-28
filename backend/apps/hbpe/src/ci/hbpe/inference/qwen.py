"""
Cluster labeler — on-device or Hub-resident LLM for behavioral labels.

Backends (first match wins):

  1. OpenAI-compatible HTTP (``LLM_API_BASE`` / ``HBPE_LABEL_API_BASE``)
     — Hub already serves Qwen3-8B via vLLM. Labeling goes through that
     endpoint so HBPE does not load a second 8B GGUF next to it.
  2. llama-cpp GGUF (``QWEN_GGUF_PATH`` or auto-download Qwen3.5-0.8B)
     — laptop / CI without a chat endpoint.

The singleton is lazy-loaded on first get_qwen() call (thread-safe).
"""

from __future__ import annotations

import json
import logging
import re
import threading
import urllib.error
import urllib.request
from typing import Protocol

from ci.hbpe.config import settings

log = logging.getLogger(__name__)

_LOCK: threading.Lock = threading.Lock()
_INSTANCE: LabelGenerator | None = None


class LabelGenerator(Protocol):
    def generate(
        self,
        user_message: str,
        system_message: str | None = None,
        max_new_tokens: int = 32,
    ) -> str: ...

    def batch_generate(
        self,
        prompts: list[tuple[str, str | None]],
        max_new_tokens: int = 32,
    ) -> list[str]: ...


class OpenAIChatLabeler:
    """OpenAI-compatible chat completions (vLLM, Ollama, llama.cpp server)."""

    def __init__(self, base_url: str, model: str, api_key: str = "") -> None:
        self._base = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key or "not-needed"
        self._gen_lock = threading.Lock()
        log.info("HBPE labeler using chat API %s model=%s", self._base, self._model)

    def generate(
        self,
        user_message: str,
        system_message: str | None = None,
        max_new_tokens: int = 32,
    ) -> str:
        max_tokens = max_new_tokens
        system = system_message or ""
        if settings.qwen_disable_thinking:
            # Never append /no_think to the user turn — the 0.8B labeler
            # echoed that token as an L1 name (No_think). Keep it off the
            # label surface; ask for JSON only in the system turn.
            system = (system + " Do not reason. Output a JSON object only.").strip()
            max_tokens = min(max_new_tokens, settings.qwen_max_tokens_no_think)

        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user_message})

        payload = {
            "model": self._model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.15,
        }
        if settings.qwen_disable_thinking:
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
            method="POST",
        )
        with self._gen_lock:
            try:
                with urllib.request.urlopen(
                    req, timeout=settings.label_http_timeout_seconds
                ) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
            except urllib.error.URLError as exc:
                log.warning("Label chat API failed: %s", exc)
                raise

        raw = (
            payload.get("choices", [{}])[0].get("message", {}).get("content", "") or ""
        ).strip()
        stripped = _strip_thinking(raw)
        log.debug("RAW OUTPUT: %r", raw[:500])
        log.debug("STRIPPED:   %r", stripped[:200])
        return stripped

    def batch_generate(
        self,
        prompts: list[tuple[str, str | None]],
        max_new_tokens: int = 32,
    ) -> list[str]:
        return [
            self.generate(user_msg, sys_msg, max_new_tokens)
            for user_msg, sys_msg in prompts
        ]


class QwenModel:
    """
    Thin wrapper around a llama-cpp-python Llama instance.

    All generation uses temperature=0.15 for consistent labels.
    Pure greedy (temp=0) causes small models to degenerate — snapping to the
    first listed class on every call.  0.15 breaks the degeneracy while keeping
    outputs stable across runs.
    n_gpu_layers=-1 offloads every layer to GPU (Metal / HIPBLAS).
    """

    def __init__(self, model_path: str) -> None:
        from llama_cpp import Llama

        log.info("Loading Qwen GGUF: %s", model_path)
        self._llm = Llama(
            model_path=model_path,
            n_ctx=2048,
            n_gpu_layers=-1,  # full GPU offload — Metal on M-series, HIPBLAS on ROCm
            verbose=False,
        )
        # A single llama.cpp context is NOT thread-safe: concurrent
        # create_chat_completion() calls interleave decodes on the shared KV
        # cache, corrupting it ("find_slot: non-consecutive token position …")
        # and aborting the process via GGML_ASSERT. This singleton is reached
        # from multiple Temporal activity threads (overlapping users, or a
        # timed-out attempt still draining while a retry starts), so every
        # generation must hold this lock.
        self._gen_lock = threading.Lock()
        log.info("Qwen GGUF loaded")

    def generate(
        self,
        user_message: str,
        system_message: str | None = None,
        max_new_tokens: int = 32,
    ) -> str:
        """Single chat completion, greedy decoding."""
        max_tokens = max_new_tokens
        system = system_message or ""
        if settings.qwen_disable_thinking:
            system = (system + " Do not reason. Output a JSON object only.").strip()
            max_tokens = min(max_new_tokens, settings.qwen_max_tokens_no_think)

        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user_message})

        with self._gen_lock:
            result = self._llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=0.15,
            )
        raw = result["choices"][0]["message"]["content"].strip()
        # Qwen3.5 is a thinking model — strip <think>…</think> so _parse_json
        # sees only the final answer, not the in-progress reasoning.
        stripped = _strip_thinking(raw)
        log.debug("RAW OUTPUT: %r", raw[:500])
        log.debug("STRIPPED:   %r", stripped[:200])
        return stripped

    def batch_generate(
        self,
        prompts: list[tuple[str, str | None]],
        max_new_tokens: int = 32,
    ) -> list[str]:
        """
        Run generate() for each (user_msg, system_msg) pair.

        llama-cpp-python's Python API doesn't expose batched chat completions,
        but per-call latency at ~200 tok/s on Metal is fast enough that serial
        is fine: a batch of 32 items costs ~5 seconds end-to-end.
        """
        return [
            self.generate(user_msg, sys_msg, max_new_tokens)
            for user_msg, sys_msg in prompts
        ]


def _resolve_model_path() -> str:
    """
    Return the local GGUF path, downloading from HuggingFace if needed.

    Priority:
      1. QWEN_GGUF_PATH env var / settings.qwen_gguf_path  (explicit local path)
      2. Auto-download via huggingface_hub to the models dir
    """
    explicit = settings.qwen_gguf_path
    if explicit:
        return explicit

    import os

    from huggingface_hub import hf_hub_download
    from huggingface_hub.utils import LocalEntryNotFoundError

    cache_dir = os.path.join(settings.models_dir, "qwen")
    os.makedirs(cache_dir, exist_ok=True)

    kwargs = dict(
        repo_id=settings.qwen_gguf_repo,
        filename=settings.qwen_gguf_file,
        cache_dir=cache_dir,
    )
    try:
        # Prefer fully offline resolution if the file is already cached.
        return hf_hub_download(**kwargs, local_files_only=True)
    except LocalEntryNotFoundError:
        # Not cached yet — download from HuggingFace.
        return hf_hub_download(**kwargs)


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _strip_thinking(text: str) -> str:
    """Remove Qwen3 chain-of-thought blocks before the final answer is parsed."""
    return _THINK_RE.sub("", text).strip()


def reset_qwen_for_tests() -> None:
    """Drop the process singleton so tests can switch backends."""
    global _INSTANCE
    _INSTANCE = None


def get_qwen() -> LabelGenerator:
    """Return the process-level labeler singleton (lazy-initialised, thread-safe)."""
    global _INSTANCE
    if _INSTANCE is None:
        with _LOCK:
            if _INSTANCE is None:
                _INSTANCE = _build_labeler()
    return _INSTANCE


def _build_labeler() -> LabelGenerator:
    base = (settings.label_api_base or "").strip()
    model = (settings.label_chat_model or "").strip()
    if base and model:
        return OpenAIChatLabeler(base, model, settings.label_api_key)
    if base and not model:
        log.warning(
            "LLM_API_BASE is set but LLM_DEFAULT_CHAT_MODEL is empty — "
            "falling back to GGUF labeler"
        )
    return QwenModel(_resolve_model_path())
