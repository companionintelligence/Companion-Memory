"""
Cluster labeler — on-device or Hub-resident LLM for behavioral labels.

Backends (first match wins):

  1. OpenAI-compatible HTTP (``LLM_API_BASE`` / ``HBPE_LABEL_API_BASE``)
     — Hub already serves Qwen3-8B via vLLM. Labeling goes through that
     endpoint so HBPE does not load a second 8B GGUF next to it.
  2. llama-cpp GGUF (``QWEN_GGUF_PATH`` or auto-download Qwen3.5-0.8B)
     — laptop / CI without a chat endpoint.

The singleton is lazy-loaded on first get_qwen() call (thread-safe).

The GGUF fallback is meant to be temporary, and two things keep it from
becoming a permanent GPU tenant next to the inference server it stood in for:

  * while the fallback is active, get_qwen() re-probes the configured chat
    endpoint every ``HBPE_LABEL_REPROBE_SECONDS`` and swaps back to it the
    moment it answers, closing the GGUF and returning its VRAM;
  * the GGUF processes prompts in small fixed batches and is rebuilt every
    ``QWEN_GGUF_RECYCLE_CALLS`` completions. llama.cpp's HIP scratch pool
    keeps every distinct-size buffer it ever handed out, and labeling prompts
    differ per event, so an unbounded batch grew VRAM by ~0.5 MiB per
    completion for a whole day (4.4 GiB observed 2026-09-10). Fixed 64-token
    chunks measured flat after warm-up; rebuilding the instance frees the pool
    outright.
"""

from __future__ import annotations

import gc
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Protocol

from ci.hbpe.config import settings
from ci.hbpe.label_yield import wait_for_chat_idle

log = logging.getLogger(__name__)

_LOCK: threading.Lock = threading.Lock()
_INSTANCE: LabelGenerator | None = None
# time.monotonic() of the last chat-endpoint probe. Only meaningful while the
# GGUF fallback is the active instance; see _reprobe_due().
_LAST_PROBE_AT: float = 0.0

# A re-probe runs on the labeling thread between two events, so it is bounded
# separately from the generation timeout: a live endpoint answers /models in
# milliseconds, and waiting the full label timeout for a dead one would stall
# the drain for minutes every interval.
_REPROBE_TIMEOUT_SECONDS = 10.0


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
            # The runner behind this endpoint is the one chat uses. Stand aside
            # while a person is waiting on it; see label_yield.py for why.
            wait_for_chat_idle()
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

    The instance is rebuilt every ``settings.qwen_gguf_recycle_calls``
    completions and prompts are fed in ``settings.qwen_gguf_batch``-token
    chunks — both bound the GPU scratch pool, see the module docstring.
    """

    def __init__(self, model_path: str) -> None:
        self._model_path = model_path
        # A single llama.cpp context is NOT thread-safe: concurrent
        # create_chat_completion() calls interleave decodes on the shared KV
        # cache, corrupting it ("find_slot: non-consecutive token position …")
        # and aborting the process via GGML_ASSERT. This singleton is reached
        # from multiple threads (overlapping users, or a timed-out attempt
        # still draining while a retry starts), so every generation — and
        # every reload or close — must hold this lock.
        self._gen_lock = threading.Lock()
        self._completions = 0  # since the current context was loaded
        self._closed = False
        self._llm = self._load()

    def _load(self):
        from llama_cpp import Llama

        batch = max(1, int(settings.qwen_gguf_batch))
        log.info("Loading Qwen GGUF: %s (batch=%d)", self._model_path, batch)
        llm = Llama(
            model_path=self._model_path,
            n_ctx=2048,
            # Fixed small chunks so the backend's scratch buffers come in a
            # handful of sizes instead of one per prompt length.
            n_batch=batch,
            n_ubatch=batch,
            n_gpu_layers=-1,  # full GPU offload — Metal on M-series, HIPBLAS on ROCm
            verbose=False,
        )
        log.info("Qwen GGUF loaded")
        return llm

    def _release_locked(self) -> None:
        """Drop the llama.cpp context and its GPU memory. Caller holds _gen_lock."""
        llm, self._llm = self._llm, None
        if llm is None:
            return
        close = getattr(llm, "close", None)
        if callable(close):
            close()
        del llm
        gc.collect()

    def _recycle_locked(self) -> None:
        """Release the context BEFORE loading its replacement.

        Order matters on a shared card: the old context's pool is what makes
        room for the new one, and on a full card the reverse order fails to
        load at all.
        """
        log.info(
            "Recycling GGUF labeler after %d completions to release its GPU scratch pool",
            self._completions,
        )
        self._release_locked()
        self._completions = 0
        self._llm = self._load()

    def close(self) -> None:
        """Release the model for good; further generate() calls raise."""
        with self._gen_lock:
            self._closed = True
            self._release_locked()

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
            if self._closed:
                raise RuntimeError("GGUF labeler has been closed")
            recycle_after = int(settings.qwen_gguf_recycle_calls)
            if self._llm is not None and 0 < recycle_after <= self._completions:
                self._recycle_locked()
            if self._llm is None:
                # A previous reload failed part-way; try again rather than
                # staying dead for the rest of the process.
                self._llm = self._load()
                self._completions = 0
            result = self._llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=0.15,
            )
            self._completions += 1
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
    global _INSTANCE, _LAST_PROBE_AT
    _INSTANCE = None
    _LAST_PROBE_AT = 0.0


def get_qwen() -> LabelGenerator:
    """Return the process-level labeler singleton (lazy-initialised, thread-safe).

    While the GGUF fallback is active this also re-probes the configured chat
    endpoint on an interval and swaps back to it once it answers, so a
    transient outage at startup (or a firewall fixed hours later) does not
    leave a second model on the GPU for the life of the process.
    """
    global _INSTANCE, _LAST_PROBE_AT
    if _INSTANCE is None:
        with _LOCK:
            if _INSTANCE is None:
                _INSTANCE = _build_labeler()
                _LAST_PROBE_AT = time.monotonic()
    elif _reprobe_due():
        with _LOCK:
            if _reprobe_due():
                _try_switch_back_locked()
    return _INSTANCE


def _configured_endpoint() -> tuple[str, str] | None:
    """(base, model) when both are set, else None — the chat backend's contract."""
    base = (settings.label_api_base or "").strip()
    model = (settings.label_chat_model or "").strip()
    if base and model:
        return base, model
    return None


