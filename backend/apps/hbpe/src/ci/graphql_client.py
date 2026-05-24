"""
GraphQL client for the CI application API.

Authentication: HBPE self-signs JWTs using the shared AUTH_JWT_AUTHTOKENSECRET.
The app's JwtStrategy validates any token signed with that secret, so HBPE
tokens are accepted without any special service-auth bypass.

The generated token has payload ``{ sub: user_id, iat, exp }`` — exactly the
same shape the app issues for regular user sessions.

Usage::

    from ci.graphql_client import gql, paginate, decode_gid

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

from ci.config import settings

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


def _get_token(user_id: str) -> str:
    """Return a cached service JWT, refreshing 60s before expiry."""
    with _LOCK:
        now = time.time()
        if user_id in _TOKEN_CACHE:
            token, exp = _TOKEN_CACHE[user_id]
            if exp - now > 60:
                return token

        expiry = int(now) + settings.api_jwt_expiry_seconds
        payload: dict[str, Any] = {
            "sub": user_id,
            "iat": int(now),
            "exp": expiry,
        }
        raw = jwt.encode(payload, settings.api_jwt_secret, algorithm="HS256")
        # PyJWT < 2.0 returns bytes; >= 2.0 returns str
        token = raw if isinstance(raw, str) else raw.decode("utf-8")
        _TOKEN_CACHE[user_id] = (token, float(expiry))
        return token


# ── Request helpers ────────────────────────────────────────────────────────────


class GraphQLUnavailable(RuntimeError):
    """Raised when the GraphQL client is not configured (no API_JWT_SECRET)."""


def _check_configured() -> None:
    """Raise GraphQLUnavailable if the JWT secret is not set."""
    if not settings.api_jwt_secret:
        raise GraphQLUnavailable(
            "API_JWT_SECRET is not set — GraphQL calls are disabled. "
            "Set API_JWT_SECRET to enable GraphQL reads from the app service."
        )


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
