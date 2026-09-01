"""
Correct an LLM base URL for the network namespace this process actually runs in.

``LLM_API_BASE`` is written once, in ``.env``, and read by processes on both
sides of a network boundary: the NestJS API/worker (on the host under
``make dev``, in a container under staging/production compose) and the two
Python sidecars (always containers). No single hostname is right for both —
``localhost`` names the container itself once you are inside one, and
``host.docker.internal`` does not resolve on a macOS or Linux host at all.
Whichever one ``.env`` picks, the other side is silently pointed at nothing,
and ``${LLM_API_BASE:-<good default>}`` means a set-but-wrong value beats the
correct default that compose ships.

So the hostname is treated as advisory and each consumer corrects it for where
it is:

* inside a container, a loopback host becomes the Docker host gateway;
* outside one, a gateway host that does not resolve becomes loopback.

Only the host is touched. Scheme, userinfo, port, path and query are preserved,
so a ``/v1`` suffix or a non-Ollama port (vLLM on 8000) survives untouched. A
rewrite is never silent: the caller gets a note to log, because quietly moving
where inference goes is its own kind of trap.

Escape hatch: ``CI_LLM_HOST_REWRITE=off`` uses every URL exactly as written.
``CI_LLM_HOST_GATEWAY`` overrides the gateway hostname.

DUPLICATED ON PURPOSE. The identical module lives at
``backend/apps/hbpe/src/ci/hbpe/llm_host.py`` and
``backend/apps/summary/src/ci/summary/llm_host.py``; the two files are
byte-identical and ``diff`` should stay silent. Sharing them would mean a new
member under ``backend/packages/``, which has to be wired into four Dockerfiles
— two of them (CUDA, ROCm) unbuildable outside a GPU appliance, where a wrong
COPY surfaces as an ImportError nobody can reproduce. That is a bad trade for
one pure function over a string.
"""

from __future__ import annotations

import logging
import os
import socket
from collections.abc import Callable, MutableMapping
from pathlib import Path
from urllib.parse import SplitResult, urlsplit, urlunsplit

DEFAULT_HOST_GATEWAY = "host.docker.internal"

# Hostnames that mean "this network namespace", and therefore mean something
# different inside a container than they do on the host.
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1"})

# Names Docker injects into a container's /etc/hosts. They exist in no real DNS
# zone, so "does not resolve" is a dependable signal that this process is not in
# a container that has one.
GATEWAY_HOSTS = frozenset({"host.docker.internal", "gateway.docker.internal"})

# Every env var naming an inference endpoint. Listed together so one call fixes
# chat and embeddings alike: pointing chat at the gateway while embeddings still
# say localhost just moves the same outage to the embedding path.
LLM_URL_ENV_VARS = (
    "LLM_API_BASE",
    "HBPE_LABEL_API_BASE",
    "EMBEDDING_API_BASE",
    "OLLAMA_HOST",
    "OLLAMA_EMBED_HOST",
    "CI_OLLAMA_EMBED_HOST",
)

log = logging.getLogger(__name__)


def rewrite_enabled(env: MutableMapping[str, str] | None = None) -> bool:
    """False when an operator has opted out with CI_LLM_HOST_REWRITE=off."""
    value = (env if env is not None else os.environ).get("CI_LLM_HOST_REWRITE", "")
    return value.strip().lower() not in ("off", "0", "false", "no")


def host_gateway(env: MutableMapping[str, str] | None = None) -> str:
    """Hostname a container uses to reach a service on the Docker host."""
    value = (env if env is not None else os.environ).get("CI_LLM_HOST_GATEWAY", "")
    return value.strip() or DEFAULT_HOST_GATEWAY


def running_in_container() -> bool:
    """
    Is this process inside a container?

    /.dockerenv is Docker's own marker and /run/.containerenv is Podman's; the
    cgroup scan catches the runtimes that write neither (containerd, LXC, and
    Kubernetes nodes). Any single one of these can be absent on a perfectly
    normal container, which is why all three are tried before concluding "host".
    """
    if Path("/.dockerenv").exists() or Path("/run/.containerenv").exists():
        return True

    try:
        cgroup = Path("/proc/1/cgroup").read_text(encoding="utf-8")
    except OSError:
        return False

    return any(
        marker in cgroup for marker in ("docker", "containerd", "kubepods", "lxc")
    )


