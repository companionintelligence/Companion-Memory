# Companion Memory — Architecture

## Storage layer

Memories live in the existing CI-Server knowledge graph (Postgres + Apache
AGE). Each "memory" is an active `GraphNodeEntity` row owned by the user, with
optional relationships to other nodes.

```
GraphNodeEntity                          RelationshipEntity
┌──────────────────────────┐             ┌────────────────────────┐
│ entity_id           UUID │←──fromEntity│ from_entity_id    UUID │
│ owner_user_id       UUID │             │ to_entity_id      UUID │
│ entity_type         text │             │ relationship_type text │
│ name                text │             │ properties        jsonb│
│ description         text │←──content   │ strength         float │
│ properties          jsonb│             │ is_bidirectional bool  │
│ search_content      text │             └────────────────────────┘
│ is_active           bool │
│ created_at        timestamp
│ updated_at        timestamp
└──────────────────────────┘
```

This is the same store the existing `readKnowledge` / `writeKnowledge` /
`forgetKnowledge` native tools use, so anything written via the memory API is
visible in the existing graph UI and is queryable by every existing tool.

## REST surface — `/api/memory/*`

Added by [MemoryController](../../backend/apps/api/src/domains/memory/controllers/MemoryController.ts).
Auth: `x-api-key` header (or session JWT). Every endpoint scopes by the
authenticated user.

### `POST /api/memory/remember`

Stores content as a graph node (default `entity_type=Concept`). The full text
goes into `description` and `search_content`; tags and metadata land in the
node's `properties` JSON.

```json
{
  "content": "Liam prefers Pilates over yoga.",
  "name": "Pilates preference",
  "entityType": "Concept",
  "tags": ["preferences", "fitness"],
  "metadata": { "confidence": 0.9 },
  "source": "claude-code"
}
```

Response:

```json
{
  "success": true,
  "memory": {
    "id": "0190f7ac-...",
    "entityType": "Concept",
    "name": "Pilates preference",
    "content": "Liam prefers Pilates over yoga.",
    "tags": ["preferences", "fitness"],
    "metadata": { "confidence": 0.9, "source": "claude-code" }
  }
}
```

### `GET /api/memory/recall`

```
GET /api/memory/recall?query=pilates&limit=10&entityType=Concept
```

Runs the existing hybrid search (`searchNodesByText` + `searchNodesByPrefix`)
and returns up to `limit` results merged and deduplicated, optionally filtered
to a single entity type.

### `GET /api/memory/list`

Browse memories with simple filters (`entityType`, `nameContains`, `limit`).

### `DELETE /api/memory/forget/:id`

Archives the entity by default (`deactivateEntities(..., hardDelete=false)`).
Pass `{"hardDelete": true}` in the body to remove it from the active graph
entirely.

### `GET /api/memory/context`

Wraps `UserContextService.getUserContextForLLM`, returning the user's identity,
family, top preferences, and quick stats — the same shape the existing
`/api/graph/context` endpoint emits.

### `GET /api/memory/health`

Liveness probe used by the smoke test and the MCP `companion_health` tool.

## Adapter layer

Three thin adapters consume the REST API and expose it in each ecosystem's
native style. None of them stores state of their own — they're all
stateless translators.

### MCP server (`mcp-servers/companion-memory/`)

- Stdio MCP server written in TypeScript (`@modelcontextprotocol/sdk`).
- Six tools, one per REST endpoint plus `companion_health`.
- Configured entirely through env vars — no on-disk state.
- Designed to be embedded into Claude Code, Claude Desktop, Cursor, OpenClaw
  (which speaks MCP), and any other MCP-capable host.

### Hermes plugin (`plugins/hermes-companion-memory/`)

- Implements `agent.memory_provider.MemoryProvider`.
- Single active provider — competes with honcho/mem0/etc.
- Hooks: `system_prompt_block`, `prefetch`, `sync_turn`, `on_session_end`,
  `on_memory_write`, `shutdown`.
- Stores `api_key` via Hermes' standard secret routing; other config lives in
  `$HERMES_HOME/companion_memory.json`.

### OpenClaw skill (`plugins/openclaw-companion-memory/`)

- A `SKILL.md` + `openclaw.skill.yaml` that point OpenClaw at the
  companion-memory MCP server.
- Trigger keywords: "remember", "don't forget", "save this", "what do I
  like", "who is", "keep this in mind".
- All work goes through the MCP server, so OpenClaw sees the same tools as
  Claude Code and Hermes.

## End-to-end data flow

1. The agent decides to store a fact.
2. It calls the appropriate adapter tool (e.g. `companion_remember`).
3. The adapter `POST`s `/api/memory/remember` with the auth header.
4. `MemoryController` calls `GraphEventService.upsertNode`, which emits a
   `GRAPH_NODE_UPSERTED` event.
5. Existing graph-write listeners persist the node and update derived state
   (search index, embeddings, summaries).
6. Subsequent `companion_recall` calls hit the same `GraphQueryService`
   pipeline the rest of the system uses.

There is no separate memory store, no separate index, no separate sync
process. The new endpoints are pure surface; the data is the data.
