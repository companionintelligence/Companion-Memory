"""
Qwen instruct model singleton — on-device LLM for label generation.

Uses the HuggingFace chat template so the model receives proper system +
user messages and follows JSON format instructions reliably.

Default model: Qwen/Qwen3.5-0.8B
  - Hybrid DeltaNet + standard attention (instruct / post-trained)
  - Supports thinking and non-thinking mode; we use non-thinking (enable_thinking=False)
  - Runs on CPU; fast path requires flash-linear-attention + causal-conv1d (CUDA)
  Configurable via settings.qwen_model_name or QWEN_MODEL_NAME env var.

The model is lazy-loaded on first call to get_qwen() and shared across
all callers in the process (thread-safe via a double-checked lock).
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

import torch

from ci.config import settings

log = logging.getLogger(__name__)

_LOCK: threading.Lock = threading.Lock()
_INSTANCE: Optional["QwenModel"] = None


class QwenModel:
    """
    Wrapper around a Qwen instruct model for chat-based label generation.

    Uses greedy decoding (do_sample=False) for deterministic, reproducible
    labels.  device_map="auto" supports CPU, MPS, and CUDA transparently.
    """

    def __init__(self, model_name: str) -> None:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.model_name = model_name
        log.info("Loading model: %s", model_name)

        self.tokenizer = AutoTokenizer.from_pretrained(
            model_name,
            trust_remote_code=True,
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name,
            torch_dtype="auto",
            device_map="auto",
            trust_remote_code=True,
        )
        self.model.eval()
        self._device = next(self.model.parameters()).device
        log.info("Model loaded on device: %s", self._device)

    def generate(
        self,
        user_message: str,
        system_message: Optional[str] = None,
        max_new_tokens: int = 80,
    ) -> str:
        """
        Generate a response for a chat-style exchange using greedy decoding.

        Builds a messages list, applies the tokenizer's chat template, then
        decodes only the newly generated tokens.  The caller is responsible
        for prompt content; this method handles tokenisation and generation.
        """
        messages = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": user_message})

        # apply_chat_template may return a plain tensor or a BatchEncoding
        # depending on the transformers version and tokenizer implementation.
        try:
            tokenized = self.tokenizer.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
                enable_thinking=False,   # suppress <think> blocks on Qwen3 thinking models
            )
        except TypeError:
            # enable_thinking not supported on this tokenizer (e.g. Qwen2)
            tokenized = self.tokenizer.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
            )

        # Normalise to a plain input_ids tensor + optional attention_mask
        if hasattr(tokenized, "input_ids"):
            # BatchEncoding — newer transformers versions
            input_ids = tokenized.input_ids.to(self._device)
            attention_mask = tokenized.get("attention_mask")
            if attention_mask is not None:
                attention_mask = attention_mask.to(self._device)
        else:
            input_ids = tokenized.to(self._device)
            attention_mask = None

        pad_id = (
            self.tokenizer.eos_token_id
            if self.tokenizer.pad_token_id is None
            else self.tokenizer.pad_token_id
        )

        gen_kwargs: dict = dict(
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=pad_id,
        )
        if attention_mask is not None:
            gen_kwargs["attention_mask"] = attention_mask

        with torch.no_grad():
            output_ids = self.model.generate(input_ids, **gen_kwargs)

        new_ids = output_ids[0][input_ids.shape[-1]:]
        return self.tokenizer.decode(new_ids, skip_special_tokens=True).strip()


def get_qwen() -> QwenModel:
    """Return the process-level QwenModel singleton (lazy-initialised, thread-safe)."""
    global _INSTANCE
    if _INSTANCE is None:
        with _LOCK:
            if _INSTANCE is None:
                _INSTANCE = QwenModel(settings.qwen_model_name)
    return _INSTANCE
