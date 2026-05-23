---
name: companion-memory
description: |
  Persistent memory across OpenClaw sessions, backed by the Companion Intelligence
  personal memory graph (CI-Server). Use whenever the user references "remember",
  "what do I like", "what did we decide", "save this for later", or asks about
  people, places, preferences, or prior decisions that may have been stored
  outside the current workspace.
version: 0.1.0
provider: companion-memory
transport: mcp
tools:
  - companion_remember
  - companion_recall
  - companion_list
  - companion_forget
  - companion_context
  - companion_health
---

# Companion Memory for OpenClaw

OpenClaw's built-in memory lives in workspace markdown files (`MEMORY.md`,
`memory/YYYY-MM-DD.md`). This skill adds a **second tier**: a long-lived,
queryable knowledge graph hosted in the user's CI-Server.

## When to use

- The user says **"remember"**, **"don't forget"**, **"save this"**, **"keep
  this in mind"**, or otherwise asks you to persist a fact.
- The user asks **"what do I like / dislike"**, **"what's my..."**,
  **"who is..."**, or anything that suggests cross-session recall.
- You want to **pre-hydrate** before answering a personal question — call
  `companion_context` to load the user's dossier (identity, family, top
  preferences), then continue.
- The user explicitly asks to **forget** something — call `companion_forget`
  with `hard_delete=true` only when they say "delete permanently" or similar.

## When NOT to use

- Pure code or workspace state. Use `MEMORY.md` and the workspace daily files
  for project decisions, code patterns, and ephemeral notes.
- Anything that should remain local to a single session — daily notes belong
  in `memory/YYYY-MM-DD.md`.

## Tool playbook

### `companion_context`

Call this at session start (or before the first personal question) to fetch
the user's identity, family, and top preferences. Cheap; safe to call once
per session.

### `companion_recall`

Hybrid full-text + prefix search. Use specific keywords; the search is across
every memory the user has stored. Set `limit` higher (20–30) when triaging.

### `companion_remember`

Store new facts. **Always**:

- Set `tags` to include `openclaw` plus a topic tag (e.g. `preferences`,
  `family`, `project:<name>`).
- Use `source: "openclaw"` so cross-tool provenance stays clear.
- Pass a meaningful `name` for facts that have a natural title.

### `companion_list`

Quick browse of what's stored. Filter by `entity_type` (`Concept`, `Person`,
`Place`, `Event`, `Communication`) when the user asks to see "all people I
know" or similar.

### `companion_forget`

Default to `hard_delete=false` (archive). Only hard-delete on explicit user
request. Always pass a `reason` describing why.

## Integration notes

- Transport is **MCP over stdio** via the companion-memory MCP server.
- Auth uses the CI-Server `x-api-key` header — configure
  `COMPANION_MEMORY_API_KEY` in the OpenClaw `mcp_servers.json` env block.
- The same backend powers Claude Code and Hermes, so memories written here
  are visible there and vice-versa.
