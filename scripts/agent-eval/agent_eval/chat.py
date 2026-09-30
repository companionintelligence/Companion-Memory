"""Drive one chat turn on a running Companion Memory and read the thread back.

The gateway serves the API under /api. A turn is POST /api/llm/generate,
which keeps the HTTP body open until the model finishes, including tool
rounds. The trace is then read from GET /api/threads/:id, because that is
what a person sees when they reopen the thread.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any


def _decode_body(raw: bytes) -> Any:
    """The generate stream is a binary frame protocol, not JSON.

    The thread id arrives in a header, and the trace is read from the thread
    afterwards. A body that is not JSON is ignored.
    """
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


class ChatClient:
    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        model: str | None = None,
        timeout: float = 300.0,
    ) -> None:
        self.base_url = (
            base_url or os.environ.get("CI_SERVER_URL", "http://127.0.0.1:8642")
        ).rstrip("/")
        self.token = (
            token if token is not None else os.environ.get("CI_SERVER_TOKEN", "")
        )
        self.model = model if model is not None else os.environ.get("CI_EVAL_MODEL", "")
        self.timeout = timeout

    def require_token(self) -> None:
        if not self.token:
            raise RuntimeError(
                "CI_SERVER_TOKEN is not set. The chat API needs an API key "
                "or a session token in that variable."
            )

    def turn(self, prompt: str, thread_id: str | None) -> str:
        """Send one user message. Returns the thread id, creating it when absent."""
        self.require_token()
        body: dict[str, Any] = {
            "prompt": prompt,
            "threadId": thread_id,
            "enableTools": True,
            "enableThinking": False,
        }
        if self.model:
            body["model"] = self.model
        status, headers, _payload = self._request(
            "POST",
            "/api/llm/generate",
            body,
            timeout=self.timeout,
        )
        if status >= 400:
            raise RuntimeError(f"generate failed with HTTP {status}")
        new_id = headers.get("X-Thread-Id") or headers.get("x-thread-id") or thread_id
        if not new_id:
            raise RuntimeError("generate finished without an X-Thread-Id header")
        self._wait_until_idle(new_id)
        return new_id

    def messages(self, thread_id: str) -> list[dict[str, Any]]:
        status, _headers, payload = self._request(
            "GET",
            f"/api/threads/{thread_id}?includeMessages=true",
            None,
            timeout=30.0,
        )
        if status >= 400:
            raise RuntimeError(f"reading thread {thread_id} failed with HTTP {status}")
        if not isinstance(payload, dict):
            return []
        messages = payload.get("messages") or []
        return [item for item in messages if isinstance(item, dict)]

    def _wait_until_idle(self, thread_id: str) -> None:
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            status, _headers, payload = self._request(
                "GET",
                f"/api/threads/{thread_id}",
                None,
                timeout=30.0,
            )
            if status < 400 and isinstance(payload, dict):
                if payload.get("generationStatus") in (None, "idle", "failed"):
                    return
            time.sleep(0.5)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        timeout: float,
    ) -> tuple[int, dict[str, str], Any]:
        url = f"{self.base_url}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "x-api-key": self.token,
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                response_headers = {
                    key: value for key, value in response.headers.items()
                }
                status = response.status
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            response_headers = {key: value for key, value in exc.headers.items()}
            status = exc.code
        return status, response_headers, _decode_body(raw)
