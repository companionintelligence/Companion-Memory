"""Tool schema definitions for Companion Intelligence memory tools.

These schemas follow the JSON Schema / OpenAI function-calling convention used
by Hermes Agent.  In v1 they are defined here as stubs so that the plugin
structure is complete; they will be wired into get_tool_schemas() in v2.
"""
from __future__ import annotations

from typing import Any

COMPANION_SEARCH_SCHEMA: dict[str, Any] = {
    "name": "companion_search",
    "description": (
        "Search the user's personal memory graph for entities, events, or facts "
        "matching the provided query.  Returns a ranked list of memory entries."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Free-text search query, e.g. 'people I met in Boston' or 'my coffee order'.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of results to return (default 10, max 50).",
                "default": 10,
                "minimum": 1,
                "maximum": 50,
            },
            "entity_types": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["person", "place", "event", "preference", "concept", "organization"],
                },
                "description": (
                    "Optional filter — only return entities of these types. "
                    "Omit to search across all entity types."
                ),
            },
        },
        "required": ["query"],
    },
}

COMPANION_REMEMBER_SCHEMA: dict[str, Any] = {
    "name": "companion_remember",
    "description": (
        "Explicitly store a piece of information in the user's personal memory. "
        "Use when the user says 'remember that …' or when a salient fact should "
        "be retained beyond the current session."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The information to store, expressed as a natural-language statement.",
            },
            "entity_type": {
                "type": "string",
                "enum": ["person", "place", "event", "preference", "concept", "organization"],
                "description": "Optional semantic type hint to improve retrieval accuracy.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional free-form tags for categorisation, e.g. ['work', 'travel'].",
            },
        },
        "required": ["content"],
    },
}

# Convenience list of all v1-defined schemas.
ALL_SCHEMAS: list[dict[str, Any]] = [
    COMPANION_SEARCH_SCHEMA,
    COMPANION_REMEMBER_SCHEMA,
]
