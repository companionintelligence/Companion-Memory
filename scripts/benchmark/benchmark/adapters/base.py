"""The adapter contract every memory system implements.

The benchmark runner calls each adapter through this lifecycle:

  setup(user_id)
    -> ingest(text, session_id)  for every user message in every session
    -> flush()                   block until everything is queryable
    -> search(query)             for every eval question
  teardown()

Override :meth:`flush` for systems with an async indexing/compaction step
(it's a no-op for systems that index synchronously).
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class MemoryAdapter(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable system name shown in the report."""

    @abstractmethod
    def setup(self, user_id: str) -> None:
        """Create / reset per-user state. Namespace by user_id so parallel runs don't collide."""

    @abstractmethod
    def ingest(self, text: str, session_id: str) -> None:
        """Store one memory fragment from ``session_id``."""

    def flush(self) -> None:  # noqa: B027 — optional override; sync adapters need no-op
        """Block until ingested fragments are searchable. Default is a no-op."""

    @abstractmethod
    def search(self, query: str) -> str:
        """Retrieve context relevant to ``query``. Return "" if nothing is found."""

    @abstractmethod
    def teardown(self) -> None:
        """Delete data created during this run."""
