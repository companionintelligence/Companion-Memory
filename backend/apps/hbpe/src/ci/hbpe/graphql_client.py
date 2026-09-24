"""
GraphQL client for the CI application API.

Authentication: HBPE self-signs JWTs using the shared AUTH_JWT_AUTHTOKENSECRET.
The app's JwtStrategy validates any token signed with that secret, so HBPE
tokens are accepted without any special service-auth bypass.

The generated token has payload ``{ sub: user_id, iat, exp }`` — exactly the
same shape the app issues for regular user sessions.

Usage::

    from ci.hbpe.graphql_client import gql, paginate, decode_gid

    data   = gql("query { me { id } }", {}, user_id)
    nodes  = paginate(_EVENTS_QUERY, ["events"], {}, user_id)
    raw_id = decode_gid(node["id"])
"""

from __future__ import annotations

import base64
import logging
import threading
import time
from typing import Any

import jwt
import requests

from ci.hbpe.config import settings

log = logging.getLogger(__name__)

_LOCK: threading.Lock = threading.Lock()
_TOKEN_CACHE: dict[str, tuple[str, float]] = {}  # user_id → (token, exp_timestamp)


# ── ID helpers ─────────────────────────────────────────────────────────────────


def decode_gid(gid: str) -> str:
    """
    Decode a GlobalUID base64 ID to the raw UUID string.

    The app encodes IDs as ``base64("type:uuid")``.  This extracts the uuid part.
    """
    padded = gid + "=" * ((4 - len(gid) % 4) % 4)
    return base64.b64decode(padded).decode("utf-8").split(":", 1)[1]


# ── Auth ────────────────────────────────────────────────────────────────────────


def register_token(user_id: str, token: str) -> None:
    """Make ``token`` the credential ``gql`` uses for ``user_id``.

    Called by the function runner with the per-run token the API attached to
    the run request. The token is a real API access token scoped by the API to
    that job's user and lifetime; HBPE never signs one itself any more. The
    expiry is read unverified purely to drop a stale entry — the API is the
    verifier, not this side.
    """
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
        exp = float(claims.get("exp") or 0)
    except jwt.PyJWTError:
        exp = 0.0
    with _LOCK:
        _TOKEN_CACHE[user_id] = (token, exp)


def clear_token(user_id: str) -> None:
    with _LOCK:
        _TOKEN_CACHE.pop(user_id, None)


def _get_token(user_id: str) -> str:
    """Return the run token registered for ``user_id``; there is no other source."""
    with _LOCK:
        entry = _TOKEN_CACHE.get(user_id)
    if entry is None:
        raise GraphQLUnavailable(
            f"no API token registered for user {user_id!r} — GraphQL calls are only "
            "available inside a function run the API dispatched"
        )
    token, exp = entry
    if exp and exp <= time.time():
        clear_token(user_id)
        raise GraphQLUnavailable(
            f"the API token registered for user {user_id!r} has expired"
        )
    return token


class GraphQLUnavailable(RuntimeError):
    """Raised when no run token is registered for the user (or it has expired)."""


def _check_configured() -> None:
    """Kept for callers; configuration is now per run (see register_token)."""
    if not settings.api_url:
        raise GraphQLUnavailable("API_URL is not set — GraphQL calls are disabled.")


def gql(query: str, variables: dict[str, Any], user_id: str) -> dict[str, Any]:
    """Execute a GraphQL query and return the ``data`` dict."""
    _check_configured()
    url = f"{settings.api_url}/graphql"
    token = _get_token(user_id)

    resp = requests.post(
        url,
        json={"query": query, "variables": variables},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=15,
    )
    resp.raise_for_status()
    result: dict[str, Any] = resp.json()

    if "errors" in result:
        raise RuntimeError(f"GraphQL errors: {result['errors']}")

    return result["data"]


def paginate(
    query: str,
    conn_path: list[str],
    base_variables: dict[str, Any],
    user_id: str,
) -> list[dict[str, Any]]:
    """
    Collect all nodes from a cursor-paginated GraphQL connection.

    *query* must accept an ``$after: String`` variable.  The connection must
    expose ``edges { node { … } }`` and ``pageInfo { hasNextPage endCursor }``.

    *conn_path* is the sequence of keys to navigate from the response data
    object to the connection, e.g. ``["summaries"]`` for ``data.summaries``.
    """
    nodes: list[dict[str, Any]] = []
    cursor: str | None = None

    while True:
        data = gql(query, {**base_variables, "after": cursor}, user_id)
        conn: Any = data
        for key in conn_path:
            conn = conn[key]

        nodes.extend(edge["node"] for edge in conn["edges"])

        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]

    return nodes
