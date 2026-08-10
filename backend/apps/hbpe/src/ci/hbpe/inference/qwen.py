"""
Qwen labeler — behavioral label generation for HBPE.

Production uses the shared vLLM OpenAI-compatible endpoint (LLM_API_BASE).
When no endpoint is configured, falls back to on-device Qwen3.5-0.8B GGUF via
llama-cpp-python for local development.
"""

from __future__ import annotations

import logging
import re
import threading

from ci.hbpe.config import settings

log = logging.getLogger(__name__)

_LOCK: threading.Lock = threading.Lock()
_INSTANCE: QwenModel | None = None


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
        if settings.qwen_disable_thinking:
            # Qwen3.x reads the `/no_think` soft switch from the user turn and
            # skips the <think> reasoning block. A label is a 1-3 word JSON
            # object — nothing to reason about — and the CoT tokens dominate CPU
            # cost, so we suppress them and cap output hard. (_strip_thinking
            # below is a safety net if a given GGUF template ignores the switch.)
            user_message = f"{user_message} /no_think"
            max_tokens = min(max_new_tokens, settings.qwen_max_tokens_no_think)

        messages: list[dict] = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
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


def get_qwen() -> QwenModel | object:
    """Return the process-level labeler singleton (lazy-initialised, thread-safe)."""
    global _INSTANCE
    if _INSTANCE is None:
        with _LOCK:
            if _INSTANCE is None:
                from ci.hbpe.config import use_vllm_backend

                if use_vllm_backend():
                    from ci.hbpe.inference.llm_client import OpenAILabelModel

                    _INSTANCE = OpenAILabelModel()
                else:
                    _INSTANCE = QwenModel(_resolve_model_path())
    return _INSTANCE
