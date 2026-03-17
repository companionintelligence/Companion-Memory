# database.py

## Purpose
Thin psycopg2 connection context manager shared by all HBPE tokenizer modules.
Centralises connection setup, commit/rollback, and UUID adapter registration.

## Components

### `get_conn`
- **Does**: Yields an open psycopg2 connection; commits on clean exit, rolls back on exception
- **Interacts with**: `ci.config.settings.database_url`, `psycopg2.extras.register_uuid`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| All tokenizer modules | `with get_conn() as conn:` yields a live `psycopg2` connection | Context manager signature |

## Notes
- One connection per call — not a pool. Acceptable for nightly batch jobs; revisit if real-time routing becomes a bottleneck.
