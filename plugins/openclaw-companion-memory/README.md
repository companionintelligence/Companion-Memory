# openclaw-companion-memory

OpenClaw skill that exposes the Companion Intelligence personal-memory graph to
an OpenClaw agent. The skill is a thin overlay on top of the companion-memory
MCP server.

## Files

| File                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `SKILL.md`                 | Human-readable + agent-readable instructions on when/how to use. |
| `openclaw.skill.yaml`      | Machine-readable skill manifest used by OpenClaw discovery.      |
| `scripts/install.sh`       | One-shot installer for an OpenClaw workspace.                    |

## Install into an OpenClaw workspace

```bash
yarn workspace @companionintelligence/companion-memory-mcp build
COMPANION_MEMORY_API_KEY=ci_xxx \
  ./plugins/openclaw-companion-memory/scripts/install.sh \
  ~/.openclaw/workspace
```

The installer:

1. Copies `SKILL.md` + `openclaw.skill.yaml` to
   `<workspace>/skills/companion-memory/`.
2. Adds a `companion-memory` entry to `<workspace>/mcp_servers.json`, wiring it
   to the built MCP server in `mcp-servers/companion-memory/dist/index.js`.

Restart OpenClaw and the agent will start using the new tools whenever the
trigger keywords in `SKILL.md` fire.

## Manual configuration

If you prefer to wire things up by hand, add this entry to your OpenClaw
`mcp_servers.json`:

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

Then drop `SKILL.md` into `<workspace>/skills/companion-memory/SKILL.md` so
OpenClaw can discover the skill at load time.
