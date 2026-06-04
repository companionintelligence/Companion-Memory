"""
Hindsight memory adapter — github.com/vectorize-io/hindsight (MIT).

Hindsight is a self-hostable agent memory system (retain / recall / reflect)
that natively supports local LLM providers, so it slots into the fair
same-model comparison without a translating proxy: the server is configured to
talk to the same LM Studio gemma model CI-Server / Mem0 use.

Run the server (once), pointed at the same model:

  docker run -d --name hindsight -p 8888:8888 -p 9999:9999 \
    -e HINDSIGHT_API_LLM_PROVIDER=lmstudio \
    -e HINDSIGHT_API_LLM_BASE_URL=http://192.168.0.203:1234/v1 \
    -e HINDSIGHT_API_LLM_MODEL=gemma-4-31b-it-abliterated \
    -e HINDSIGHT_API_LLM_MAX_CONCURRENT=1 \
    -v $HOME/.hindsight-docker:/home/hindsight/.pg0 \
    ghcr.io/vectorize-io/hindsight:latest

Note: Hindsight's embedder defaults to a local BAAI/bge-small model, not the
nomic-embed-text the other systems share — a minor confound, flagged in the
report discussion. The LLM (the dominant factor) is held constant.

Env vars:
  HINDSIGHT_BASE_URL   — default http://localhost:8888
  HINDSIGHT_BUDGET     — recall budget: low|mid|high (default high)
  HINDSIGHT_MAX_TOKENS — recall token budget (default 4096)
  HINDSIGHT_TIMEOUT    — per-call timeout seconds (default 180)
"""

from __future__ import annotations

import os
from typing import Optional

from .base import MemoryAdapter


class HindsightAdapter(MemoryAdapter):
    def __init__(
        self,
        base_url: Optional[str] = None,
        budget: Optional[str] = None,
        max_tokens: Optional[int] = None,
        timeout: Optional[float] = None,
    ):
        self._base_url = base_url or os.environ.get("HINDSIGHT_BASE_URL", "http://localhost:8888")
        self._budget = budget or os.environ.get("HINDSIGHT_BUDGET", "high")
        self._max_tokens = max_tokens or int(os.environ.get("HINDSIGHT_MAX_TOKENS", "4096"))
        self._timeout = timeout or float(os.environ.get("HINDSIGHT_TIMEOUT", "180"))
        self._client: object = None
        self._bank: str = ""

    @property
    def name(self) -> str:
        return "Hindsight (retain/recall)"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def setup(self, user_id: str) -> None:
        try:
            from hindsight_client import Hindsight  # type: ignore[import]
        except ImportError as exc:
            raise ImportError(
                "hindsight-client is not installed. Run: pip install -U hindsight-client"
            ) from exc

        self._client = Hindsight(base_url=self._base_url, timeout=self._timeout)
        # Fresh bank per process run so repeated benchmarks don't accumulate.
        self._bank = f"bench_{user_id}_{os.urandom(4).hex()}"

    def teardown(self) -> None:
        # Best-effort bank cleanup; the SDK surface varies by version, so try a
        # couple of known shapes and ignore failures (fresh bank id per run
        # already prevents cross-run contamination).
        client = self._client
        if client is None:
            return
        for attr in ("delete_bank", "forget", "delete"):
            fn = getattr(client, attr, None)
            if callable(fn):
                try:
                    fn(bank_id=self._bank)
                    break
                except Exception:
                    pass
        # Close the underlying HTTP session if the SDK exposes it (silences
        # aiohttp "Unclosed client session" warnings).
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
        self._client = None

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def ingest(self, text: str, session_id: str) -> None:
        if self._client is None:
            raise RuntimeError("setup() must be called before ingest()")
        # retain_async=False → server extracts synchronously, so recall sees it
        # without a separate flush wait.
        self._client.retain(  # type: ignore[union-attr]
            bank_id=self._bank,
            content=text,
            document_id=session_id,
            retain_async=False,
        )

    def flush(self) -> None:
        """Wait for Hindsight's async consolidation to settle.

        Even with retain_async=False, the server runs a background consolidation
        worker that keeps adding/merging memories for a few seconds after the
        retain calls return. Poll a broad recall until the result count stops
        growing so eval doesn't race ahead of consolidation.
        """
        if self._client is None:
            return
        import time

        probe = "what do you know about the user"
        deadline = time.monotonic() + 120
        last = -1
        stable = 0
        while time.monotonic() < deadline:
            try:
                r = self._client.recall(  # type: ignore[union-attr]
                    bank_id=self._bank, query=probe, max_tokens=4096, budget="high"
                )
                n = len(getattr(r, "results", []) or [])
            except Exception:
                n = last
            if n == last:
                stable += 1
                if stable >= 2:
                    return
            else:
                stable = 0
                last = n
            time.sleep(5)

    def search(self, query: str) -> str:
        if self._client is None:
            raise RuntimeError("setup() must be called before search()")
        resp = self._client.recall(  # type: ignore[union-attr]
            bank_id=self._bank,
            query=query,
            max_tokens=self._max_tokens,
            budget=self._budget,
        )

        results = getattr(resp, "results", None)
        if results is None and isinstance(resp, dict):
            results = resp.get("results", [])
        if not results:
            return ""

        chunks: list[str] = []
        for r in results:
            text = getattr(r, "text", None)
            if text is None and isinstance(r, dict):
                text = r.get("text", "")
            if text:
                chunks.append(text)
        return "\n\n".join(chunks)
