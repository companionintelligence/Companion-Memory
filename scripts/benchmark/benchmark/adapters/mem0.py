"""Mem0 adapter — Mem0 with a local Ollama LLM + Chroma vector store.

The point of the head-to-head is to compare *memory architecture*, so we hold
the embedder constant — same Ollama instance, same nomic embedder CI-Server
uses — and let only the consolidation/retrieval strategies differ.

Two fairness fixes carried over from the spike that are load-bearing:

1. **L2-normalised embedder.** Mem0 stores vectors in Chroma, which defaults to
   L2 distance. ``nomic-embed-text`` vectors aren't unit-normalised, so
   L2-nearest != cosine-nearest and Mem0 retrieves semantically unrelated
   fragments. We wrap ``OllamaEmbedding.embed`` to L2-normalise its output —
   then L2 ranking matches cosine ranking, which is what every other adapter in
   the suite uses.

2. **Cosine re-rank on top of Mem0's recall.** Mem0's Chroma integration
   returns memories sorted by *distance descending* (its ``score`` is a
   distance, but it sorts highest-first — verified against its source). For a
   small ``top_k`` this means the **wrong** end is truncated and the answer
   memory never surfaces. To honestly compare consolidation quality we ask Mem0
   for *all* memories and re-rank them with cosine using the same embedder.

Install:

    pip install "mem0ai>=0.1.29" chromadb
"""

from __future__ import annotations

import math
import os
import shutil
from collections.abc import Callable
from typing import Any

from .base import MemoryAdapter

_DEFAULT_OLLAMA = "http://localhost:11434"
_DEFAULT_LLM_MODEL = "gemma3:1b"
_DEFAULT_EMBED_MODEL = "nomic-embed-text"
_DEFAULT_EMBED_DIMS = 768
_DEFAULT_CHROMA_PATH = "/tmp/mem0_benchmark"


# ---------------------------------------------------------------------------
# Embedding helpers (kept module-level so tests can stub them independently)
# ---------------------------------------------------------------------------


