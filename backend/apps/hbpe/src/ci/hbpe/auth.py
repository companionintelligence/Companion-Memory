"""Inbound authentication for the HBPE HTTP surface.

Every request to this service must carry ``Authorization: Bearer <SIDECAR_AUTH_SECRET>``,
the shared bearer ``setup-secrets`` mints and the NestJS API presents. Only
``/health`` is exempt (Docker's healthcheck has no credential).

Until this existed the service answered anyone who could open a TCP connection
to it: every registered function for any ``user_id``, the forecast and forage
surfaces, and the model output back out of ``/runs/{id}``. Inside a deployed
appliance that meant any process on the app's private network; in the local
overlay it meant the LAN.

The middleware itself is ``ci.sidecar.auth`` (shared with the Summary service);
this module binds it to this service's settings and adds the operator-route
switch. It is installed on every app this package serves (the main API, the
standalone forage app).

``require_uuid`` is the other half: caller-supplied ids that become filesystem
paths (``user_id`` → per-user checkpoint directory, forage trial files) must be
UUIDs, so ``../`` can never reach the path builders.

The bearer says a request came from something holding the shared secret. It
does not say WHICH user that something may act for: every user-scoped route
takes the user from a ``user_id`` query parameter. So the middleware also holds
that parameter to one shape on every route. It may appear at most once, because
Starlette answers ``query_params["user_id"]`` with the LAST copy and a URL built
by careless interpolation upstream could then name two users and be read as the
wrong one. And it must be a UUID, so no route can be handed anything else. A
per-user proof that another sidecar holding the same secret could not forge
needs a key those sidecars do not have; it is not attempted here.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from ci.hbpe.config import settings
from ci.sidecar.auth import (
    EXEMPT_PATHS,
    require_user_id,
    require_uuid,
    user_id_problem,
)
from ci.sidecar.auth import install_sidecar_auth as _install_sidecar_auth


def install_sidecar_auth(app: FastAPI) -> None:
    """Attach the shared bearer check to ``app``, reading this service's secret per request."""
    _install_sidecar_auth(app, secret=lambda: settings.sidecar_auth_secret)


def require_admin_routes() -> None:
    """Refuse an operator-only route unless ``HBPE_ENABLE_ADMIN_ROUTES`` turned it on.

    ``/trigger`` and ``/invalidate/{date}`` act on any ``user_id`` and nothing in
    the API calls them: the API starts runs through ``/functions/run``. Off,
    they answer 404 as if they did not exist, so the shared bearer alone no
    longer reaches them. Read at request time, like the secret.
    """
    if not settings.enable_admin_routes:
        raise HTTPException(status_code=404, detail="Not Found")


__all__ = [
    "EXEMPT_PATHS",
    "install_sidecar_auth",
    "require_admin_routes",
    "require_user_id",
    "require_uuid",
    "user_id_problem",
]
