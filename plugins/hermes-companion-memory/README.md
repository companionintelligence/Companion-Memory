# hermes-companion-memory

Companion Intelligence local-first personal memory plugin for [Hermes Agent](https://github.com/companion-intelligence/hermes-agent).

## Installation

```bash
pip install hermes-companion-memory
```

Or directly from this directory during development:

```bash
pip install -e plugins/hermes-companion-memory/
```

## Configuration

Set the following environment variables (add to `~/.zshrc` or `~/.bashrc`):

```bash
export COMPANION_API_KEY="your-api-key"
export COMPANION_BASE_URL="https://api.companion.intelligence"  # optional
export COMPANION_AGENT_ID="my-agent"                            # optional
```

Obtain an API key from [https://companion.intelligence/dashboard](https://companion.intelligence/dashboard).

## Quick-start

```python
from hermes_companion_memory import register

# In a custom Hermes bootstrap script:
register(ctx)
```

Hermes will auto-discover and register the plugin via the entry point
`hermes_agent.plugins` — no manual registration needed in normal usage.

## CLI

```bash
hermes companion status   # Check whether the provider is configured
hermes companion setup    # Print configuration instructions
```

## v1 / v2 Feature Matrix

| Feature | v1 | v2 |
|---|---|---|
| `prefetch` hook (context injection) | returns `""` (disabled) | calls `fetch_injection()` |
| `sync_turn` hook (async POST) | daemon thread, fire-and-forget | + retry / back-off |
| `on_session_end` hook | fire-and-forget POST | + structured session summary |
| `on_pre_compress` hook | fire-and-forget POST | + insight extraction |
| `companion_search` tool | stub (not implemented) | real memory search |
| `companion_remember` tool | stub (not implemented) | graph upsert |
| Local graph cache | no | yes (SQLite) |

## Running Tests

```bash
cd plugins/hermes-companion-memory
python -m pytest hermes_companion_memory/tests/ -v
```

No network access required — all client calls are mocked.

## License

MIT
