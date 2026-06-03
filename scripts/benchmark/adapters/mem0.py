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

        self._user_id = user_id

        config = {
            "llm": {
                "provider": "ollama",
                "config": {
                    "model": self._llm_model,
                    "ollama_base_url": self._ollama,
                },
            },
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
        if self._mem is None:
            raise RuntimeError("setup() must be called before search()")
        results = self._mem.search(query, user_id=self._user_id, limit=10)  # type: ignore[union-attr]

        # Mem0 returns a list of dicts with a "memory" key.
        if isinstance(results, list):
            chunks = [r.get("memory", "") for r in results if isinstance(r, dict)]
        elif isinstance(results, dict):
            # Newer versions return {"results": [...]}
            chunks = [r.get("memory", "") for r in results.get("results", []) if isinstance(r, dict)]
        else:
            chunks = []

        return "\n\n".join(c for c in chunks if c)
