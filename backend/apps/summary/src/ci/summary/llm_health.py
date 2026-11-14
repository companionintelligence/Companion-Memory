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
import threading
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from ci.sidecar.llm_host import (
    DEFAULT_HOST_GATEWAY,
    LOOPBACK_HOSTS,
    running_in_container,
)

from .config import (
    NoChatModelError,
    forget_output_mode,
    model_rows,
    resolve_llm_model,
    settings,
    why_not_still,
)

logger = logging.getLogger(__name__)

STARTUP_TIMEOUT_SECONDS = 5.0
HEALTH_TIMEOUT_SECONDS = 3.0

WAITING_FOR_MODEL = (
    "No chat model is available yet, so summaries, insights and actions are waiting "
    "for one. They start without a restart once one appears."
)


@dataclass(frozen=True)
class EndpointStatus:
    """What we know about the configured chat endpoint right now."""

    url: str
    reachable: bool
    detail: str
    # The model ids GET /models listed, when it answered 2xx with a model list.
    served: tuple[str, ...] | None = None

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

    try:
        served = tuple(str(row["id"]) for row in model_rows(response.json()))
    except Exception:
        # Answered, but not with a model list. The model is checked by asking again.
        served = None

    return EndpointStatus(
        url=base,
        reachable=True,
        detail="Endpoint answered on GET /models.",
        served=served,
    )


# Held while the remembered model is looked at and forgotten, so one /health
# can't clear it between another's look and its use.
_checking_the_model = threading.Lock()


def available_chat_model(status: EndpointStatus) -> str | None:
    """
    The model work would run on right now, or None while there isn't one.

    resolve_llm_model remembers its answer, and this used to repeat it: with
    the endpoint down, and after the endpoint stopped serving the model. So the
    API's gate stayed open and every summary job failed against a model that
    wasn't there, then retried until its retries ran out. Now the answer is
    checked against the endpoint's listing first and forgotten when it no
    longer holds, so this says None and a run that starts anyway asks again.
    """
    with _checking_the_model:
        if not status.reachable:
            # Asking again would only repeat the request that just failed, and
            # against an address that drops packets that takes ten more seconds.
            _forget_the_model("its endpoint does not answer")
            return None

        remembered = _remembered_model()
        if remembered is not None:
            reason = why_not_still(remembered, status.served)
            if reason is not None:
                _forget_the_model(reason)

    try:
        return resolve_llm_model()
    except NoChatModelError:
        return None


def _remembered_model() -> str | None:
    """What resolve_llm_model last answered, without asking the endpoint."""
    if not resolve_llm_model.cache_info().currsize:
        return None

    return resolve_llm_model()


def _forget_the_model(reason: str) -> None:
    """Drop the remembered model and everything built on it, so the next use asks again."""
    # Imported here because they build the agents, which nothing else in this
    # module needs.
    from .llm_config import get_llm_config
    from .summarizer import summarizer

    remembered = _remembered_model()
    if remembered is not None:
        logger.warning(
            "Forgetting chat model %r: %s. Summaries, insights and actions ask "
            "for a model again before they run.",
            remembered,
            reason,
        )

    # All of it, whether or not a model was remembered: a run that was building
    # its agents when the model was last forgotten can store them afterwards.
    resolve_llm_model.cache_clear()
    get_llm_config.cache_clear()
    summarizer.dossier_agent = None
    forget_output_mode()


def llm_report() -> dict[str, object]:
    """The `llm` block of /health: the endpoint and the model work would use."""
    status = probe_endpoint()
    model = available_chat_model(status)
    detail = status.detail if model else f"{status.detail} {WAITING_FOR_MODEL}"

    return {**status.as_dict(), "detail": detail, "model": model}


def check_endpoint_at_startup() -> EndpointStatus:
    """Probe once at boot, loudly. Never raises — a down model is not a crash."""
    try:
        status = probe_endpoint(timeout=STARTUP_TIMEOUT_SECONDS)
    except Exception as exc:  # pragma: no cover - defensive; probe swallows its own
        logger.exception("LLM endpoint probe failed unexpectedly: %s", exc)
        return EndpointStatus(
            url=settings.llm_api_base, reachable=False, detail=str(exc)
        )

    model = available_chat_model(status)

    if not status.reachable and settings.llm_model:
        # ERROR, not WARNING: a model is configured, so an endpoint was meant to
        # be here. No summary, insight or action runs until this is fixed, and
        # nothing else says why.
        logger.error(
            "LLM endpoint %s is UNREACHABLE. Summaries, insights and actions wait "
            "until it answers. %s",
            status.url,
            status.detail,
        )
        return status

    if model is None:
        # WARNING, not ERROR: this is a Hub nobody has added an AI engine to yet,
        # and nothing has failed. Memory runs without it and the work waits.
        logger.warning(
            "LLM endpoint %s: %s %s", status.url, status.detail, WAITING_FOR_MODEL
        )
        return status

    logger.info("LLM endpoint %s is reachable. %s", status.url, status.detail)

    return status


__all__ = [
    "HEALTH_TIMEOUT_SECONDS",
    "STARTUP_TIMEOUT_SECONDS",
    "WAITING_FOR_MODEL",
    "EndpointStatus",
    "available_chat_model",
    "check_endpoint_at_startup",
    "llm_report",
    "probe_endpoint",
]
