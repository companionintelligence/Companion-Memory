"""Inbound authentication for the Summary and Parser HTTP surfaces.

Every request must carry ``Authorization: Bearer <SIDECAR_AUTH_SECRET>``, the
shared bearer ``setup-secrets`` mints and the NestJS API presents. Only
``/health`` is exempt (Docker's healthcheck has no credential).

Until this existed both apps answered anyone who could reach them: any
registered function for any ``user_id`` via ``/functions/run``, dossier and
insight generation, and the document parser. An HTTP middleware rather than a
per-route ``Depends`` so a route added later cannot forget it. Mirrors
``ci.hbpe.auth``; the two sidecars are separate packages by design.
"""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from .config import settings

EXEMPT_PATHS: frozenset[str] = frozenset({"/health"})


def install_sidecar_auth(app: FastAPI) -> None:
    @app.middleware("http")
    async def _require_sidecar_secret(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        secret = settings.sidecar_auth_secret
        if not secret:
            # Fail closed; the entrypoint refuses to start without the secret and
            # this is the backstop for any other way of running the app.
            return JSONResponse(
                status_code=503,
                content={"detail": "SIDECAR_AUTH_SECRET is not configured"},
            )

        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), secret):
            return JSONResponse(
                status_code=401, content={"detail": "sidecar credential required"}
            )

        return await call_next(request)
