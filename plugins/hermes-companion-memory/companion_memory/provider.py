"""Implementation of the Hermes ``MemoryProvider`` ABC backed by CI-Server."""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Iterable, Mapping

from .client import CompanionMemoryClient, CompanionMemoryError
from .tools import dispatch, tool_schemas

LOG = logging.getLogger(__name__)

try:  # Imported lazily so the package can be inspected without Hermes installed.
    from agent.memory_provider import MemoryProvider  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - import shim for non-Hermes envs
    class MemoryProvider:  # type: ignore[no-redef]
        """Stub ABC used when Hermes is not installed (e.g. unit tests)."""

        name: str = "memory-provider"

        def is_available(self) -> bool:
            raise NotImplementedError

        def initialize(self, session_id: str, **kwargs: Any) -> None:
            raise NotImplementedError

        def get_tool_schemas(self) -> list:
            return []

        def get_config_schema(self) -> list:
            return []

        def save_config(self, values: Mapping[str, Any], hermes_home: str) -> None:
            raise NotImplementedError

        def handle_tool_call(self, name: str, args: Mapping[str, Any]) -> Any:
            raise NotImplementedError


CONFIG_FILE = "companion_memory.json"


class CompanionMemoryProvider(MemoryProvider):
    """Hermes memory provider that persists state to a CI-Server instance."""

    name = "companion-memory"

    def __init__(self) -> None:
        self._client: CompanionMemoryClient | None = None
        self._session_id: str | None = None
        self._hermes_home: Path | None = None
        self._config: dict[str, Any] = {}
        self._lock = threading.Lock()

    # ---- discovery / availability ---------------------------------------

    def is_available(self) -> bool:
        # is_available must NOT do I/O. We only check that the minimum config is reachable.
        api_key = os.environ.get("COMPANION_MEMORY_API_KEY")
        if api_key:
            return True

        hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        candidate = Path(hermes_home) / CONFIG_FILE

        return candidate.exists()

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id
        self._hermes_home = Path(kwargs.get("hermes_home") or os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"))
        self._config = self._load_config(self._hermes_home)

        base_url = self._config.get("base_url") or os.environ.get("COMPANION_MEMORY_URL") or "http://localhost:3030"
        api_key = self._config.get("api_key") or os.environ.get("COMPANION_MEMORY_API_KEY")
        namespace = self._config.get("namespace") or os.environ.get("COMPANION_MEMORY_NAMESPACE") or session_id
        timeout = float(self._config.get("timeout") or os.environ.get("COMPANION_MEMORY_TIMEOUT") or 15.0)

        if not api_key:
            raise RuntimeError(
                "companion-memory provider is missing an API key. "
                "Set COMPANION_MEMORY_API_KEY or run `hermes memory setup`."
            )

        self._client = CompanionMemoryClient(
            base_url=base_url,
            api_key=api_key,
            namespace=namespace,
            timeout=timeout,
        )
        LOG.info("companion-memory initialised: base_url=%s namespace=%s", base_url, namespace)

    def shutdown(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    # ---- schema / tools --------------------------------------------------

    def get_tool_schemas(self) -> list:
        return tool_schemas()

    def get_config_schema(self) -> list:
        return [
            {
                "key": "base_url",
                "description": "Base URL of the CI-Server API",
                "required": True,
                "env_var": "COMPANION_MEMORY_URL",
                "default": "http://localhost:3030",
            },
            {
                "key": "api_key",
                "description": "Companion Intelligence API key (created via POST /api/keys)",
                "secret": True,
                "required": True,
                "env_var": "COMPANION_MEMORY_API_KEY",
                "url": "https://memory.ci.localhost/settings/api-keys",
            },
            {
                "key": "namespace",
                "description": "Optional namespace tagged on every stored memory",
                "required": False,
                "env_var": "COMPANION_MEMORY_NAMESPACE",
            },
            {
                "key": "timeout",
                "description": "Request timeout in seconds",
                "required": False,
                "default": 15.0,
                "env_var": "COMPANION_MEMORY_TIMEOUT",
            },
        ]

    def save_config(self, values: Mapping[str, Any], hermes_home: str) -> None:
        home = Path(hermes_home)
        home.mkdir(parents=True, exist_ok=True)
        target = home / CONFIG_FILE
        # `api_key` is treated as secret — Hermes already routes secrets to the
        # keychain. The non-secret fields are persisted here.
        persistable = {key: value for key, value in values.items() if key != "api_key" and value is not None}
        target.write_text(json.dumps(persistable, indent=2, sort_keys=True), encoding="utf-8")

    # ---- tool execution --------------------------------------------------

    def handle_tool_call(self, name: str, args: Mapping[str, Any]) -> Any:
        client = self._require_client()

        return dispatch(client, name, args)

    # ---- hooks -----------------------------------------------------------

    def system_prompt_block(self) -> str:
        client = self._client
        if client is None:
            return ""

        # Prefer the agent surface — it returns a Markdown block already
        # formatted for direct injection, with the same shape (`# About You`,
        # `## Close Relationships`, `## Preferences`, `## Knowledge Graph`)
        # the backend assembles uniformly. Fall back to the JSON `/memory/context`
        # endpoint and format client-side if the agent module isn't deployed.
        try:
            block = client.agent_context()
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory agent_context failed: %s", exc)
            block = None

        if block:
            return block

        try:
            context = client.context() or {}
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory context fetch failed: %s", exc)
            return ""

        if not context:
            return ""

        user = context.get("currentUser", {}) if isinstance(context, dict) else {}
        stats = context.get("quickStats", {}) if isinstance(context, dict) else {}
        prefs = context.get("topPreferences", []) if isinstance(context, dict) else []

        lines = ["## Companion Intelligence — User Memory"]
        if user.get("name"):
            lines.append(f"- User: {user.get('name')}")
        if stats:
            stats_summary = ", ".join(f"{key}={value}" for key, value in stats.items())
            lines.append(f"- Stats: {stats_summary}")
        if prefs:
            lines.append("- Top preferences:")
            for pref in prefs[:5]:
                if isinstance(pref, Mapping):
                    lines.append(f"  - {pref.get('name')} ({pref.get('relationship')})")
        lines.append(
            "Use companion_recall before answering personal questions and companion_remember to persist new facts."
        )

        return "\n".join(lines)

    def prefetch(self, query: str) -> str:
        if not query.strip() or self._client is None:
            return ""

        # Prefer /agent/recall — returns a Markdown block capped at ~3k chars,
        # built on the backend's SearchService.search auto-mode. Falls back to
        # /memory/recall when the agent module isn't deployed.
        try:
            agent_result = self._client.agent_recall(query=query, max_results=5)
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory agent_recall failed: %s", exc)
            agent_result = None

        if agent_result and isinstance(agent_result, Mapping):
            block = str(agent_result.get("block") or "")
            if block:
                return block

        try:
            results = self._client.recall(query=query, limit=5)
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory prefetch failed: %s", exc)
            return ""

        if not results:
            return ""

        snippets = []
        for record in results:
            label = record.name or record.entity_type
            snippet = (record.content or "").strip().replace("\n", " ")
            snippets.append(f"- [{label}] {snippet[:240]}")
        body = "\n".join(snippets)

        return f"## Relevant Companion Memories\n{body}"

    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        if self._client is None or not user_content.strip():
            return

        # Prefer /agent/absorb — upserts a single Communication row keyed by
        # sessionId, so a long conversation becomes one growing row rather than
        # N concept nodes. Falls back to /memory/remember if /agent/absorb is
        # unavailable.
        messages = [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]

        def _persist_agent() -> bool:
            assert self._client is not None
            try:
                result = self._client.agent_absorb(
                    messages,
                    session_id=self._session_id,
                    platform="hermes",
                )
            except CompanionMemoryError as exc:
                LOG.warning("companion-memory agent_absorb failed: %s", exc)
                return False

            return bool(result and result.get("ok"))

        def _persist_fallback() -> None:
            try:
                self._client and self._client.remember(  # type: ignore[union-attr]
                    content=f"USER: {user_content}\nASSISTANT: {assistant_content}",
                    entity_type="Communication",
                    tags=["hermes", "turn"],
                    metadata={"session_id": self._session_id},
                    source="hermes",
                )
            except CompanionMemoryError as exc:
                LOG.warning("companion-memory sync_turn failed: %s", exc)

        def _persist() -> None:
            if not _persist_agent():
                _persist_fallback()

        threading.Thread(target=_persist, name="companion-memory-sync", daemon=True).start()

    def on_session_end(self, messages: Iterable[Mapping[str, Any]]) -> None:
        if self._client is None:
            return
        summary = self._summarise_messages(messages)
        if not summary:
            return
        try:
            self._client.remember(
                content=summary,
                entity_type="Concept",
                name=f"Hermes session {self._session_id}",
                tags=["hermes", "session-summary"],
                metadata={"session_id": self._session_id},
                source="hermes",
            )
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory session-end persist failed: %s", exc)

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in MEMORY.md writes into CI-Server."""
        if self._client is None:
            return
        try:
            self._client.remember(
                content=content,
                entity_type="Concept",
                tags=["hermes", "memory.md", action],
                metadata={"target": target, "action": action},
                source="hermes:MEMORY.md",
            )
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory on_memory_write failed: %s", exc)

    # ---- helpers ---------------------------------------------------------

    def _load_config(self, hermes_home: Path) -> dict[str, Any]:
        candidate = hermes_home / CONFIG_FILE
        if not candidate.exists():
            return {}
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            LOG.warning("could not parse %s: %s", candidate, exc)
            return {}

    def _require_client(self) -> CompanionMemoryClient:
        with self._lock:
            if self._client is None:
                raise RuntimeError("companion-memory provider used before initialize()")

            return self._client

    @staticmethod
    def _summarise_messages(messages: Iterable[Mapping[str, Any]]) -> str:
        joined = []
        for message in messages:
            role = str(message.get("role") or "?")
            content = str(message.get("content") or "")
            if not content.strip():
                continue
            joined.append(f"{role.upper()}: {content.strip()}")
        text = "\n".join(joined)

        return text[:8000]
