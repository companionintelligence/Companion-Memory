# Hermes Integration

The plugin lives in [`plugins/hermes-companion-memory/`](../../plugins/hermes-companion-memory).
It implements the `MemoryProvider` ABC described in the
[Hermes plugin developer guide](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin).

## Install

```bash
pip install -e plugins/hermes-companion-memory
```

This drops a `register(ctx)` callable on the `companion_memory` import path
that Hermes discovers automatically on next agent start.

## Configure

You can configure via env vars or the interactive wizard.

### Interactive

```bash
hermes memory setup
# choose "companion-memory"
# fill in base_url, api_key, namespace, timeout
```

The wizard stores non-secret values in `$HERMES_HOME/companion_memory.json`
and stows `api_key` in the system keychain alongside the other providers'
secrets.

### Environment variables

| Variable                       | Default                  | Notes                                                   |
| ------------------------------ | ------------------------ | ------------------------------------------------------- |
| `COMPANION_MEMORY_URL`         | `http://localhost:3030`  | CI-Server base URL.                                     |
| `COMPANION_MEMORY_API_KEY`     | —                        | **Required**. CI-Server API key (sent as `x-api-key`).  |
| `COMPANION_MEMORY_NAMESPACE`   | session id               | Stamped into every stored memory's metadata.            |
| `COMPANION_MEMORY_TIMEOUT`     | `15.0`                   | Request timeout, seconds.                               |
| `HERMES_HOME`                  | `~/.hermes`              | Where the config file lives.                            |

## How the provider behaves

| Hermes hook            | What the plugin does                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `is_available`         | True when `COMPANION_MEMORY_API_KEY` or `$HERMES_HOME/companion_memory.json` is present. |
| `initialize`           | Builds an HTTP client; loads config; logs base_url + namespace.      |
| `system_prompt_block`  | Calls `GET /api/graph/context` and renders the user dossier as a Markdown system-prompt block. |
| `prefetch(query)`      | Calls `POST /api/memory/recall` (`maxResults=5`) and injects the returned `block` directly. |
| `sync_turn`            | `POST /api/memory/turn` on a daemon thread. Backend persistence is currently a stub; calling it is forward-compatible. |
| `on_session_end`       | `POST /api/memory/turn` with the full message list.                  |
| `on_memory_write`      | Logged-only no-op. Activates once `POST /api/memory/persist` ships.  |
| `handle_tool_call`     | Routes `companion_recall`, `companion_context`, `companion_search`.  |
| `shutdown`             | Closes the HTTP client.                                              |

## Tools the provider exposes

When companion-memory is the active Hermes provider, three tools become
available to the agent loop:

- `companion_recall` — semantic recall returning a Markdown block.
- `companion_context` — user dossier (identity, family, preferences) as JSON.
- `companion_search` — structured graph search returning nodes + links.

These are deliberately the same three tools the MCP server exposes from
the agent-shaped surface, so the same prompts behave consistently across
Hermes, Claude Code, and OpenClaw.

## Disable / switch off

```bash
hermes memory off
# or switch to a different provider:
hermes memory setup
```

Disabling the provider does **not** delete anything from CI-Server. Memories
remain in the graph and continue to be reachable from Claude Code, OpenClaw,
or the web UI.

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md). The most common failures are
unreachable backend, expired API key, and `HERMES_HOME` pointing at the
wrong profile.
