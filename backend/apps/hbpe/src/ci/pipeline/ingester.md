# ingester.py

## Purpose
Async event stream ingester (T4.3). Listens to PostgreSQL NOTIFY channels
for new behavioural events, debounces bursts (5s window), and invalidates
the InferenceEngine output-cache for the affected date + user.

## Components

### `EventIngester`
- **Does**: Manages a background asyncio task that subscribes to `ci_events`, `ci_browser_activity`, `ci_communications` LISTEN channels. On notification, debounces then calls `engine.invalidate(date)` and re-runs the tokeniser for the affected day.
- **Interacts with**: `asyncpg` (preferred), polling fallback, `InferenceEngine.invalidate`, `TokenSerializer.serialize_day`

### `EventIngester.start() / stop()`
- **Does**: Create/cancel the `_listen_loop` asyncio task. Called from FastAPI lifespan.

### `_dispatch(user_id, date_str)`
- **Does**: Adds date to pending set; cancels and reschedules the per-user debounce task.

### `_flush_after_debounce(user_id)`
- **Does**: Waits `DEBOUNCE_SEC=5`, then invalidates all pending dates and queues a re-serialise for today if it's in the pending set.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `api.py` | `EventIngester(engine_registry)`, `.start()`, `.stop()` | Constructor signature |
| `InferenceEngine` | `.invalidate(date)` | Method signature |

## Notes
- asyncpg is preferred; falls back to polling `ci.token_stream` on `serialized_at` if asyncpg unavailable
- PostgreSQL NOTIFY payloads must include `{user_id, date}` JSON — requires DB triggers (Phase 5)
- Implements T4.3 (CI-Server-32t)
