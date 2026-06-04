#!/usr/bin/env python3
"""
Tiny OpenAI-compatible translating proxy for LM Studio.

Why this exists: LM Studio's /v1/chat/completions rejects
`response_format: {"type": "json_object"}` (it requires "json_schema" or
"text"). Mem0 hardcodes `json_object`. To run a *fair* head-to-head — same
model (gemma-4-31b-it-abliterated) for both CI-Server and Mem0 — we sit this
proxy between Mem0 and LM Studio and rewrite the unsupported response_format
into a permissive `json_schema` that LM Studio accepts and that still forces a
JSON object out of the model.

CI-Server does NOT need this — it already speaks json_schema natively.

Usage:
  LMS_TARGET=http://192.168.0.203:1234 PROXY_PORT=1235 python lmstudio_proxy.py
"""

import http.server
import json
import os
import threading
import urllib.error
import urllib.request

TARGET = os.environ.get("LMS_TARGET", "http://192.168.0.203:1234").rstrip("/")
PORT = int(os.environ.get("PROXY_PORT", "1235"))

# A permissive object schema: forces a JSON object, constrains nothing else.
PERMISSIVE_JSON_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "object_response",
        "strict": False,
        "schema": {"type": "object", "additionalProperties": True},
    },
}


class Handler(http.server.BaseHTTPRequestHandler):
    def _forward(self, method: str) -> None:
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length) if length else b""

        # Rewrite the one thing LM Studio chokes on.
        if body:
            try:
                payload = json.loads(body)
                rf = payload.get("response_format")
                if isinstance(rf, dict) and rf.get("type") == "json_object":
                    payload["response_format"] = PERMISSIVE_JSON_SCHEMA
                    body = json.dumps(payload).encode()
            except Exception:
                pass  # not JSON — forward untouched

        url = f"{TARGET}{self.path}"
        req = urllib.request.Request(url, data=body if method == "POST" else None, method=method)
        for h in ("content-type", "authorization", "accept"):
            if h in self.headers:
                req.add_header(h, self.headers[h])
        if body:
            req.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                data = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            msg = json.dumps({"error": str(e)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_POST(self) -> None:
        self._forward("POST")

    def do_GET(self) -> None:
        self._forward("GET")

    def log_message(self, *args) -> None:  # silence
        pass


def main() -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"lmstudio_proxy: 127.0.0.1:{PORT} -> {TARGET}  (rewriting json_object -> json_schema)")
    server.serve_forever()


if __name__ == "__main__":
    main()
