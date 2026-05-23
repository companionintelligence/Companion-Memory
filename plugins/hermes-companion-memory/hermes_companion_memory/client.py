"""HTTP client for the Companion Intelligence memory API."""
from __future__ import annotations

import json
import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10  # seconds


class CompanionClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._session = requests.Session()
        self._session.headers.update({
            "X-CI-API-Key": api_key,
            "Content-Type": "application/json",
        })

    def post_context(
        self,
        *,
        session_id: str,
        messages: list[dict[str, str]],
        agent_id: str | None = None,
        turn_index: int | None = None,
    ) -> dict[str, Any]:
        """POST /v1/memory/context — returns the response JSON (injection etc.)."""
        payload: dict[str, Any] = {"session_id": session_id, "messages": messages}
        if agent_id:
            payload["agent_id"] = agent_id
        if turn_index is not None:
            payload["turn_index"] = turn_index
        resp = self._session.post(
            f"{self._base_url}/v1/memory/context",
            data=json.dumps(payload),
            timeout=DEFAULT_TIMEOUT,
        )
        resp.raise_for_status()
        if resp.status_code == 204 or not resp.content:
            return {}
        return resp.json()

    def fetch_injection(self, query: str, session_id: str) -> str:
        """v2: fetch context injection string for a query (prefetch hook)."""
        try:
            result = self.post_context(
                session_id=session_id,
                messages=[{"role": "user", "content": query}],
            )
            return result.get("injection", "")
        except Exception as exc:
            logger.warning("companion prefetch failed: %s", exc)
            return ""
