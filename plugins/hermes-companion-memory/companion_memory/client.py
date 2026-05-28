"""Tiny synchronous HTTP client against the CI-Server endpoints that exist on
``main`` after the agent-memory consolidation.

Endpoints used:
    POST /api/memory/recall   → Markdown-block recall (Hermes ``prefetch``)
    POST /api/memory/turn     → conversation absorb (Hermes ``sync_turn``)
    GET  /api/graph/context   → user dossier (Hermes ``system_prompt_block``)
    GET  /api/graph/search    → structured search (explicit MCP tool)

We deliberately use ``httpx.Client`` (synchronous) because the Hermes
provider lifecycle is called from synchronous code paths. Long-running
operations (``sync_turn``, ``on_session_end``) are dispatched on a daemon
thread by the provider, so blocking calls here are safe.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence
import logging

import httpx

LOG = logging.getLogger(__name__)


class CompanionMemoryError(RuntimeError):
    """Raised when CI-Server returns a non-2xx response."""

    def __init__(self, status: int, body: Any, url: str):
        super().__init__(f"companion-memory request failed: {status} ({url})")
        self.status = status
        self.body = body
        self.url = url


@dataclass
class CompanionMemoryClient:
    base_url: str
    api_key: str
    namespace: str | None = None
    timeout: float = 15.0

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        self._client = httpx.Client(
            timeout=self.timeout,
            headers={
                "x-api-key": self.api_key,
                "accept": "application/json",
                "content-type": "application/json",
            },
        )

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:  # pragma: no cover - defensive
            LOG.debug("error closing companion-memory client", exc_info=True)

    # ---- public API ------------------------------------------------------

    def recall(self, query: str, *, max_results: int = 5) -> Mapping[str, Any]:
        """POST /api/memory/recall — returns ``{block, resultCount}``."""
        return self._request(
            "POST",
            "/api/memory/recall",
            json={"query": query, "maxResults": max_results},
        )

    def turn(self, messages: Sequence[Mapping[str, Any]], *, session_id: str | None = None) -> Mapping[str, Any]:
        """POST /api/memory/turn — currently a no-op stub on the backend."""
        payload: dict[str, Any] = {"messages": list(messages)}
        if session_id:
            payload["sessionId"] = session_id

        return self._request("POST", "/api/memory/turn", json=payload)

    def context(self) -> Mapping[str, Any] | None:
        """GET /api/graph/context — user dossier as JSON."""
        data = self._request("GET", "/api/graph/context")

        return data.get("context")

    def search(self, query: str, *, limit: int = 10) -> Mapping[str, Any]:
        """GET /api/graph/search — structured nodes + links."""
        params = {"query": query, "limit": str(limit)}

        return self._request("GET", "/api/graph/search", params=params)

    # ---- internals -------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, str] | None = None,
    ) -> Mapping[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            response = self._client.request(method, url, json=json, params=params)
        except httpx.HTTPError as exc:
            raise CompanionMemoryError(0, str(exc), url) from exc

        if response.status_code >= 400:
            try:
                body = response.json()
            except ValueError:
                body = response.text
            raise CompanionMemoryError(response.status_code, body, url)

        try:
            return response.json()
        except ValueError as exc:
            raise CompanionMemoryError(response.status_code, response.text, url) from exc
