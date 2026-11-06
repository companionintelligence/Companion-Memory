"""Inbound authentication for the Summary and Parser HTTP surfaces.

Every request must carry ``Authorization: Bearer <SIDECAR_AUTH_SECRET>``, the
shared bearer ``setup-secrets`` mints and the NestJS API presents. Only
``/health`` is open, for the Docker healthcheck.

Until this existed both apps answered anyone who could reach them: any
registered function for any ``user_id`` via ``/functions/run``, dossier and
insight generation, and the document parser. The middleware is
``ci.sidecar.auth`` (shared with HBPE); this module binds it to this service's
settings.
"""

from __future__ import annotations

from fastapi import FastAPI

from ci.sidecar.auth import EXEMPT_PATHS
from ci.sidecar.auth import install_sidecar_auth as _install_sidecar_auth

from .config import settings


def install_sidecar_auth(app: FastAPI) -> None:
    """Attach the shared bearer check to ``app``, reading this service's secret per request."""
    _install_sidecar_auth(app, secret=lambda: settings.sidecar_auth_secret)


__all__ = ["EXEMPT_PATHS", "install_sidecar_auth"]
