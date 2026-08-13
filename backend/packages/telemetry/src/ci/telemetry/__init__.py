"""
Sentry error reporting, shared by every Python service.

Each service passes its own component name to :func:`init_telemetry`; nothing
else here is service-specific. This module previously existed as two byte-identical
copies, one per service, kept in step by a test that diffed them.

Opt-out — on wherever a DSN is configured. With no ``SENTRY_DSN`` nothing initialises and the
process makes no outbound connection. Two kill switches disable reporting even
when a DSN has been baked into the image, so an operator can always turn it off
without a rebuild:

  * ``CI_TELEMETRY=off``   — explicit opt-out
  * ``CI_LOCAL_ONLY=true`` — local-only mode means zero phone-home, see
    CI-Engineering/proposals/local-only-mode.md

No PII is ever sent (``send_default_pii=False``) and every payload passes
through :func:`scrub_event` first. Mirrors the contract implemented in
TypeScript at ``backend/apps/api/src/common/telemetry/``.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Mapping
from typing import Any, cast

_FALSEY = {"off", "false", "0", "no", "disabled"}
_TRUTHY = {"on", "true", "1", "yes", "enabled"}

_SECRET_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE),
    re.compile(
        r"(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:\"']+[^\s\"',}\]]+",
        re.IGNORECASE,
    ),
    re.compile(r"tskey-[A-Za-z0-9-]+", re.IGNORECASE),
    # Connection URLs carry credentials in the authority section.
    re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s:@/]+:[^\s@/]+@", re.IGNORECASE),
]

# Windows first: the macOS pattern also matches the `/Users/<name>` inside
# `C:/Users/<name>`, and replacing that leaves a stranded `C:~/…` with the drive
# letter still attached. The longest-prefix forms have to win.
_HOME_PATTERNS = [
    re.compile(r"[A-Za-z]:\\Users\\[^\\/\s]+"),  # Windows (backslash)
    re.compile(r"[A-Za-z]:/Users/[^/\s]+"),  # Windows (forward-slash)
    re.compile(r"/Users/[^/\s]+"),  # macOS
    re.compile(r"/home/[^/\s]+"),  # Linux
]

_SENSITIVE_KEY = re.compile(
    r"password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature",
    re.IGNORECASE,
)

# Keys that name a PERSON rather than carrying a credential. No value pattern can
# match a username, so the key is the only signal — same reason we drop
# server_name. Anchored so `user-agent`, `user_id` and `owner_id` survive as
# diagnostic signal.
_IDENTITY_KEY = re.compile(
    r"(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-",
    re.IGNORECASE,
)


def _is_sensitive_key(key: str) -> bool:
    """Single predicate so credential and identity coverage cannot diverge."""
    return bool(_SENSITIVE_KEY.search(key) or _IDENTITY_KEY.search(key))


_MAX_STRING_LENGTH = 8000

# Headers and breadcrumb keys whose value is a URL — the query string carries
# the user's own search terms, so it must go even though the key itself looks
# innocuous.
_URL_VALUED_HEADERS = {"referer", "referrer", "location"}
_URL_VALUED_KEYS = {"url", "from", "to"}

_initialized = False


def _read(env: Mapping[str, str], key: str) -> str | None:
    value = env.get(key, "").strip()
    return value or None


def is_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Whether reporting should initialise for this process."""
    env = os.environ if env is None else env

    if (_read(env, "CI_LOCAL_ONLY") or "").lower() in _TRUTHY:
        return False

    if (_read(env, "CI_TELEMETRY") or "").lower() in _FALSEY:
        return False

    return _read(env, "SENTRY_DSN") is not None


def scrub_url(url: str) -> str:
    """Strip query and fragment — on this appliance they carry search terms."""
    return re.split(r"[?#]", url, maxsplit=1)[0]


def scrub_string(value: str) -> str:
    for pattern in _HOME_PATTERNS:
        value = pattern.sub("~", value)

    for pattern in _SECRET_PATTERNS:
        value = pattern.sub("[Filtered]", value)

    if len(value) > _MAX_STRING_LENGTH:
        return value[:_MAX_STRING_LENGTH] + "… [truncated]"

    return value


def _scrub_value(value: Any, depth: int = 0) -> Any:
    # Guard against cyclic/deep structures — a runaway walk in before_send would
    # stall the reporting path on every captured error.
    if depth > 8:
        return "[Truncated]"

    if isinstance(value, str):
        return scrub_string(value)

    if isinstance(value, dict):
        return {
            key: "[Filtered]"
            if _is_sensitive_key(str(key))
            else _scrub_value(nested, depth + 1)
            for key, nested in value.items()
        }

    if isinstance(value, (list, tuple)):
        return [_scrub_value(entry, depth + 1) for entry in value]

    return value


