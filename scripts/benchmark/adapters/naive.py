"""
Naive RAG baseline — the simplest possible vector memory.

No extraction, no graph, no Mem0. Just: embed each raw conversation message
with the same embedder everything else uses (nomic-embed-text via Ollama),
keep them in a list, and at query time return the top-k by cosine similarity.

This is the control that answers the most basic question: does CI-Server's
whole apparatus (LLM extraction → graph → query-conditioned expansion) actually
beat dumping the raw conversation into a vector store and retrieving chunks?

Stdlib only (urllib + math) so it adds no dependencies.

Env vars:
  OLLAMA_HOST        — default http://localhost:11434
  NAIVE_EMBED_MODEL  — default nomic-embed-text
  NAIVE_TOP_K        — default 10
"""

from __future__ import annotations

import json
import math
import os
import urllib.request
from typing import Optional

from .base import MemoryAdapter


class NaiveRagAdapter(MemoryAdapter):
    def __init__(
        self,
        ollama_host: Optional[str] = None,
        embed_model: Optional[str] = None,
        top_k: Optional[int] = None,
    ):
        self._ollama = (ollama_host or os.environ.get("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
        self._embed_model = embed_model or os.environ.get("NAIVE_EMBED_MODEL", "nomic-embed-text")
        self._top_k = top_k or int(os.environ.get("NAIVE_TOP_K", "10"))
        self._store: list[tuple[str, list[float]]] = []

    @property
    def name(self) -> str:
        return "Naive RAG (vector)"

    def setup(self, user_id: str) -> None:
        self._store = []

    def teardown(self) -> None:
        self._store = []

    def ingest(self, text: str, session_id: str) -> None:
        vec = self._embed(text)
        if vec:
            self._store.append((text, vec))

    def search(self, query: str) -> str:
        if not self._store:
            return ""
        qv = self._embed(query)
        if not qv:
            return ""
        scored = sorted(
            self._store,
            key=lambda item: _cosine(qv, item[1]),
            reverse=True,
        )
        return "\n\n".join(text for text, _ in scored[: self._top_k])

    # ------------------------------------------------------------------

    def _embed(self, text: str) -> list[float]:
        payload = json.dumps({"model": self._embed_model, "prompt": text}).encode()
        req = urllib.request.Request(f"{self._ollama}/api/embeddings", data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            return data.get("embedding", []) or []
        except Exception:
            return []


def _cosine(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n]))
    nb = math.sqrt(sum(x * x for x in b[:n]))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
