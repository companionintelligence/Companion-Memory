# @companionintelligence/companion-memory-mcp

A stdio MCP server that exposes the Companion Intelligence memory graph to any
MCP-compatible client (Claude Code, Claude Desktop, OpenClaw, Cursor, ...).

Each tool maps 1:1 onto a CI-Server endpoint that exists on `main`:

| Tool                | Backed by                                          | Action                                                                  |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `companion_recall`  | `POST /api/memory/recall`                          | Semantic recall returning a Markdown block ready for prompt injection.  |
| `companion_turn`    | `POST /api/memory/turn`                            | Sync a conversation turn. Backend is a no-op stub today; forward-compatible. |
| `companion_context` | `GET /api/graph/context`                           | Current-user dossier as JSON.                                           |
| `companion_search`  | `GET /api/graph/search`                            | Structured search returning nodes + links.                              |
| `companion_node`    | `GET /api/graph/node`                              | Single entity + bounded neighbour traversal.                            |

## Configuration

The server reads its configuration from environment variables:

| Variable                       | Required | Default                  | Notes                                                          |
| ------------------------------ | -------- | ------------------------ | -------------------------------------------------------------- |
| `COMPANION_MEMORY_URL`         | no       | `http://localhost:3030`  | Base URL of the CI-Server API (no `/api` suffix).              |
| `COMPANION_MEMORY_API_KEY`     | **yes**  | —                        | API key generated via `POST /api/keys` (sent as `x-api-key`).  |
| `COMPANION_MEMORY_TIMEOUT_MS`  | no       | `15000`                  | Per-request timeout in milliseconds.                           |
| `COMPANION_MEMORY_NAMESPACE`   | no       | —                        | Optional namespace stamped into every memory's metadata.       |
| `COMPANION_MEMORY_LOG_LEVEL`   | no       | `info`                   | Reserved for future logging hooks.                             |

## Installation

```bash
yarn workspaces focus @companionintelligence/companion-memory-mcp
yarn workspace @companionintelligence/companion-memory-mcp build
```

Or, from this directory:

```bash
yarn install
yarn build
```

## Use with Claude Code

Append to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "companion-memory": {
      "command": "node",
      "args": ["/abs/path/to/CI-Server/mcp-servers/companion-memory/dist/index.js"],
      "env": {
        "COMPANION_MEMORY_URL": "http://localhost:3030",
        "COMPANION_MEMORY_API_KEY": "ci_xxx"
      }
    }
  }
}
```

## Use with OpenClaw

Add to `~/.openclaw/workspace/mcp_servers.json`:

```json
{
  "companion-memory": {
    "command": "node",
    "args": ["/abs/path/to/CI-Server/mcp-servers/companion-memory/dist/index.js"],
    "env": {
      "COMPANION_MEMORY_URL": "http://localhost:3030",
      "COMPANION_MEMORY_API_KEY": "ci_xxx"
    }
  }
}
```

A companion `plugins/openclaw-companion-memory/SKILL.md` describes when the
agent should reach for these tools.

## Smoke test

```bash
COMPANION_MEMORY_URL=http://localhost:3030 \
COMPANION_MEMORY_API_KEY=ci_xxx \
yarn smoke
```

The smoke test runs `health → remember → recall → forget` end-to-end against a
live backend and verifies the round-trip.
