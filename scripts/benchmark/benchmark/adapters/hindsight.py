"""Hindsight adapter — `vectorize-io/hindsight` retain/recall/reflect server.

Hindsight is a self-hostable agent memory system that supports local LLM
providers, so it slots into the benchmark without a translating proxy. Install
the client and run the server before invoking the adapter:

    pip install -U hindsight-client
    docker run -d --name hindsight -p 8888:8888 -p 9999:9999 \\
      ghcr.io/vectorize-io/hindsight:latest

Server lifecycle quirks worth knowing about:

- ``retain_async=False`` extracts synchronously, but a background consolidation
  worker keeps merging memories for a few seconds after each call. :meth:`flush`
  polls a broad recall until the result count is stable across two probes,
  matching the spike branch's empirical wait condition.
- The SDK's teardown surface drifts across versions; we try a handful of method
  names (``delete_bank`` / ``forget`` / ``delete``) and tolerate ``AttributeError``.

Env (all optional):
  HINDSIGHT_BASE_URL   default http://localhost:8888
  HINDSIGHT_BUDGET     low|mid|high (default ``high``)
  HINDSIGHT_MAX_TOKENS recall token budget (default 4096)
  HINDSIGHT_TIMEOUT    per-call timeout seconds (default 180)
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Any

from .base import MemoryAdapter

_DEFAULT_BASE_URL = "http://localhost:8888"
_DEFAULT_BUDGET = "high"
_DEFAULT_MAX_TOKENS = 4096
_DEFAULT_TIMEOUT = 180.0
_FLUSH_PROBE = "what do you know about the user"
_FLUSH_BUDGET_TOKENS = 4096
_FLUSH_DEADLINE_SEC = 120
_FLUSH_POLL_SEC = 5.0
_FLUSH_STABLE_ROUNDS = 2


class HindsightAdapter(MemoryAdapter):
    def __init__(
        self,
        base_url: str | None = None,
        budget: str | None = None,
        max_tokens: int | None = None,
        timeout: float | None = None,
        *,
        client_factory: Callable[[str, float], Any] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        bank_id: str | None = None,
    ) -> None:
        self._base_url = base_url or os.environ.get(
            "HINDSIGHT_BASE_URL", _DEFAULT_BASE_URL
        )
        self._budget = budget or os.environ.get("HINDSIGHT_BUDGET", _DEFAULT_BUDGET)
        self._max_tokens = max_tokens or int(
            os.environ.get("HINDSIGHT_MAX_TOKENS", str(_DEFAULT_MAX_TOKENS))
        )
        self._timeout = timeout or float(
            os.environ.get("HINDSIGHT_TIMEOUT", str(_DEFAULT_TIMEOUT))
        )
        # Injection seams used by tests; production code falls back to the real
        # SDK + time.sleep.
        self._client_factory = client_factory
        self._sleep = sleep
        # A test or a caller that wants reproducible bank ids can pin one; the
        # default randomises so successive runs don't share state on the server.
        self._bank_override = bank_id
        self._client: Any = None
        self._bank = ""

    @property
    def name(self) -> str:
        return "hindsight"

    # ── lifecycle ────────────────────────────────────────────────────────────

    def setup(self, user_id: str) -> None:
        factory = self._client_factory or self._default_client_factory
        self._client = factory(self._base_url, self._timeout)
        self._bank = self._bank_override or f"bench_{user_id}_{os.urandom(4).hex()}"

    def ingest(self, text: str, session_id: str) -> None:
        if self._client is None:
            raise RuntimeError("setup() must be called before ingest()")
        self._client.retain(
            bank_id=self._bank,
            content=text,
            document_id=session_id,
            retain_async=False,
        )

    def flush(self) -> None:
        """Poll a probe recall until the result count is stable for two rounds."""
        if self._client is None:
            return
        deadline = time.monotonic() + _FLUSH_DEADLINE_SEC
        last = -1
        stable = 0
        while time.monotonic() < deadline:
            try:
                resp = self._client.recall(
                    bank_id=self._bank,
                    query=_FLUSH_PROBE,
                    max_tokens=_FLUSH_BUDGET_TOKENS,
                    budget="high",
                )
                n = len(_results(resp))
            except Exception:
                n = last
            if n == last:
                stable += 1
                if stable >= _FLUSH_STABLE_ROUNDS:
                    return
            else:
                stable = 0
                last = n
            self._sleep(_FLUSH_POLL_SEC)

    def search(self, query: str) -> str:
        if self._client is None:
            raise RuntimeError("setup() must be called before search()")
        resp = self._client.recall(
            bank_id=self._bank,
            query=query,
            max_tokens=self._max_tokens,
            budget=self._budget,
        )
        results = _results(resp)
        chunks: list[str] = []
        for r in results:
            text = getattr(r, "text", None)
            if text is None and isinstance(r, dict):
                text = r.get("text", "")
            if text:
                chunks.append(text)
        return "\n\n".join(chunks)

    def teardown(self) -> None:
        client = self._client
        if client is None:
            return
        # Try the SDK's known cleanup shapes; ignore failures because a fresh
        # randomised bank id already isolates the next run.
        for attr in ("delete_bank", "forget", "delete"):
            fn = getattr(client, attr, None)
            if callable(fn):
                try:
                    fn(bank_id=self._bank)
                    break
                except Exception:
                    pass
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
        self._client = None

    # ── default factory ─────────────────────────────────────────────────────

    @staticmethod
    def _default_client_factory(base_url: str, timeout: float) -> Any:
        try:
            from hindsight_client import Hindsight  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "hindsight-client is not installed. Run: pip install -U hindsight-client"
            ) from exc
        return Hindsight(base_url=base_url, timeout=timeout)


def _results(resp: Any) -> list:
    """Hindsight's response shape drifts across SDK versions; tolerate both."""
    results = getattr(resp, "results", None)
    if results is None and isinstance(resp, dict):
        results = resp.get("results", [])
    return list(results or [])
