"""Tiny synchronous HTTP client against the CI-Server `/memory/*` endpoints.

We deliberately use `httpx.Client` (not the async client) because the Hermes
provider lifecycle is called from synchronous code paths. Long-running
operations (sync_turn, on_session_end) are dispatched on a daemon thread by
the provider, so blocking calls here are safe.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping
import logging

import httpx

LOG = logging.getLogger(__name__)


class CompanionMemoryError(RuntimeError):
    """Raised when the CI-Server returns a non-2xx response."""

    def __init__(self, status: int, body: Any, url: str):
        super().__init__(f"companion-memory request failed: {status} ({url})")
        self.status = status
        self.body = body
        self.url = url


@dataclass(frozen=True)
class MemoryRecord:
    id: str
    entity_type: str
    name: str | None
    content: str | None
    score: float | None = None
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None

    @classmethod
    def from_api(cls, payload: Mapping[str, Any]) -> "MemoryRecord":
        return cls(
            id=str(payload.get("id") or payload.get("entity_id") or ""),
            entity_type=str(payload.get("entityType") or payload.get("entity_type") or "Concept"),
            name=payload.get("name"),
            content=payload.get("content") or payload.get("description"),
            score=payload.get("score"),
            tags=list(payload.get("tags") or []),
            metadata=dict(payload.get("metadata") or {}),
            created_at=payload.get("createdAt"),
            updated_at=payload.get("updatedAt"),
        )


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

    def health(self) -> Mapping[str, Any]:
        return self._request("GET", "/api/memory/health")

    def remember(
        self,
        content: str,
        *,
        name: str | None = None,
        entity_type: str = "Concept",
        tags: Iterable[str] | None = None,
        metadata: Mapping[str, Any] | None = None,
        source: str | None = None,
    ) -> MemoryRecord:
        payload = {
            "content": content,
            "name": name,
            "entityType": entity_type,
            "tags": list(tags) if tags else None,
            "metadata": self._augment_metadata(metadata),
            "source": source,
        }
        data = self._request("POST", "/api/memory/remember", json=_strip_none(payload))

        return MemoryRecord.from_api(data["memory"])

    def recall(self, query: str, *, limit: int = 10, entity_type: str | None = None) -> list[MemoryRecord]:
        params: dict[str, str] = {"query": query, "limit": str(limit)}
        if entity_type:
            params["entityType"] = entity_type
        data = self._request("GET", "/api/memory/recall", params=params)

        return [MemoryRecord.from_api(item) for item in data.get("results", [])]

    def list_memories(
        self,
        *,
        entity_type: str | None = None,
        name_contains: str | None = None,
        limit: int = 25,
    ) -> list[MemoryRecord]:
        params: dict[str, str] = {"limit": str(limit)}
        if entity_type:
            params["entityType"] = entity_type
        if name_contains:
            params["nameContains"] = name_contains
        data = self._request("GET", "/api/memory/list", params=params)

        return [MemoryRecord.from_api(item) for item in data.get("results", [])]

    def forget(self, memory_id: str, *, reason: str | None = None, hard_delete: bool = False) -> Mapping[str, Any]:
        return self._request(
            "DELETE",
            f"/api/memory/forget/{memory_id}",
            json=_strip_none({"reason": reason, "hardDelete": hard_delete}),
        )

    def context(self) -> Mapping[str, Any] | None:
        data = self._request("GET", "/api/memory/context")

        return data.get("context")

    # ---- agent surface (`/api/agent/*`) ---------------------------------
    # Added in concert with the AgentModule landed by feature/agent-memory.
    # Returns Markdown blocks pre-formatted for prompt injection. Each
    # method returns None on failure (the caller decides whether to fall
    # back to the older `/memory/*` surface).

    def agent_context(self) -> str | None:
        try:
            data = self._request("GET", "/api/agent/context")
        except CompanionMemoryError as exc:
            if exc.status == 404:
                return None
            raise

        return data.get("block") or ""

    def agent_recall(self, query: str, *, max_results: int = 5) -> Mapping[str, Any] | None:
        try:
            return self._request(
                "POST",
                "/api/agent/recall",
                json={"query": query, "maxResults": max_results},
            )
        except CompanionMemoryError as exc:
            if exc.status == 404:
                return None
            raise

    def agent_absorb(
        self,
        messages: list[Mapping[str, Any]],
        *,
        session_id: str | None = None,
        platform: str | None = None,
    ) -> Mapping[str, Any] | None:
        try:
            return self._request(
                "POST",
                "/api/agent/absorb",
                json=_strip_none(
                    {"messages": messages, "sessionId": session_id, "platform": platform}
                ),
            )
        except CompanionMemoryError as exc:
            if exc.status == 404:
                return None
            raise

    def agent_tool(self, tool: str, args: Mapping[str, Any]) -> Mapping[str, Any] | None:
        try:
            return self._request(
                "POST",
                "/api/agent/tools",
                json={"tool": tool, "args": dict(args)},
            )
        except CompanionMemoryError as exc:
            if exc.status == 404:
                return None
            raise

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

    def _augment_metadata(self, metadata: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
        if not self.namespace:
            return metadata
        merged: dict[str, Any] = {"namespace": self.namespace}
        if metadata:
            merged.update(metadata)

        return merged


def _strip_none(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}
