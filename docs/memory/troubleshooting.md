# Troubleshooting

## The smoke test fails

```bash
COMPANION_MEMORY_API_KEY=ci_xxx \
  ./scripts/companion-memory-smoke-test.sh
```

Common causes and fixes:

| Symptom                                                    | Likely cause                                | Fix                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Failed to connect to localhost`                           | CI-Server not running                       | `make local` from the repo root.                                                             |
| `401` on every endpoint                                    | API key invalid / expired                   | Re-mint via `scripts/companion-memory/mint-api-key.sh`.                                      |
| `404` on `/api/memory/recall` or `/api/graph/context`      | Backend not rebuilt after pulling new code  | Restart the API (`yarn dev` in `backend/apps/api`) or rebuild the Docker image.              |
| `recall did not return the just-written memory`            | Write succeeded but search index lagging    | The graph search runs synchronously; if you see this consistently, check `GraphQueryService` logs. |
| `BadRequestException: Authenticated user context required` | API key was minted for a deactivated user   | Mint a new key under an active user.                                                         |

## MCP server doesn't appear in Claude Code

1. Confirm the path is absolute in `~/.claude/settings.json`.
2. Run the binary directly and check stderr:
   ```bash
   COMPANION_MEMORY_API_KEY=ci_xxx \
     node /abs/path/CI-Server/mcp-servers/companion-memory/dist/index.js
   ```
   You should see `companion-memory MCP server connected (backend: …)`.
3. In Claude Code, run `/mcp` to see connection state.
4. Check `~/.claude/logs/` for any startup errors.

## Hermes plugin not listed by `hermes memory setup`

1. Confirm the package installed in the same Python environment Hermes uses:
   ```bash
   pip show hermes-companion-memory
   ```
2. Check that `companion_memory.register` is importable:
   ```bash
   python -c "import companion_memory; companion_memory.register(None)"
   # NameError on `ctx.register_memory_provider` is fine —
   # ImportError is a problem.
   ```
3. Verify the `plugin.yaml` is bundled into the install (look for
   `companion_memory/plugin.yaml` in `pip show -f hermes-companion-memory`).

## OpenClaw not calling the tools

1. Run `bash scripts/companion-memory-smoke-test.sh` to confirm the backend
   is healthy.
2. In an OpenClaw session, ask the agent to list its available MCP servers —
   `companion-memory` should be in the list.
3. If it isn't, open `~/.openclaw/workspace/mcp_servers.json` and confirm the
   `companion-memory` entry exists and points at a built `index.js`.
4. If the server is listed but tools aren't being called, ask explicitly:
   *"Use the companion_health tool to check the backend."* If it works
   on demand but isn't fired automatically, the trigger keywords in
   `SKILL.md` aren't matching the conversation — that's a tuning issue,
   not a bug.

## "Permission denied" on the scripts

```bash
chmod +x scripts/install-companion-memory.sh \
         scripts/companion-memory-smoke-test.sh \
         plugins/openclaw-companion-memory/scripts/install.sh
```

## Where logs live

| Surface           | Log location                                                   |
| ----------------- | -------------------------------------------------------------- |
| CI-Server         | stdout of the `api` service (or Docker logs).                  |
| MCP server        | stderr; goes wherever the host writes it (e.g. Claude logs).   |
| Hermes plugin     | Hermes' standard logger (`logging.getLogger("companion_memory.provider")`). |
| OpenClaw skill    | OpenClaw's session log.                                        |

## Getting help

Open an issue at https://github.com/companionintelligence/CI-Server and tag
it with `area/memory`.
