"""
Honcho memory adapter — stub.

Honcho (https://honcho.dev) is a user-state and context management
service from Plastic Labs. It focuses on "metamemory" — modeling the
user as a whole rather than indexing individual facts — which means
the comparison surface is slightly different from CI-Server or Mem0.

To implement:
  pip install honcho-ai

  from honcho import Honcho
  client = Honcho(app_id=..., api_key=...)
  session = client.apps.users.sessions.create(user_id=..., app_id=...)
  # Add messages; Honcho derives context automatically
  context = client.apps.users.sessions.metamemory.get(...)

See https://docs.honcho.dev for the current SDK surface.
"""

from __future__ import annotations

from .base import MemoryAdapter


class HonchoAdapter(MemoryAdapter):
    @property
    def name(self) -> str:
        return "Honcho"

    def setup(self, user_id: str) -> None:
        raise NotImplementedError(
            "Honcho adapter is not yet implemented. "
            "See scripts/benchmark/adapters/honcho.py for wiring instructions."
        )

    def ingest(self, text: str, session_id: str) -> None:
        raise NotImplementedError

    def search(self, query: str) -> str:
        raise NotImplementedError

    def teardown(self) -> None:
        pass
