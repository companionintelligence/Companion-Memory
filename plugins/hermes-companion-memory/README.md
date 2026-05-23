# hermes-companion-memory

Hermes Agent memory-provider plugin that persists every observation to the
Companion Intelligence personal-memory server (`CI-Server`).

It implements the `agent.memory_provider.MemoryProvider` contract documented at
<https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin>
and exposes the same five remember/recall/list/forget/context tools that the
companion-memory MCP server uses, so the two surfaces stay symmetrical.

## Hooks implemented

| Hook                  | Behaviour                                                            |
| --------------------- | -------------------------------------------------------------------- |
| `system_prompt_block` | Injects the user dossier (identity, family, top preferences, stats). |
| `prefetch`            | Returns the top-5 recalled memories for the current query.           |
| `sync_turn`           | Persists every turn as a `Communication` entity (async, daemon).     |
| `on_session_end`      | Stores a session summary as a `Concept` entity.                      |
| `on_memory_write`     | Mirrors built-in `MEMORY.md` writes into the graph.                  |
| `shutdown`            | Closes the HTTP client.                                              |

## Installation

```bash
pip install -e plugins/hermes-companion-memory
hermes memory setup     # choose "companion-memory"
```

If the provider does not appear in the Hermes wizard, set up the entry point
manually with:

```bash
hermes plugins install --path plugins/hermes-companion-memory
```

## Configuration

Set either env vars or values in `$HERMES_HOME/companion_memory.json`:

| Key          | Env var                         | Description                                                |
| ------------ | ------------------------------- | ---------------------------------------------------------- |
| `base_url`   | `COMPANION_MEMORY_URL`          | CI-Server base URL (default `http://localhost:3030`).      |
| `api_key`    | `COMPANION_MEMORY_API_KEY`      | API key created via `POST /api/keys`. **Required**.        |
| `namespace`  | `COMPANION_MEMORY_NAMESPACE`    | Optional tag stamped onto every stored memory.             |
| `timeout`    | `COMPANION_MEMORY_TIMEOUT`      | Request timeout in seconds (default 15).                   |

`api_key` is treated as secret; Hermes routes it through the system keychain
during `hermes memory setup`. Non-secret fields are stored in plain JSON next
to the other Hermes provider configs.

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e plugins/hermes-companion-memory[dev]
pytest plugins/hermes-companion-memory
```

The unit tests stub Hermes' import so the package can be developed without a
Hermes runtime present.
