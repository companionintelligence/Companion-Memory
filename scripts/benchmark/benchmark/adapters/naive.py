"""The naive baseline — a zero-intelligence retrieval floor.

Stores every ingested fragment verbatim and returns the top-K fragments with the
highest case-insensitive token overlap with the query. This is the "raw dump"
floor that smarter memory systems must beat.

Useful for two things:
  1. As a sanity check in the harness (no external services, fully deterministic).
  2. As a lower bound in the report — a system worse than naive retrieval is
     actively destroying signal during ingestion.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import List, Tuple

from .base import MemoryAdapter

_TOKEN_RE = re.compile(r"[A-Za-z0-9']+")


def _tokens(text: str) -> List[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text)]


class NaiveAdapter(MemoryAdapter):
    """In-memory store. Top-K by token overlap, no embeddings, no extraction."""

    def __init__(self, top_k: int = 3) -> None:
        self._top_k = top_k
        self._fragments: List[Tuple[str, str]] = []   # (session_id, text)

    @property
    def name(self) -> str:
        return "naive"

    def setup(self, user_id: str) -> None:
        self._fragments = []

    def ingest(self, text: str, session_id: str) -> None:
        if text and text.strip():
            self._fragments.append((session_id, text))

    def search(self, query: str) -> str:
        if not self._fragments:
            return ""

        q_tokens = Counter(_tokens(query))
        if not q_tokens:
            return ""

        scored: List[Tuple[float, str]] = []
        for _, text in self._fragments:
            t_tokens = Counter(_tokens(text))
            # Sum of min-count overlap across query terms — a standard BoW
            # similarity proxy; cheap and deterministic.
            score = sum(min(c, t_tokens.get(tok, 0)) for tok, c in q_tokens.items())
            if score > 0:
                scored.append((score, text))

        scored.sort(key=lambda x: x[0], reverse=True)
        return "\n\n".join(text for _, text in scored[: self._top_k])

    def teardown(self) -> None:
        self._fragments = []
