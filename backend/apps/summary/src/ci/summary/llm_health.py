"""
Is the configured inference endpoint actually there?

Nothing in this service used to ask. `create_llm_config()` builds an OpenAI
client for any URL, `resolve_llm_model()` downgrades a failed model listing to a
warning, and there is no `/health` route at all — so a service pointed at
nothing started clean, reported nothing, and failed one job at a time, deep in
the runner, where the error reads as "that summary didn't work" rather than
"the model endpoint is unreachable".

That is not hypothetical. Observed 2026-08-30 on this appliance: summary-service
holding `LLM_API_BASE=http://localhost:11434/v1` — correct for the host-run API,
and inside a container a name for the container itself. Connection refused on
every call. The sibling failure in HBPE (#2484) was the same env var and the
same silence, and cost a full nightly run that wrote zero labels.

So: probe once at startup and log at ERROR when nothing answers, and expose the
same answer on `/health` so it can be asked for rather than dug out of logs.

The probe deliberately counts an HTTP error response as REACHABLE, matching
HBPE's `_endpoint_reachable`. A 401, 403 or 404 means a server answered, which
is all this asks; auth and route shape are someone else's problem, and calling a
live endpoint dead over a missing `/models` route would be a worse error than
the one this exists to catch. Only connection-level failures count as down.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from .config import settings
from .llm_host import DEFAULT_HOST_GATEWAY, LOOPBACK_HOSTS, running_in_container

logger = logging.getLogger(__name__)

STARTUP_TIMEOUT_SECONDS = 5.0
HEALTH_TIMEOUT_SECONDS = 3.0


@dataclass(frozen=True)
class EndpointStatus:
    """What we know about the configured chat endpoint right now."""

    url: str
    reachable: bool
    detail: str

    def as_dict(self) -> dict[str, object]:
        return {"url": self.url, "reachable": self.reachable, "detail": self.detail}


def _names_loopback(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return False

    return host.lower() in LOOPBACK_HOSTS


def _hint(url: str) -> str:
    """The one-line explanation that would have saved the nightly run."""
    if not running_in_container():
        return (
            f"Check that an inference server is listening at {url}, and that "
            f"LLM_API_BASE in .env names it."
        )

    if _names_loopback(url):
        # The original bug, verbatim. Say exactly what is wrong with the URL.
        return (
            f"This process is in a container, where localhost is the container "
            f"itself — an inference server on the machine is reached at "
            f"{DEFAULT_HOST_GATEWAY}. Check LLM_API_BASE in .env; a value set "
            f"there overrides the correct default compose ships, and "
            f"CI_LLM_HOST_REWRITE=off disables the correction that would "
            f"otherwise have fixed this."
        )

    return (
        f"Check that an inference server is listening at {url}, that "
        f"LLM_API_BASE in .env names it, and that this container has a route to "
        f"it (compose: extra_hosts: {DEFAULT_HOST_GATEWAY}:host-gateway)."
    )


def probe_endpoint(
    url: str | None = None,
    api_key: str | None = None,
    timeout: float = HEALTH_TIMEOUT_SECONDS,
) -> EndpointStatus:
    """Ask the endpoint for its model list; report whether anything answered."""
    base = (url if url is not None else settings.llm_api_base).strip()
    key = api_key if api_key is not None else settings.llm_api_key

    if not base:
        return EndpointStatus(
            url="", reachable=False, detail="No LLM_API_BASE configured."
        )

    models_url = f"{base.rstrip('/')}/models"

    try:
        response = httpx.get(
            models_url,
            headers={"Authorization": f"Bearer {key}"},
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        return EndpointStatus(
            url=base,
            reachable=False,
            detail=f"{type(exc).__name__}: {exc}. {_hint(base)}",
        )

    if response.is_error:
        # A server answered. That is what "reachable" means here.
        return EndpointStatus(
            url=base,
            reachable=True,
            detail=f"Endpoint answered {response.status_code} on GET /models.",
        )

    return EndpointStatus(
        url=base, reachable=True, detail="Endpoint answered on GET /models."
    )


def check_endpoint_at_startup() -> EndpointStatus:
    """Probe once at boot, loudly. Never raises — a down model is not a crash."""
    try:
        status = probe_endpoint(timeout=STARTUP_TIMEOUT_SECONDS)
    except Exception as exc:  # pragma: no cover - defensive; probe swallows its own
        logger.exception("LLM endpoint probe failed unexpectedly: %s", exc)
        return EndpointStatus(
            url=settings.llm_api_base, reachable=False, detail=str(exc)
        )

    if status.reachable:
        logger.info("LLM endpoint %s is reachable. %s", status.url, status.detail)
        return status

    # ERROR, not WARNING: every summary, insight and action this service is asked
    # to produce will fail until this is fixed, and the failures surface far from
    # the cause.
    logger.error(
        "LLM endpoint %s is UNREACHABLE — summaries, insights and actions will "
        "all fail. %s",
        status.url,
        status.detail,
    )

    return status


__all__ = [
    "HEALTH_TIMEOUT_SECONDS",
    "STARTUP_TIMEOUT_SECONDS",
    "EndpointStatus",
    "check_endpoint_at_startup",
    "probe_endpoint",
]
