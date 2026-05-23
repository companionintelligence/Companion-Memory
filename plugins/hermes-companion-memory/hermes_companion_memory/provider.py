"""Companion Intelligence memory provider implementation for Hermes Agent."""
from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Any

from .client import CompanionClient

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependency shim: allow import without hermes_agent installed
# (e.g. during unit tests or package build).
# ---------------------------------------------------------------------------
try:
    from hermes_agent.memory import MemoryProvider  # type: ignore[import-untyped]
except ImportError:
    import abc

    class MemoryProvider(abc.ABC):  # type: ignore[no-redef]
        """Stub ABC used when hermes_agent is not installed."""

        @abc.abstractmethod
        def is_available(self) -> bool:
            raise NotImplementedError

        @abc.abstractmethod
        def initialize(self) -> None:
            raise NotImplementedError

        @abc.abstractmethod
        def prefetch(self, query: str) -> str:
            raise NotImplementedError

        @abc.abstractmethod
        def sync_turn(self, user_content: str, assistant_content: str) -> None:
            raise NotImplementedError

        @abc.abstractmethod
        def on_session_end(self) -> None:
            raise NotImplementedError

        @abc.abstractmethod
        def on_pre_compress(self) -> None:
            raise NotImplementedError

        @abc.abstractmethod
        def get_config_schema(self) -> dict[str, Any]:
            raise NotImplementedError

        @abc.abstractmethod
        def get_tool_schemas(self) -> list[dict[str, Any]]:
            raise NotImplementedError

        @abc.abstractmethod
        def handle_tool_call(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
            raise NotImplementedError


_DEFAULT_BASE_URL = "https://api.companion.intelligence"


class CompanionMemoryProvider(MemoryProvider):
    """Local-first personal memory provider backed by Companion Intelligence API."""

    name: str = "companion"

    def __init__(self) -> None:
        self._client: CompanionClient | None = None
        self._session_id: str = ""
        self._agent_id: str | None = None
        self._turn_index: int = 0
        self._prev_sync_thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Availability & initialisation
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        """Return True when COMPANION_API_KEY is set in the environment."""
        return bool(os.environ.get("COMPANION_API_KEY"))

    def initialize(self) -> None:
        """Set up the HTTP client and generate a fresh session identifier."""
        api_key = os.environ.get("COMPANION_API_KEY", "")
        base_url = os.environ.get("COMPANION_BASE_URL", _DEFAULT_BASE_URL)
        self._agent_id = os.environ.get("COMPANION_AGENT_ID")
        self._client = CompanionClient(base_url=base_url, api_key=api_key)
        self._session_id = str(uuid.uuid4())
        self._turn_index = 0
        logger.info(
            "CompanionMemoryProvider initialised (session=%s, base_url=%s)",
            self._session_id,
            base_url,
        )

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    def prefetch(self, query: str) -> str:
        """Return a context-injection string before the LLM is called.

        v1: always returns "" (no prefetch).
        v2: will call self._client.fetch_injection(query, self._session_id).
        """
        # v2: return self._client.fetch_injection(query, self._session_id)
        return ""

    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        """Asynchronously persist a completed conversation turn.

        Runs in a daemon thread so it never blocks or crashes the agent loop.
        The previous sync thread (if any) is joined with a 5-second timeout
        before the new thread is started, bounding background work.
        """
        if self._client is None:
            logger.debug("sync_turn called before initialize(); skipping.")
            return

        # Join the previous thread with a short timeout — don't wait forever.
        if self._prev_sync_thread is not None and self._prev_sync_thread.is_alive():
            self._prev_sync_thread.join(timeout=5.0)

        turn_index = self._turn_index
        self._turn_index += 1

        messages = [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]
        session_id = self._session_id
        agent_id = self._agent_id
        client = self._client

        def _post() -> None:
            try:
                client.post_context(
                    session_id=session_id,
                    messages=messages,
                    agent_id=agent_id,
                    turn_index=turn_index,
                )
                logger.debug("sync_turn posted turn %d for session %s", turn_index, session_id)
            except Exception as exc:  # noqa: BLE001
                # NEVER let a memory error propagate into the agent loop.
                logger.warning("sync_turn failed (turn=%d): %s", turn_index, exc)

        thread = threading.Thread(target=_post, daemon=True, name=f"companion-sync-{turn_index}")
        thread.start()
        self._prev_sync_thread = thread

    def on_session_end(self) -> None:
        """Fire-and-forget notification that the session has ended."""
        if self._client is None:
            return
        try:
            self._client.post_context(
                session_id=self._session_id,
                messages=[{"role": "system", "content": "__session_end__"}],
                agent_id=self._agent_id,
            )
            logger.info("on_session_end posted for session %s", self._session_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("on_session_end failed: %s", exc)

    def on_pre_compress(self) -> None:
        """Save insights before the context window is compressed."""
        if self._client is None:
            return
        try:
            self._client.post_context(
                session_id=self._session_id,
                messages=[{"role": "system", "content": "__pre_compress__"}],
                agent_id=self._agent_id,
            )
            logger.info("on_pre_compress posted for session %s", self._session_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("on_pre_compress failed: %s", exc)

    # ------------------------------------------------------------------
    # Config & tools
    # ------------------------------------------------------------------

    def get_config_schema(self) -> dict[str, Any]:
        """Return JSON-schema describing the provider's configuration fields."""
        return {
            "type": "object",
            "properties": {
                "api_key": {
                    "type": "string",
                    "description": (
                        "Companion Intelligence API key. "
                        "Can also be supplied via the COMPANION_API_KEY env var."
                    ),
                },
                "base_url": {
                    "type": "string",
                    "description": "Base URL for the Companion Intelligence API.",
                    "default": _DEFAULT_BASE_URL,
                },
            },
            "required": ["api_key"],
        }

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Return tool schemas exposed to the agent.

        v1: no tools exposed.
        v2: will return schemas from hermes_companion_memory.schemas.
        """
        return []

    def handle_tool_call(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Handle a tool call dispatched by Hermes.

        v1: all calls return an error indicating the feature is not yet available.
        """
        logger.warning("handle_tool_call called for %r — not implemented in v1", tool_name)
        return {
            "error": "not_implemented",
            "message": (
                f"Tool '{tool_name}' is not available in companion memory provider v1. "
                "Upgrade to v2 to enable tool support."
            ),
        }