def hostname_resolves(host: str) -> bool:
    """Does this name resolve from here at all?"""
    try:
        socket.getaddrinfo(host, None)
    except (OSError, UnicodeError):
        return False
    return True


def _with_host(parts: SplitResult, new_host: str) -> str:
    """Swap the host, keeping userinfo, port, path and query intact."""
    userinfo, _, _ = parts.netloc.rpartition("@")
    prefix = f"{userinfo}@" if userinfo else ""
    port = f":{parts.port}" if parts.port is not None else ""

    return urlunsplit(parts._replace(netloc=f"{prefix}{new_host}{port}"))


def resolve_url(
    url: str,
    *,
    in_container: bool | None = None,
    resolves: Callable[[str], bool] | None = None,
    gateway: str | None = None,
    env: MutableMapping[str, str] | None = None,
) -> tuple[str, str | None]:
    """
    Return ``(url, note)`` — the URL corrected for this namespace, and a
    sentence to log when anything was changed or is known to be broken.

    ``note`` is None when the URL was already right for where we are, so a
    caller can log only the interesting cases.
    """
    raw = (url or "").strip()

    if not raw or not rewrite_enabled(env):
        return raw, None

    try:
        parts = urlsplit(raw)
        host = parts.hostname
        parts.port  # noqa: B018 — raises ValueError on a malformed port
    except ValueError:
        return raw, None

    if not host or not parts.scheme:
        return raw, None

    gateway = gateway or host_gateway(env)
    resolves = resolves if resolves is not None else hostname_resolves
    inside = running_in_container() if in_container is None else in_container
    host = host.lower()

    if host in LOOPBACK_HOSTS:
        # Correct as written when we are the host: this is the common dev case
        # and must not be touched.
        if not inside:
            return raw, None

        if resolves(gateway):
            fixed = _with_host(parts, gateway)
            return fixed, (
                f"{raw} names this container, not the machine running the model; "
                f"using {fixed} instead. Set CI_LLM_HOST_REWRITE=off to keep the "
                f"URL exactly as configured."
            )

        # Nothing to rewrite to. Still worth saying out loud, because the URL as
        # written cannot reach anything but the container itself.
        return raw, (
            f"{raw} names this container, and {gateway} does not resolve here, so "
            f"there is no host address to substitute. An inference server on the "
            f"Docker host is unreachable until the container gets a route to it "
            f"(compose: extra_hosts: {gateway}:host-gateway)."
        )

    if host in GATEWAY_HOSTS and not resolves(host):
        # Symmetric case: .env ships host.docker.internal for the containers,
        # and it resolves nowhere on a macOS or Linux host.
        if inside:
            return raw, (
                f"{raw} does not resolve in this container. Give it a route to "
                f"the Docker host (compose: extra_hosts: {host}:host-gateway)."
            )

        fixed = _with_host(parts, "localhost")
        return fixed, (
            f"{raw} does not resolve outside a container; using {fixed} instead. "
            f"Set CI_LLM_HOST_REWRITE=off to keep the URL exactly as configured."
        )

    return raw, None


def resolve_env(
    env: MutableMapping[str, str] | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, str]:
    """
    Correct every inference-endpoint URL in ``env``, in place.

    Called once before settings are read, so every existing reader — chat,
    embeddings, model discovery — sees a URL that is right for this namespace
    without any of them knowing this problem exists. Returns the notes by
    variable name, for tests.
    """
    target = env if env is not None else os.environ
    logger = logger or log
    notes: dict[str, str] = {}

    for name in LLM_URL_ENV_VARS:
        current = target.get(name, "")

        if not current.strip():
            continue

        fixed, note = resolve_url(current, env=target)

        if fixed != current:
            target[name] = fixed

        if note:
            notes[name] = note
            logger.warning("%s: %s", name, note)

    return notes


__all__ = [
    "DEFAULT_HOST_GATEWAY",
    "GATEWAY_HOSTS",
    "LLM_URL_ENV_VARS",
    "LOOPBACK_HOSTS",
    "host_gateway",
    "hostname_resolves",
    "resolve_env",
    "resolve_url",
    "rewrite_enabled",
    "running_in_container",
]
