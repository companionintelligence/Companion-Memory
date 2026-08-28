"""CI-Server adapter — uses the shipped /api/memory/* endpoints only.

Mirrors the contract the harness plugins (CI-Hermes / CI-OpenClaw) consume, so a
run of this benchmark exercises the *same* memory path real agents take:

  ingest(text, session_id)  ->  POST /api/memory/write   (404 fallback /api/memory/note)
  search(query)             ->  POST /api/memory/recall  (block | text | context payload)
                                fallback GET  /api/memory/context  for empty queries / cold start

This is a deliberate decoupling from PR #1453's spike branch, which used
`/api/memory/note` + `/api/memory/compact` endpoints that don't exist on main.
This version runs against current main today.

Env (with defaults):
  CI_SERVER_URL    http://localhost:8642
  CI_SERVER_TOKEN  (required)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

from .base import MemoryAdapter

_DEFAULT_TIMEOUT = 30.0
_MAX_RECALL_RESULTS = 20  # mirrors the harness clients


def _extract_block(resp: Dict[str, Any]) -> str:
    """Tolerate ``block`` / ``text`` / ``context`` — matches the harness plugins."""
    if not isinstance(resp, dict):
        return ""
    return resp.get("block") or resp.get("text") or resp.get("context") or ""


class CIServerAdapter(MemoryAdapter):
    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = _DEFAULT_TIMEOUT,
        *,
        http_post: Callable[[str, bytes, dict, float], bytes] | None = None,
        http_get: Callable[[str, dict, float], bytes] | None = None,
    ) -> None:
        base = (url or os.environ.get("CI_SERVER_URL", "http://localhost:8642")).strip().rstrip("/")
        if base.endswith("/api/mcp"):
            base = base[: -len("/api/mcp")]
        self._base = base
        self._token = token or os.environ.get("CI_SERVER_TOKEN", "")
        self._timeout = timeout
        self._user_id = ""
        self._post = http_post or self._default_post
        self._get = http_get or self._default_get

    # ── lifecycle ────────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "ci_server"

    def setup(self, user_id: str) -> None:
        if not self._token:
            raise RuntimeError("CI_SERVER_TOKEN is not set")
        self._user_id = user_id

    def ingest(self, text: str, session_id: str) -> None:
        if not text or not text.strip():
            return
        payload = {"content": text, "source": "benchmark", "sessionId": session_id}
        try:
            self._call_json("POST", "/api/memory/write", payload)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            # Older builds expose this as /api/memory/note (matches the harness
            # plugins' graceful-degradation behaviour).
            self._call_json("POST", "/api/memory/note", payload)

    def search(self, query: str) -> str:
        if not query.strip():
            return _extract_block(self._call_json("GET", "/api/memory/context"))
        resp = self._call_json(
            "POST", "/api/memory/recall", {"query": query, "maxResults": _MAX_RECALL_RESULTS}
        )
        return _extract_block(resp)

    def teardown(self) -> None:
        # No bulk-delete endpoint on main; benchmark fragments are tagged with
        # source='benchmark' so they're easy to clean out manually after a run.
        return

    # ── transport ─────────────────────────────────────────────────────────────

    def _call_json(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self._base}{path}"
        headers = {"Accept": "application/json", "x-api-key": self._token}
        if method == "POST":
            headers["Content-Type"] = "application/json"
            raw = self._post(url, json.dumps(body or {}).encode("utf-8"), headers, self._timeout)
        else:
            raw = self._get(url, headers, self._timeout)
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    @staticmethod
    def _default_post(url: str, body: bytes, headers: dict, timeout: float) -> bytes:
        req = urllib.request.Request(url, data=body, method="POST")
        for k, v in headers.items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    @staticmethod
    def _default_get(url: str, headers: dict, timeout: float) -> bytes:
        req = urllib.request.Request(url, method="GET")
        for k, v in headers.items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
