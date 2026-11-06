"""
Inbound authentication for a sidecar's HTTP surface.

Every request must carry ``Authorization: Bearer <SIDECAR_AUTH_SECRET>``, the
shared bearer ``setup-secrets`` mints and the NestJS API presents. Only
``/health`` is open, for the Docker healthcheck.

Before this existed each sidecar answered anyone who could open a TCP connection
to it: every registered function for any ``user_id``, HBPE's forecast and forage
surfaces, Summary's dossier generation and the document parser, and the model
output back out of ``/runs/{id}``. Inside a deployed appliance that meant any
process on the app's private network; in the local overlay it meant the LAN.

Implemented as an HTTP middleware rather than a per-route ``Depends`` so a route
added later cannot forget it: the check runs before routing, for every app it
is installed on.

The bearer says a request came from something holding the shared secret. It
does not say WHICH user that something may act for: a user-scoped route takes
the user from a ``user_id`` query parameter. So the middleware also holds that
parameter to one shape on every route. It may appear at most once, because
Starlette answers ``query_params["user_id"]`` with the LAST copy and a URL built
by careless interpolation upstream could then name two users and be read as the
wrong one. And it must be a UUID, so no route can be handed anything else — and
so ``../`` can never reach a path builder (HBPE keys per-user checkpoint
directories and forage trial files on it). A per-user proof that another sidecar
holding the same secret could not forge needs a key those sidecars do not have;
it is not attempted here.

``require_uuid`` and ``require_user_id`` are the route-level half for an id that
arrives some other way.
"""

from __future__ import annotations

import hmac
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

EXEMPT_PATHS: frozenset[str] = frozenset({"/health"})


def install_sidecar_auth(app: FastAPI, *, secret: Callable[[], str]) -> None:
    """Attach the bearer check to ``app``. Call once per app instance.

    ``secret`` is read at request time, not install time, so a test (or a live
    reload) that changes the setting is honoured.
    """

    @app.middleware("http")
    async def _require_sidecar_secret(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        expected = secret()
        if not expected:
            # Fail closed: an unconfigured service refuses work rather than
            # accepting it from anyone. The entrypoint refuses to start in this
            # state; this is the backstop for any other way of running the app.
            return JSONResponse(
                status_code=503,
                content={"detail": "SIDECAR_AUTH_SECRET is not configured"},
            )

        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            token.strip(), expected
        ):
            return JSONResponse(
                status_code=401, content={"detail": "sidecar credential required"}
            )

        problem = user_id_problem(request.query_params.getlist("user_id"))
        if problem is not None:
            return JSONResponse(status_code=400, content={"detail": problem})

        return await call_next(request)


def user_id_problem(values: list[str]) -> str | None:
    """Why these ``user_id`` query values are refused, or ``None`` when they are fine.

    Absent is fine here; each route decides whether it needs a user.
    """
    if len(values) > 1:
        return "user_id must appear at most once"
    if values and not _is_uuid(values[0]):
        return "user_id must be a UUID"
    return None


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def require_uuid(value: str, *, field: str = "user_id") -> str:
    """Return ``value`` if it is a UUID, else raise 400. The only ids a sidecar puts in paths."""
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"{field} must be a UUID") from exc


def require_user_id(user_id: str | None) -> str:
    """The route's user: 401 when absent, 400 when not a UUID, else its canonical form."""
    if not user_id:
        raise HTTPException(status_code=401, detail="user_id is required")
    return require_uuid(user_id)
