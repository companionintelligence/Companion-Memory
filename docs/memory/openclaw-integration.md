# OpenClaw Integration

The skill bundle in
[`plugins/openclaw-companion-memory/`](../../plugins/openclaw-companion-memory)
wires OpenClaw into the same companion-memory MCP server used by Claude Code
and Cursor.

## How OpenClaw memory works (recap)

OpenClaw's built-in memory is **plain Markdown** in the workspace:

- `MEMORY.md` — durable long-term notes.
- `memory/YYYY-MM-DD.md` — daily working notes (auto-loaded for today + yesterday).
- `DREAMS.md` — optional consolidation log.

Search and retrieval use `memory_search` and `memory_get` with hybrid
keyword + vector matching when embeddings are configured.

The companion-memory skill **adds a second tier**: a queryable knowledge
graph hosted on the user's CI-Server. The two tiers complement each other —
workspace markdown stays great for "what we decided in this repo", and the
graph holds cross-session, cross-machine personal context.

## Install

```bash
# 1. Build the MCP server
yarn workspace @companionintelligence/companion-memory-mcp build

# 2. Run the installer
COMPANION_MEMORY_API_KEY=ci_xxx \
  ./plugins/openclaw-companion-memory/scripts/install.sh \
  ~/.openclaw/workspace
```

The installer:

1. Copies `SKILL.md` + `openclaw.skill.yaml` to
   `~/.openclaw/workspace/skills/companion-memory/`.
2. Adds a `companion-memory` server entry to
   `~/.openclaw/workspace/mcp_servers.json`.

Restart OpenClaw. The agent will discover the skill on next start.

## Trigger keywords

The skill is configured to wake up for these phrases:

- "remember", "don't forget", "save this", "keep this in mind"
- "what do I like", "who is", "what's my…"

For other situations OpenClaw will still call the tools when the model thinks
it's appropriate, but trigger keywords make it cheap to discover.

## Manual install

If you'd rather not run the installer:

1. Drop `SKILL.md` at `<workspace>/skills/companion-memory/SKILL.md`.
2. Add to `<workspace>/mcp_servers.json`:

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

## Two-tier memory pattern

A useful rule of thumb the SKILL.md teaches the agent:

- **Workspace facts** → write to `MEMORY.md` (the OpenClaw default).
- **Personal facts** → write via `companion_remember` so they're available
  next session, on a different machine, and to Claude Code.

The agent can read both tiers in the same prompt and merge results.

## Verifying

In an OpenClaw session, ask: *"What does the companion-memory skill expose?"*
The agent should list the six `companion_*` tools.

Then: *"Remember that I prefer dark mode."* → should call `companion_remember`.
Confirm in CI-Server: visit the graph UI and you'll see a new `Concept` node.
