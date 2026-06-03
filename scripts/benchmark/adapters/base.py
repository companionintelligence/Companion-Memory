"""
Abstract base class for memory system adapters.

Each adapter wraps a single memory system and exposes three operations:
  - ingest(text, session_id)  — store a memory fragment
  - flush()                   — block until all ingested fragments are queryable
                                (e.g. wait for async compaction to finish)
  - search(query) -> str      — retrieve relevant context as a single text block

The benchmark runner calls ingest() for every message in every session,
then flush(), then search() for each eval question.
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
        """
        Called once before a benchmark run.
        Create/reset any per-user state here; use user_id to namespace data
        so parallel runs don't collide.
        """

    @abstractmethod
    def ingest(self, text: str, session_id: str) -> None:
        """Store one memory fragment from session_id."""

    def flush(self) -> None:
        """
        Block until all ingested fragments are searchable.
        Default is a no-op for systems that index synchronously.
        Override for async pipelines (e.g. CI-Server compaction cron).
        """

    @abstractmethod
    def search(self, query: str) -> str:
        """
        Retrieve context relevant to query.
        Returns a single string (may be multi-paragraph).
        Return an empty string if nothing relevant is found.
        """

    @abstractmethod
    def teardown(self) -> None:
        """Called once after the run. Delete all data created during setup()."""
