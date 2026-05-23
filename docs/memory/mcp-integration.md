# MCP Integration

The companion-memory MCP server is a stdio server. Any host that supports the
`mcpServers` configuration shape can run it.

## Prerequisites

1. CI-Server running (`make local`).
2. An API key — see `scripts/companion-memory/mint-api-key.sh` for a helper.
3. The MCP server built:
   ```bash
   yarn workspace @companionintelligence/companion-memory-mcp build
   ```

## Tools

| Tool                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `companion_remember`  | Store content as a memory.                                           |
| `companion_recall`    | Hybrid full-text + prefix search.                                    |
| `companion_list`      | List memories with optional filters.                                 |
| `companion_forget`    | Archive (default) or hard-delete a memory by id.                     |
| `companion_context`   | Return the user dossier used to pre-hydrate LLM prompts.             |
| `companion_health`    | Backend liveness check.                                              |

## Claude Code

Add to `~/.claude/settings.json` (or the project-local `.claude/settings.json`):

```json
{
  "mcpServers": {
    "companion-memory": {
      "command": "node",
      "args": ["/abs/path/CI-Server/mcp-servers/companion-memory/dist/index.js"],
      "env": {
        "COMPANION_MEMORY_URL": "http://localhost:3030",
        "COMPANION_MEMORY_API_KEY": "ci_xxx"
      }
    }
  }
}
```

Then in a Claude Code session:

```
/mcp                                # confirm the server is connected
/tools companion-memory             # list the tools
```

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%/Claude/claude_desktop_config.json` (Windows) with the same
`mcpServers` block. Restart Claude Desktop.

## Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "companion-memory": {
      "command": "node",
      "args": ["/abs/path/CI-Server/mcp-servers/companion-memory/dist/index.js"],
      "env": {
        "COMPANION_MEMORY_URL": "http://localhost:3030",
        "COMPANION_MEMORY_API_KEY": "ci_xxx"
      }
    }
  }
}
```

## OpenClaw

OpenClaw consumes the same MCP server, but pair it with the
[OpenClaw skill](./openclaw-integration.md) so the agent knows *when* to
invoke the tools.

## Custom hosts

Any host that knows how to spawn an MCP server over stdio works:

```bash
COMPANION_MEMORY_API_KEY=ci_xxx \
COMPANION_MEMORY_URL=http://localhost:3030 \
node /abs/path/CI-Server/mcp-servers/companion-memory/dist/index.js
```

The server will print a single line to stderr on startup:
`companion-memory MCP server connected (backend: http://localhost:3030)`

## Namespacing across MCP installations

If you connect the same backend from multiple machines or accounts, set
`COMPANION_MEMORY_NAMESPACE` to a per-install string. Every memory written
through that adapter will receive `metadata.namespace = <value>`, which you
can later filter on via `companion_list` (use `nameContains` for now, native
metadata filtering is on the roadmap).
