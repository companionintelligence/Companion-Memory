"""
Mem0 memory adapter — local mode via Ollama + Chroma.

Uses the same local Ollama instance as CI-Server so the comparison is
on the memory architecture, not on embedding model choice.

Requirements:
  pip install "mem0ai>=0.1.29" chromadb

Env vars:
  OLLAMA_HOST          — e.g. http://localhost:11434  (default)
  MEM0_LLM_MODEL       — Ollama model for extraction (default: gemma3:1b)
  MEM0_EMBED_MODEL     — Ollama model for embeddings (default: nomic-embed-text)
  MEM0_EMBED_DIMS      — output dim of the embedding model (default: 768, matches nomic-embed-text)
  MEM0_CHROMA_PATH     — path for Chroma persistence (default: /tmp/mem0_benchmark)
"""

from __future__ import annotations

import os
import shutil
from typing import Optional

from .base import MemoryAdapter


class Mem0Adapter(MemoryAdapter):
    def __init__(
        self,
        ollama_host: Optional[str] = None,
        llm_model: Optional[str] = None,
        embed_model: Optional[str] = None,
        embed_dims: Optional[int] = None,
        chroma_path: Optional[str] = None,
    ):
        self._ollama = (ollama_host or os.environ.get("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
        self._llm_model = llm_model or os.environ.get("MEM0_LLM_MODEL", "gemma3:1b")
        self._embed_model = embed_model or os.environ.get("MEM0_EMBED_MODEL", "nomic-embed-text")
        self._embed_dims = embed_dims or int(os.environ.get("MEM0_EMBED_DIMS", "768"))
        self._chroma_path = chroma_path or os.environ.get("MEM0_CHROMA_PATH", "/tmp/mem0_benchmark")
        # When set, route Mem0's LLM at an OpenAI-compatible base URL (e.g. the
        # lmstudio_proxy in front of LM Studio) so the head-to-head holds the
        # extraction model constant with CI-Server. Embeddings stay on Ollama
        # (nomic) either way, matching CI-Server's embedder.
        self._llm_base_url = os.environ.get("MEM0_LLM_BASE_URL", "").rstrip("/")
        self._llm_api_key = os.environ.get("MEM0_LLM_API_KEY", "lm-studio")
        self._user_id: str = ""
        self._mem: object = None

    @property
    def name(self) -> str:
        return "Mem0 (vector)"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def setup(self, user_id: str) -> None:
        try:
            from mem0 import Memory  # type: ignore[import]
        except ImportError as exc:
            raise ImportError(
                "mem0ai is not installed. Run: pip install 'mem0ai>=0.1.29' chromadb"
            ) from exc

        # FAIRNESS FIX: Mem0 stores vectors in Chroma, which defaults to L2
        # distance, and Mem0 never sets cosine. nomic-embed-text vectors are not
        # unit-normalized, so L2-nearest != cosine-nearest and retrieval returns
        # semantically wrong memories (verified: the answer memories exist but are
        # never retrieved). Normalizing the embedder's output to unit length makes
        # L2 ranking identical to cosine ranking, matching how the naive adapter
        # searches. Patch once, idempotently.
        self._patch_ollama_embedder_normalization()

        self._user_id = user_id

        # LLM: either an OpenAI-compatible endpoint (proxy → LM Studio) for a
        # fair same-model comparison, or local Ollama (default).
        if self._llm_base_url:
            llm_block = {
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
                "config": {
                    "model": self._llm_model,
                    "ollama_base_url": self._ollama,
                },
            }

        config = {
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

        self._mem = Memory.from_config(config)

    @staticmethod
    def _patch_ollama_embedder_normalization() -> None:
        """Wrap Mem0's OllamaEmbedding.embed to L2-normalize its output.

        Idempotent: guarded by a sentinel attribute so repeated setup() calls
        don't stack wrappers.
        """
        try:
            from mem0.embeddings.ollama import OllamaEmbedding  # type: ignore[import]
        except Exception:
            return
        if getattr(OllamaEmbedding, "_ci_bench_normalized", False):
            return

        import math

        original = OllamaEmbedding.embed

        def embed_normalized(self, text, memory_action=None):  # type: ignore[no-untyped-def]
            vec = original(self, text, memory_action)
            norm = math.sqrt(sum(x * x for x in vec)) or 1.0
            return [x / norm for x in vec]

        OllamaEmbedding.embed = embed_normalized  # type: ignore[assignment]
        OllamaEmbedding._ci_bench_normalized = True  # type: ignore[attr-defined]

    def teardown(self) -> None:
        # Remove the Chroma data directory for this run.
        if os.path.isdir(self._chroma_path):
            shutil.rmtree(self._chroma_path, ignore_errors=True)
        self._mem = None

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def ingest(self, text: str, session_id: str) -> None:
        if self._mem is None:
            raise RuntimeError("setup() must be called before ingest()")
        self._mem.add(  # type: ignore[union-attr]
            text,
            user_id=self._user_id,
            metadata={"session_id": session_id},
        )

    def search(self, query: str) -> str:
        """Retrieve Mem0's memories, re-ranked with cosine.

        Mem0's Chroma integration mis-ranks results in this local setup: its
        `score` is a distance (lower = closer) but it returns highest-score
        (== farthest) first, so a small top_k truncates the *answer* off the
        wrong end (verified: the correct memory exists but is never returned).
        To make an HONEST comparison of Mem0's memory quality, we pull all of
        its memories (top_k huge → no truncation) and re-rank them with the same
        cosine retriever the naive adapter uses. This isolates Mem0's
        consolidation from its broken ranking.
        """
        if self._mem is None:
            raise RuntimeError("setup() must be called before search()")

        results = self._mem.search(  # type: ignore[union-attr]
            query,
            top_k=10000,  # effectively "return everything" — defeats the bad truncation
            filters={"user_id": self._user_id},
        )
        if isinstance(results, dict):
            results = results.get("results", [])
        mems = [r.get("memory", "") for r in results if isinstance(r, dict) and r.get("memory")]
        if not mems:
            return ""

        qv = self._embed(query)
        if not qv:
            return "\n\n".join(mems[:10])  # fall back to mem0 order if embedding fails

        scored = sorted(mems, key=lambda m: _cosine(qv, self._embed(m)), reverse=True)
        return "\n\n".join(scored[:10])

    # ------------------------------------------------------------------
    # Embedding (same nomic endpoint the naive adapter uses) + cache
    # ------------------------------------------------------------------

    def _embed(self, text: str) -> list:
        cache = self.__dict__.setdefault("_emb_cache", {})
        if text in cache:
            return cache[text]
        import json as _json
        import urllib.request as _u
        try:
            req = _u.Request(
                f"{self._ollama}/api/embeddings",
                data=_json.dumps({"model": self._embed_model, "prompt": text}).encode(),
                method="POST",
            )
            req.add_header("Content-Type", "application/json")
            with _u.urlopen(req, timeout=30) as r:
                vec = _json.loads(r.read()).get("embedding", []) or []
        except Exception:
            vec = []
        cache[text] = vec
        return vec


def _cosine(a: list, b: list) -> float:
    import math
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n]))
    nb = math.sqrt(sum(x * x for x in b[:n]))
    return dot / (na * nb) if na and nb else 0.0
