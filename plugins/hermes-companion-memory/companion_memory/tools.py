"""Tool schemas + handlers exposed to the Hermes agent loop."""
from __future__ import annotations

from typing import Any, Callable, Mapping

from .client import CompanionMemoryClient, CompanionMemoryError, MemoryRecord


def _record_to_dict(record: MemoryRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "entityType": record.entity_type,
        "name": record.name,
        "content": record.content,
        "score": record.score,
        "tags": record.tags,
        "metadata": record.metadata,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    }


def tool_schemas() -> list[dict[str, Any]]:
    """Return the tool descriptors that Hermes will inject into the model."""
    return [
        {
            "name": "companion_remember",
            "description": (
                "Store a memory in the Companion Intelligence personal memory graph. Use for facts, "
                "preferences, decisions, and anything that should persist across sessions."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Natural-language content to remember."},
                    "name": {"type": "string", "description": "Optional short label for the memory."},
                    "entity_type": {
                        "type": "string",
                        "description": "Graph entity type (default 'Concept').",
                        "default": "Concept",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags to attach for retrieval filtering.",
                    },
                    "metadata": {
                        "type": "object",
                        "description": "Free-form metadata stored on the memory record.",
                        "additionalProperties": True,
                    },
                    "source": {"type": "string", "description": "Provenance, e.g. 'hermes'."},
                },
                "required": ["content"],
                "additionalProperties": False,
            },
        },
        {
            "name": "companion_recall",
            "description": (
                "Search the Companion Intelligence memory for relevant snippets. Hybrid full-text + prefix."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
                    "entity_type": {"type": "string"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
        {
            "name": "companion_list",
            "description": "List stored memories with optional filters.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "entity_type": {"type": "string"},
                    "name_contains": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "companion_forget",
            "description": "Archive (default) or hard-delete a memory by id.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "reason": {"type": "string"},
                    "hard_delete": {"type": "boolean", "default": False},
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "companion_context",
            "description": "Return the current-user dossier (identity, family, preferences, stats).",
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    ]


def handler_for(name: str) -> Callable[[CompanionMemoryClient, Mapping[str, Any]], Any] | None:
    return _HANDLERS.get(name)


def _handle_remember(client: CompanionMemoryClient, args: Mapping[str, Any]) -> dict[str, Any]:
    record = client.remember(
        content=str(args["content"]),
        name=args.get("name"),
        entity_type=str(args.get("entity_type") or "Concept"),
        tags=args.get("tags"),
        metadata=args.get("metadata"),
        source=str(args.get("source") or "hermes"),
    )

    return _record_to_dict(record)


def _handle_recall(client: CompanionMemoryClient, args: Mapping[str, Any]) -> dict[str, Any]:
    records = client.recall(
        query=str(args["query"]),
        limit=int(args.get("limit") or 10),
        entity_type=args.get("entity_type"),
    )

    return {
        "query": args["query"],
        "count": len(records),
        "results": [_record_to_dict(record) for record in records],
    }


def _handle_list(client: CompanionMemoryClient, args: Mapping[str, Any]) -> dict[str, Any]:
    records = client.list_memories(
        entity_type=args.get("entity_type"),
        name_contains=args.get("name_contains"),
        limit=int(args.get("limit") or 25),
    )

    return {"count": len(records), "results": [_record_to_dict(record) for record in records]}


def _handle_forget(client: CompanionMemoryClient, args: Mapping[str, Any]) -> dict[str, Any]:
    result = client.forget(
        memory_id=str(args["id"]),
        reason=args.get("reason"),
        hard_delete=bool(args.get("hard_delete", False)),
    )

    return dict(result)


def _handle_context(client: CompanionMemoryClient, _args: Mapping[str, Any]) -> dict[str, Any]:
    context = client.context()

    return {"context": context}


_HANDLERS: dict[str, Callable[[CompanionMemoryClient, Mapping[str, Any]], Any]] = {
    "companion_remember": _handle_remember,
    "companion_recall": _handle_recall,
    "companion_list": _handle_list,
    "companion_forget": _handle_forget,
    "companion_context": _handle_context,
}


def dispatch(client: CompanionMemoryClient, name: str, args: Mapping[str, Any]) -> Any:
    handler = handler_for(name)
    if handler is None:
        raise ValueError(f"unknown companion-memory tool: {name}")

    try:
        return handler(client, args)
    except CompanionMemoryError as exc:
        return {
            "error": True,
            "status": exc.status,
            "message": str(exc),
            "body": exc.body,
        }