def _reprobe_due() -> bool:
    interval = float(settings.label_endpoint_reprobe_seconds or 0)
    if interval <= 0 or _configured_endpoint() is None:
        return False
    if not isinstance(_INSTANCE, QwenModel):
        return False
    return time.monotonic() - _LAST_PROBE_AT >= interval


def _try_switch_back_locked() -> None:
    """Probe the chat endpoint; on success replace the GGUF fallback with it.

    Caller holds _LOCK. The GGUF is closed only after the new instance is in
    place, and close() takes the generation lock, so a completion already in
    flight on the old instance finishes before its context is torn down.
    """
    global _INSTANCE, _LAST_PROBE_AT
    _LAST_PROBE_AT = time.monotonic()
    endpoint = _configured_endpoint()
    if endpoint is None:
        return
    base, model = endpoint
    timeout = min(
        settings.label_http_timeout_seconds or _REPROBE_TIMEOUT_SECONDS,
        _REPROBE_TIMEOUT_SECONDS,
    )
    if not _endpoint_reachable(base, timeout):
        log.debug("HBPE label endpoint %s still unreachable; staying on GGUF", base)
        return
    old, _INSTANCE = _INSTANCE, OpenAIChatLabeler(base, model, settings.label_api_key)
    log.warning(
        "HBPE label endpoint %s is reachable again — switching back from the "
        "GGUF labeler and releasing it",
        base,
    )
    close = getattr(old, "close", None)
    if callable(close):
        close()


def _endpoint_reachable(base: str, timeout: float) -> bool:
    """
    Can we open a connection to this chat endpoint at all?

    Deliberately treats an HTTP error response as REACHABLE. A 401, 403 or 404
    means a server answered, which is all this probe is asking; auth and route
    shape are the caller's problem, and demoting a live endpoint to the GGUF
    fallback over a missing ``/models`` route would be a worse mistake than the
    one this function exists to catch.
    """
    try:
        req = urllib.request.Request(f"{base.rstrip('/')}/models", method="GET")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except urllib.error.HTTPError:
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _build_labeler() -> LabelGenerator:
    base = (settings.label_api_base or "").strip()
    model = (settings.label_chat_model or "").strip()
    if _configured_endpoint() is not None:
        # Probe before committing. This singleton is built once per process and
        # never rebuilt, so choosing an unreachable endpoint kills labeling for
        # the life of the service: every label_event raises URLError, the drain
        # logs a warning per event and burns its whole multi-hour budget writing
        # nothing, and the forecast can never fill. There is a working GGUF
        # labeler right here — not using it because one env var points somewhere
        # unreachable is the worst of the available outcomes.
        #
        # Not hypothetical. A localhost URL is correct for the host-run API and
        # wrong for every containerised consumer, where localhost is the
        # container itself; .env.default ships host.docker.internal for exactly
        # this reason, but a local override is invisible until labeling silently
        # stops. Observed live 2026-08-30: LLM_API_BASE=http://localhost:11434/v1
        # inside hbpe-service, connection refused on every event, 0 labels
        # written across a full run.
        #
        # "Never rebuilt" is no longer quite true: get_qwen() re-probes on an
        # interval while the fallback is active and switches back (see
        # _try_switch_back_locked). The initial choice still matters because
        # the fallback owns the GPU until then.
        if _endpoint_reachable(base, settings.label_http_timeout_seconds or 10.0):
            return OpenAIChatLabeler(base, model, settings.label_api_key)
        log.error(
            "HBPE label endpoint %s is unreachable — falling back to the GGUF "
            "labeler. Inside a container, localhost is the container itself; "
            "use host.docker.internal to reach an LLM on the host.",
            base,
        )
    elif base and not model:
        log.warning(
            "LLM_API_BASE is set but LLM_DEFAULT_CHAT_MODEL is empty — "
            "falling back to GGUF labeler"
        )
    return QwenModel(_resolve_model_path())
