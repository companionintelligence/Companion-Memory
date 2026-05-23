"""v2 stubs for Companion Intelligence tool handlers.

In v1 these always return a ``v2_not_implemented`` result.  When v2 ships the
real implementations will replace these stubs and call the Companion API.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_V2_NOTE = "v2_not_implemented"


def companion_search(
    query: str,
    *,
    limit: int = 10,
    entity_types: list[str] | None = None,
    **_kwargs: Any,
) -> dict[str, Any]:
    """Search personal memory for entities matching *query*.

    v1 stub — always returns an empty result set.

    Args:
        query: Free-text search string.
        limit: Maximum number of results to return (ignored in v1).
        entity_types: Optional filter by entity type, e.g. ["person", "place"]
                      (ignored in v1).

    Returns:
        A dict with ``results`` (empty list in v1) and a ``note`` field
        indicating that v2 is required for real results.
    """
    logger.debug("companion_search called (v1 stub): query=%r", query)
    return {
        "results": [],
        "note": _V2_NOTE,
        "message": (
            "companion_search is not yet implemented in v1. "
            "Upgrade to v2 of the Companion Intelligence plugin to enable memory search."
        ),
    }


def companion_remember(
    content: str,
    *,
    entity_type: str | None = None,
    tags: list[str] | None = None,
    **_kwargs: Any,
) -> dict[str, Any]:
    """Explicitly store *content* in personal memory.

    v1 stub — acknowledges the call but does not persist anything.

    Args:
        content: The information to remember.
        entity_type: Optional semantic type hint, e.g. "person" or "event"
                     (ignored in v1).
        tags: Optional list of tags (ignored in v1).

    Returns:
        A dict with ``stored`` set to False in v1 and a ``note`` field.
    """
    logger.debug("companion_remember called (v1 stub): content=%r", content)
    return {
        "stored": False,
        "note": _V2_NOTE,
        "message": (
            "companion_remember is not yet implemented in v1. "
            "Upgrade to v2 of the Companion Intelligence plugin to enable explicit memory storage."
        ),
    }


# ---------------------------------------------------------------------------
# Dispatch table — maps tool names to handler functions.
# ---------------------------------------------------------------------------

TOOL_HANDLERS: dict[str, Any] = {
    "companion_search": companion_search,
    "companion_remember": companion_remember,
}


def dispatch(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a tool call to the appropriate handler.

    Args:
        tool_name: The tool name as registered in the plugin.
        arguments: Arguments passed by the agent.

    Returns:
        Handler result dict, or an error dict if the tool is unknown.
    """
    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        logger.warning("dispatch: unknown tool %r", tool_name)
        return {
            "error": "unknown_tool",
            "message": f"No handler registered for tool '{tool_name}'.",
        }
    return handler(**arguments)