def scrub_event(
    event: dict[str, Any], _hint: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """``before_send`` hook — redact credentials and home paths."""
    if not isinstance(event, dict):
        return event

    # sentry_sdk builds three keys from a stdlib log record: `message` (the
    # printf FORMAT string), `formatted` (the interpolated result) and `params`
    # (the arguments). Scrubbing only `message` leaves the actual user data
    # untouched while stamping "[Filtered]" on the format string — a false
    # redaction signal that reads as safe.
    logentry = event.get("logentry")
    if isinstance(logentry, dict):
        for key in ("message", "formatted"):
            if isinstance(logentry.get(key), str):
                logentry[key] = scrub_string(logentry[key])
        if logentry.get("params") is not None:
            logentry["params"] = _scrub_value(logentry["params"])

    if isinstance(event.get("message"), str):
        event["message"] = scrub_string(event["message"])

    for exception in (event.get("exception") or {}).get("values") or []:
        if isinstance(exception.get("value"), str):
            exception["value"] = scrub_string(exception["value"])

        # Frame locals are captured by default and, in these services, hold
        # note bodies, memory rows and export paths. `include_local_variables`
        # is disabled at init; this also covers frames from any other source.
        stacktrace = exception.get("stacktrace")
        if isinstance(stacktrace, dict):
            for frame in stacktrace.get("frames") or []:
                if not isinstance(frame, dict):
                    continue
                for key in ("filename", "abs_path", "context_line"):
                    if isinstance(frame.get(key), str):
                        frame[key] = scrub_string(frame[key])
                # ContextLines attaches the source around the throw site — real
                # source text, where hardcoded keys and connection strings live.
                for key in ("pre_context", "post_context"):
                    lines = frame.get(key)
                    if isinstance(lines, list):
                        frame[key] = [
                            scrub_string(line) if isinstance(line, str) else line
                            for line in lines
                        ]
                if frame.get("vars") is not None:
                    frame["vars"] = _scrub_value(frame["vars"])

    if isinstance(event.get("extra"), dict):
        event["extra"] = _scrub_value(event["extra"])

    # The hostname identifies the household as surely as a home path.
    event.pop("server_name", None)

    request = event.get("request")
    if isinstance(request, dict):
        request.pop("cookies", None)
        request.pop("data", None)
        if request.get("query_string"):
            request["query_string"] = "[Filtered]"
        if isinstance(request.get("url"), str):
            request["url"] = scrub_url(request["url"])
        if isinstance(request.get("headers"), dict):
            headers = _scrub_value(request["headers"])
            for key, value in list(headers.items()):
                if key.lower() in _URL_VALUED_HEADERS and isinstance(value, str):
                    headers[key] = scrub_url(value)
            request["headers"] = headers

    # LoggingIntegration is on by default, so every INFO+ log record becomes a
    # breadcrumb — and the TypeScript twin scrubs these. Without this the
    # breadcrumbs were the one part of the event reaching Sentry verbatim.
    breadcrumbs = event.get("breadcrumbs")
    if isinstance(breadcrumbs, dict):
        # Python SDK shape: {"values": [...]}. The JS shape is a bare list.
        crumbs = breadcrumbs.get("values")
    else:
        crumbs = breadcrumbs

    for crumb in crumbs or []:
        if not isinstance(crumb, dict):
            continue
        if isinstance(crumb.get("message"), str):
            crumb["message"] = scrub_string(crumb["message"])
        if isinstance(crumb.get("data"), dict):
            data = _scrub_value(crumb["data"])
            for key, value in list(data.items()):
                if key in _URL_VALUED_KEYS and isinstance(value, str):
                    data[key] = scrub_url(value)
            crumb["data"] = data

    return event


def init_telemetry(component: str) -> bool:
    """
    Initialise Sentry when configured. Returns True when reporting is active.

    ``component`` identifies the calling service (for example
    ``"ci-server-hbpe"``). It is required rather than defaulted, because the
    default is the one thing that differed between the two copies this module
    replaces, and a wrong default silently mislabels every event.

    Safe to call repeatedly and safe to call when ``sentry-sdk`` is not
    installed — a missing optional dependency must never stop the service from
    starting.

    Never raises. ``init_telemetry()`` runs at module scope in api.py and at
    worker start, so anything escaping here takes the whole service down. A
    typo'd DSN makes sentry_sdk raise ``BadDsn`` out of ``init`` — reporting is
    not important enough to stop the appliance from booting.
    """
    global _initialized

    if _initialized or not is_enabled():
        return _initialized

    try:
        import sentry_sdk
    except ImportError:  # pragma: no cover - depends on the install extra
        return False

    version = _read(os.environ, "CI_SERVER_VERSION")
    release = _read(os.environ, "SENTRY_RELEASE") or (
        f"{component}@{version}" if version else None
    )

    def sample_rate(name: str, fallback: float) -> float:
        try:
            value = float(_read(os.environ, name) or fallback)
        except (TypeError, ValueError):
            return fallback
        return value if 0 <= value <= 1 else fallback

    try:
        sentry_sdk.init(
            dsn=_read(os.environ, "SENTRY_DSN"),
            environment=(
                _read(os.environ, "SENTRY_ENV")
                or _read(os.environ, "CI_SERVER_ENVIRONMENT")
                or "development"
            ),
            release=release,
            traces_sample_rate=sample_rate("SENTRY_TRACES_SAMPLE_RATE", 0.1),
            profiles_sample_rate=sample_rate("SENTRY_PROFILES_SAMPLE_RATE", 0.1),
            enable_metrics=(_read(os.environ, "SENTRY_ENABLE_METRICS") or "").lower()
            != "false",
            enable_logs=(_read(os.environ, "SENTRY_ENABLE_LOGS") or "").lower()
            != "false",
            send_default_pii=False,
            # Frame locals in these services are memory rows, note bodies and
            # export paths. The SDK's own EventScrubber only redacts top-level
            # vars by NAME, which is nowhere near enough here.
            include_local_variables=False,
            # The hostname identifies the household.
            server_name=None,
            # scrub_event is typed against plain dicts rather than the SDK's
            # Event TypedDict, so that it stays callable (and testable) without
            # sentry-sdk installed. That is the whole point of the optional
            # dependency, so the cast is deliberate.
            before_send=cast("Any", scrub_event),
        )
        sentry_sdk.set_tag("component", component)

        if version:
            sentry_sdk.set_tag("deployment_version", version)
    except Exception:
        logging.getLogger(__name__).warning(
            "Sentry initialisation failed; continuing with error reporting disabled",
            exc_info=True,
        )
        return False

    _initialized = True

    return True