def _embed_ollama(text: str, ollama_host: str, embed_model: str) -> list[float]:
    """POST one fragment to /api/embeddings and return the vector (or [] on error)."""
    import json
    import urllib.request

    req = urllib.request.Request(
        f"{ollama_host.rstrip('/')}/api/embeddings",
        data=json.dumps({"model": embed_model, "prompt": text}).encode("utf-8"),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return list(json.loads(r.read()).get("embedding", []) or [])
    except Exception:
        return []


def _cosine(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n]))
    nb = math.sqrt(sum(x * x for x in b[:n]))
    return dot / (na * nb) if na and nb else 0.0


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class Mem0Adapter(MemoryAdapter):
    def __init__(
        self,
        ollama_host: str | None = None,
        llm_model: str | None = None,
        embed_model: str | None = None,
        embed_dims: int | None = None,
        chroma_path: str | None = None,
        *,
        memory_factory: Callable[[dict], Any] | None = None,
        embed_fn: Callable[[str], list[float]] | None = None,
    ) -> None:
        # Resolve all env-overridable knobs once so tests can construct with
        # explicit args and skip os.environ entirely.
        self._ollama = (
            ollama_host or os.environ.get("OLLAMA_HOST", _DEFAULT_OLLAMA)
        ).rstrip("/")
        self._llm_model = llm_model or os.environ.get(
            "MEM0_LLM_MODEL", _DEFAULT_LLM_MODEL
        )
        self._embed_model = embed_model or os.environ.get(
            "MEM0_EMBED_MODEL", _DEFAULT_EMBED_MODEL
        )
        self._embed_dims = embed_dims or int(
            os.environ.get("MEM0_EMBED_DIMS", str(_DEFAULT_EMBED_DIMS))
        )
        self._chroma_path = chroma_path or os.environ.get(
            "MEM0_CHROMA_PATH", _DEFAULT_CHROMA_PATH
        )
        # Optional: route Mem0's LLM at an OpenAI-compatible base URL (e.g. an
        # LM Studio / vLLM proxy) so the head-to-head holds the extraction model
        # constant with CI-Server. Embeddings stay on Ollama either way.
        self._llm_base_url = os.environ.get("MEM0_LLM_BASE_URL", "").rstrip("/")
        self._llm_api_key = os.environ.get("MEM0_LLM_API_KEY", "lm-studio")

        # Dependency-injection seams used by tests.
        self._memory_factory = memory_factory
        self._embed_fn = embed_fn

        self._user_id = ""
        self._mem: Any = None
        self._emb_cache: dict[str, list[float]] = {}

    @property
    def name(self) -> str:
        return "mem0"

    # ── lifecycle ────────────────────────────────────────────────────────────

    def setup(self, user_id: str) -> None:
        factory = self._memory_factory or self._default_memory_factory
        self._patch_ollama_embedder_normalization()
        self._user_id = user_id
        self._emb_cache.clear()
        self._mem = factory(self._build_config(user_id))

    def ingest(self, text: str, session_id: str) -> None:
        if self._mem is None:
            raise RuntimeError("setup() must be called before ingest()")
        self._mem.add(text, user_id=self._user_id, metadata={"session_id": session_id})

    def search(self, query: str) -> str:
        if self._mem is None:
            raise RuntimeError("setup() must be called before search()")

        # top_k huge → defeat Mem0's wrong-end truncation (see module docstring).
        results = self._mem.search(
            query, top_k=10000, filters={"user_id": self._user_id}
        )
        if isinstance(results, dict):
            results = results.get("results", [])
        mems = [
            r.get("memory", "")
            for r in results
            if isinstance(r, dict) and r.get("memory")
        ]
        if not mems:
            return ""

        # Honest re-rank with the same embedder every other adapter uses.
        qv = self._embed(query)
        if not qv:
            return "\n\n".join(mems[:10])

        scored = sorted(mems, key=lambda m: _cosine(qv, self._embed(m)), reverse=True)
        return "\n\n".join(scored[:10])

    def teardown(self) -> None:
        if os.path.isdir(self._chroma_path):
            shutil.rmtree(self._chroma_path, ignore_errors=True)
        self._mem = None

    # ── helpers ──────────────────────────────────────────────────────────────

    def _build_config(self, user_id: str) -> dict:
        if self._llm_base_url:
            llm_block: dict = {
                "provider": "openai",
                "config": {
                    "model": self._llm_model,
                    "openai_base_url": self._llm_base_url,
                    "api_key": self._llm_api_key,
                    "temperature": 0,
                },
            }
        else:
            llm_block = {
                "provider": "ollama",
                "config": {"model": self._llm_model, "ollama_base_url": self._ollama},
            }
        return {
            "llm": llm_block,
            "embedder": {
                "provider": "ollama",
                "config": {
                    "model": self._embed_model,
                    "ollama_base_url": self._ollama,
                    "embedding_dims": self._embed_dims,
                },
            },
            "vector_store": {
                "provider": "chroma",
                "config": {
                    "collection_name": f"benchmark_{user_id}",
                    "path": self._chroma_path,
                },
            },
        }

    @staticmethod
    def _default_memory_factory(config: dict) -> Any:
        try:
            from mem0 import Memory  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "mem0ai is not installed. Run: pip install 'mem0ai>=0.1.29' chromadb"
            ) from exc
        return Memory.from_config(config)

    @staticmethod
    def _patch_ollama_embedder_normalization() -> None:
        """Idempotently wrap Mem0's OllamaEmbedding.embed to L2-normalise output."""
        try:
            from mem0.embeddings.ollama import (
                OllamaEmbedding,  # type: ignore[import-not-found]
            )
        except Exception:
            return  # mem0 not installed: tests use the factory injection seam
        if getattr(OllamaEmbedding, "_ci_bench_normalized", False):
            return

        original = OllamaEmbedding.embed

        def embed_normalized(self, text, memory_action=None):  # type: ignore[no-untyped-def]
            vec = original(self, text, memory_action)
            norm = math.sqrt(sum(x * x for x in vec)) or 1.0
            return [x / norm for x in vec]

        OllamaEmbedding.embed = embed_normalized  # type: ignore[assignment]
        OllamaEmbedding._ci_bench_normalized = True  # type: ignore[attr-defined]

    def _embed(self, text: str) -> list[float]:
        if text in self._emb_cache:
            return self._emb_cache[text]
        if self._embed_fn is not None:
            vec = self._embed_fn(text)
        else:
            vec = _embed_ollama(text, self._ollama, self._embed_model)
        self._emb_cache[text] = vec
        return vec
