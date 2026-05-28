"""Implementation of the Hermes ``MemoryProvider`` ABC backed by CI-Server.

Targets the surface that exists on ``main`` after the agent-memory merge:

- ``system_prompt_block`` → ``GET /api/graph/context`` formatted into Markdown.
- ``prefetch``            → ``POST /api/memory/recall`` returns the block
                            already formatted by ``RecallService``.
- ``sync_turn``           → ``POST /api/memory/turn`` (no-op stub today;
                            forward-compatible — the backend will start
                            persisting threads + messages once that path is
                            implemented).
- ``on_memory_write``     → no-op until ``POST /api/memory/persist`` lands.
- ``handle_tool_call``    → dispatches the three tool schemas the agent loop
                            exposes (``companion_recall``,
                            ``companion_context``, ``companion_search``).
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Iterable, Mapping

from .client import CompanionMemoryClient, CompanionMemoryError

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


_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "companion_recall",
        "description": (
            "Semantic recall against the Companion Intelligence personal memory. Returns a Markdown "
            "block ready for prompt injection."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "companion_context",
        "description": "Return the user's identity, family, top preferences, and quick stats as JSON.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "companion_search",
        "description": (
            "Structured search against the personal knowledge graph. Returns nodes + links as JSON."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]


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
        self._hermes_home = Path(
            kwargs.get("hermes_home") or os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        )
        self._config = self._load_config(self._hermes_home)

        base_url = (
            self._config.get("base_url") or os.environ.get("COMPANION_MEMORY_URL") or "http://localhost:3030"
        )
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
        return list(_TOOL_SCHEMAS)

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
        persistable = {key: value for key, value in values.items() if key != "api_key" and value is not None}
        target.write_text(json.dumps(persistable, indent=2, sort_keys=True), encoding="utf-8")

    # ---- tool execution --------------------------------------------------

    def handle_tool_call(self, name: str, args: Mapping[str, Any]) -> Any:
        client = self._require_client()
        try:
            if name == "companion_recall":
                return client.recall(
                    query=str(args["query"]),
                    max_results=int(args.get("maxResults") or 5),
                )
            if name == "companion_context":
                return {"context": client.context()}
            if name == "companion_search":
                return client.search(
                    query=str(args["query"]),
                    limit=int(args.get("limit") or 10),
                )
        except CompanionMemoryError as exc:
            return {"error": True, "status": exc.status, "message": str(exc)}

        return {"error": True, "message": f"unknown tool: {name}"}

    # ---- hooks -----------------------------------------------------------

    def system_prompt_block(self) -> str:
        client = self._client
        if client is None:
            return ""

        try:
            context = client.context() or {}
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory context fetch failed: %s", exc)
            return ""

        if not context or not isinstance(context, Mapping):
            return ""

        user = context.get("currentUser", {}) or {}
        stats = context.get("quickStats", {}) or {}
        prefs = context.get("topPreferences", []) or []
        family = context.get("familyMembers", []) or []

        lines = ["# About You"]
        if user.get("name"):
            lines.append(f"**Name**: {user.get('name')}")
        if isinstance(user, Mapping) and user.get("username"):
            lines.append(f"**Username**: {user.get('username')}")

        if family:
            lines.append("\n## Close Relationships")
            for member in family:
                if isinstance(member, Mapping):
                    age = f", age {member.get('age')}" if member.get("age") else ""
                    lines.append(f"- **{member.get('name')}** ({member.get('relationship')}{age})")

        likes = [p for p in prefs if isinstance(p, Mapping) and p.get("relationship") == "PREFERS"]
        dislikes = [p for p in prefs if isinstance(p, Mapping) and p.get("relationship") == "DISLIKES"]

        if likes:
            lines.append("\n## Preferences")
            lines.append("**Likes**: " + ", ".join(str(p.get("name")) for p in likes[:8]))
        if dislikes:
            if not likes:
                lines.append("\n## Preferences")
            lines.append("**Dislikes**: " + ", ".join(str(p.get("name")) for p in dislikes[:5]))

        if stats:
            stats_summary = ", ".join(f"{key}={value}" for key, value in stats.items())
            lines.append(f"\n## Knowledge Graph\n{stats_summary}")

        return "\n".join(lines)

    def prefetch(self, query: str) -> str:
        if self._client is None or not query.strip():
            return ""
        try:
            result = self._client.recall(query=query, max_results=5)
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory recall failed: %s", exc)
            return ""

        block = str(result.get("block") or "") if isinstance(result, Mapping) else ""

        return block

    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        if self._client is None or not user_content.strip():
            return

        messages = [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]

        def _persist() -> None:
            assert self._client is not None
            try:
                self._client.turn(messages, session_id=self._session_id)
            except CompanionMemoryError as exc:
                LOG.warning("companion-memory turn failed: %s", exc)

        threading.Thread(target=_persist, name="companion-memory-sync", daemon=True).start()

    def on_session_end(self, messages: Iterable[Mapping[str, Any]]) -> None:
        """Post the full session as a single absorb call.

        ``/api/memory/turn`` is a no-op stub today, but it accepts the payload
        and the backend will eventually persist it. We keep the call here so
        we get the persistence for free once the backend implements it.
        """
        if self._client is None:
            return
        payload = [
            {"role": str(message.get("role") or ""), "content": str(message.get("content") or "")}
            for message in messages
            if isinstance(message, Mapping)
        ]
        if not payload:
            return
        try:
            self._client.turn(payload, session_id=self._session_id)
        except CompanionMemoryError as exc:
            LOG.warning("companion-memory on_session_end failed: %s", exc)

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """No-op until ``POST /api/memory/persist`` lands. We log so the
        plugin is observably ready for that endpoint."""
        LOG.debug("on_memory_write: %s %s (no /memory/persist yet)", action, target)

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
