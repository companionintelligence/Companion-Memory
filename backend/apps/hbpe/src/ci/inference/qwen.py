"""
Qwen labeler — on-device LLM for behavioral label generation.

Uses llama-cpp-python (GGUF) rather than HuggingFace transformers so the
same code path runs efficiently on all three hardware targets:

  - Apple Silicon (M-series): Metal GPU via llama.cpp's Metal backend
  - ROCm (AMD GPU, prod):     HIPBLAS via llama-cpp-python compiled with
                              CMAKE_ARGS="-DGGML_HIPBLAS=ON"
  - CPU fallback:             pure C++ — still faster than transformers
                              on Qwen3.5's DeltaNet hybrid attention

Model: Qwen3.5-0.8B Q8_0 GGUF  (~800 MB, public — no HF token required)
  Configurable via QWEN_GGUF_PATH env var (absolute path) or auto-downloaded
  from QWEN_GGUF_REPO + QWEN_GGUF_FILE via huggingface_hub.

The singleton is lazy-loaded on first get_qwen() call (thread-safe).
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Optional

from ci.config import settings

log = logging.getLogger(__name__)

_LOCK: threading.Lock = threading.Lock()
_INSTANCE: Optional["QwenModel"] = None


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
            n_gpu_layers=-1,    # full GPU offload — Metal on M-series, HIPBLAS on ROCm
            verbose=False,
        )
        log.info("Qwen GGUF loaded")

    def generate(
        self,
        user_message: str,
        system_message: Optional[str] = None,
        max_new_tokens: int = 32,
    ) -> str:
        """Single chat completion, greedy decoding."""
        messages: list[dict] = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": user_message})

        result = self._llm.create_chat_completion(
            messages=messages,
            max_tokens=max_new_tokens,
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
        prompts: list[tuple[str, Optional[str]]],
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

    from huggingface_hub import hf_hub_download
    from huggingface_hub.utils import LocalEntryNotFoundError
    import os

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


def get_qwen() -> QwenModel:
    """Return the process-level QwenModel singleton (lazy-initialised, thread-safe)."""
    global _INSTANCE
    if _INSTANCE is None:
        with _LOCK:
            if _INSTANCE is None:
                _INSTANCE = QwenModel(_resolve_model_path())
    return _INSTANCE
