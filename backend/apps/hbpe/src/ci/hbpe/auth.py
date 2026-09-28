"""Inbound authentication for the HBPE HTTP surface.

Every request to this service must carry ``Authorization: Bearer <SIDECAR_AUTH_SECRET>``,
the shared bearer ``setup-secrets`` mints and the NestJS API presents. Only
``/health`` is exempt (Docker's healthcheck has no credential).

Until this existed the service answered anyone who could open a TCP connection
to it: every registered function for any ``user_id``, the forecast and forage
surfaces, and the model output back out of ``/runs/{id}``. Inside a deployed
appliance that meant any process on the app's private network; in the local
overlay it meant the LAN.

Implemented as an HTTP middleware rather than a per-route ``Depends`` so a route
added later cannot forget it: the check runs before routing, for every app this
package serves (the main API, the standalone forage app).

``require_uuid`` is the other half: caller-supplied ids that become filesystem
paths (``user_id`` → per-user checkpoint directory, forage trial files) must be
UUIDs, so ``../`` can never reach the path builders.
"""

from __future__ import annotations

import hmac
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from ci.hbpe.config import settings

EXEMPT_PATHS: frozenset[str] = frozenset({"/health"})


def install_sidecar_auth(app: FastAPI) -> None:
    """Attach the bearer check to ``app``. Idempotent per app instance is not needed: call once."""

    @app.middleware("http")
    async def _require_sidecar_secret(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        # Read at request time, not import time, so a test (or a live reload) that
        # changes the setting is honoured.
        secret = settings.sidecar_auth_secret
        if not secret:
            # Fail closed: an unconfigured service refuses work rather than
            # accepting it from anyone. The entrypoint refuses to start in this
            # state; this is the backstop for any other way of running the app.
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


def require_uuid(value: str, *, field: str = "user_id") -> str:
    """Return ``value`` if it is a UUID, else raise 400. The only ids this service puts in paths."""
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"{field} must be a UUID") from exc
