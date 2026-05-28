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

## REST surfaces

Two surfaces today, both auth'd with `x-api-key` (or session JWT) and
scoped per-user:

| Surface                                                | Auth         | Shape                                              | Best for                                                    |
| ------------------------------------------------------ | ------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| `POST /api/memory/recall` + `POST /api/memory/turn`    | `ApiKeyGuard`| Markdown block (`recall`) / no-op stub (`turn`).   | Hermes hooks (`prefetch`, `sync_turn`); OpenClaw assemble.  |
| `GET /api/graph/{context,search,node,data}`            | `JwtOrApiKeyAuthGuard` | Structured JSON.                         | MCP explicit tool use, web UI, scripts.                     |

### `/api/memory/*` — provided by [AgentModule](../../backend/apps/api/src/domains/agent/index.ts)

Despite the name, this module lives under `domains/agent/` — it's the
agent-loop-facing surface. Two endpoints today:

- `POST /api/memory/recall` — body `{query, maxResults}`, returns
  `{block, resultCount}` where `block` is a Markdown snippet pre-formatted
  for prompt injection (built via `SearchService.search` with `mode: 'keyword'`).
- `POST /api/memory/turn` — body `{messages, sessionId}`, currently a
  no-op stub. The endpoint is reserved so adapters can already call it;
  thread + message persistence lands here once that path is implemented.
- `POST /api/memory/persist` — declared as a no-op route comment in the
  controller, reserved for explicit `on_memory_write` flows from Hermes
  and `memory_store` from OpenClaw.

### `/api/graph/*` — provided by [MemoryModule.GraphController](../../backend/apps/api/src/domains/memory/controllers/GraphController.ts)

The structured-JSON surface:

- `GET /api/graph/context` — the user dossier (`currentUser`, `familyMembers`,
  `topPreferences`, `quickStats`).
- `GET /api/graph/search?query=&limit=` — hybrid keyword + prefix search,
  returns `{nodes, links}`.
- `GET /api/graph/node?entityId=&maxDepth=&maxNodes=&maxEdges=` — single
  entity plus bounded neighbour traversal.
- `GET /api/graph/data` — full graph snapshot (capped at 200 nodes).

## Adapter layer

Three thin adapters consume those two surfaces and expose them in each
ecosystem's native style. None of them stores state of their own.

### MCP server (`mcp-servers/companion-memory/`)

- Stdio MCP server written in TypeScript (`@modelcontextprotocol/sdk`).
- Five tools, one per backend endpoint:
  - `companion_recall` → `POST /api/memory/recall`
  - `companion_turn` → `POST /api/memory/turn`
  - `companion_context` → `GET /api/graph/context`
  - `companion_search` → `GET /api/graph/search`
  - `companion_node` → `GET /api/graph/node`
- Configured entirely through env vars — no on-disk state.
- Embeddable into Claude Code, Claude Desktop, Cursor, OpenClaw, and any
  other MCP-capable host.

### Hermes plugin (`plugins/hermes-companion-memory/`)

- Implements `agent.memory_provider.MemoryProvider`.
- Hook mapping:
  - `system_prompt_block` → `GET /api/graph/context` (formatted client-side).
  - `prefetch(query)` → `POST /api/memory/recall` (returns the block directly).
  - `sync_turn(...)` → `POST /api/memory/turn` (async, daemon thread).
  - `on_session_end(messages)` → `POST /api/memory/turn` with the full session.
  - `on_memory_write(...)` → logged-only no-op until `/api/memory/persist` lands.
- Three tools exposed to the agent: `companion_recall`, `companion_context`,
  `companion_search`.

### OpenClaw skill (`plugins/openclaw-companion-memory/`)

- A `SKILL.md` + `openclaw.skill.yaml` that point OpenClaw at the
  companion-memory MCP server.
- Trigger keywords: "remember", "don't forget", "save this", "what do I
  like", "who is", "keep this in mind".
- All work goes through the MCP server, so OpenClaw sees the same tools
  Claude Code does.

## End-to-end data flow (recall)

1. The agent decides it needs context for a turn.
2. The Hermes plugin's `prefetch(query)` runs.
3. It `POST`s `/api/memory/recall`.
4. `RecallService.recall` calls `SearchService.search` (`mode: 'keyword'`)
   against the existing entity index — graph (Apache AGE) + embeddings
   (pgvector) + FTS (tsvector) all live in the same Postgres.
5. Results are formatted into a Markdown block, capped, and returned.
6. The block is injected into the model prompt for the current turn.

## End-to-end data flow (turn / write)

Today the write path is a stub:

1. The Hermes plugin's `sync_turn(user_content, assistant_content)` fires.
2. It `POST`s `/api/memory/turn` on a daemon thread.
3. `MemoryController.turn` currently returns immediately (no-op).

When the team implements the persistence in `MemoryController.turn`, the
plugin gets it for free — no client change required.
