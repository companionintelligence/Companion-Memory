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
| `system_prompt_block`  | Calls `GET /memory/context` and renders user dossier as a system-prompt section. |
| `prefetch(query)`      | Calls `GET /memory/recall` with `limit=5` and formats the snippets.  |
| `sync_turn`            | Persists `USER: … / ASSISTANT: …` as a `Communication` entity on a daemon thread. |
| `on_session_end`       | Stores a concatenated session summary as a `Concept` entity.         |
| `on_memory_write`      | Mirrors built-in MEMORY.md writes into the graph.                    |
| `handle_tool_call`     | Routes the 5 companion_* tools to the matching REST endpoint.        |
| `shutdown`             | Closes the HTTP client.                                              |

## Tools the provider exposes

These are the exact tool names Hermes registers when companion-memory is
the active provider — symmetrical with the MCP server's tools, so the same
prompts work in both surfaces.

- `companion_remember`
- `companion_recall`
- `companion_list`
- `companion_forget`
- `companion_context`

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
