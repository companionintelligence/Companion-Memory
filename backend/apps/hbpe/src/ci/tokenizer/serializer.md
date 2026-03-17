# serializer.py

## Purpose
Writes the [SOD]…[EOD] token stream for each user-day into `ci.token_stream`.
Replaces the previous parquet-file approach so Phase 2 training queries the DB directly.

## Components

### `TokenSerializer.serialize_day`
- **Does**: Fetches L0/L1/L2 assignments for one calendar date, prepends SOD, appends EOD, deletes existing rows for that (user_id, date), then batch-inserts into `ci.token_stream`
- **Returns**: number of rows written (0 if no events that day)

### `TokenSerializer.serialize_range`
- **Does**: Calls `serialize_day` for every date in [start_date, end_date] inclusive
- **Returns**: total token rows written across all days

### `_fetch_tokens_for_day`
- **Does**: SQL joining `ci.events` → `ci.l1_event_cluster` → `ci.l1_clusters` (+ optional L2 via `ci.l2_content_cluster`) for one calendar date
- **Returns**: list of `{level, token_id, soft_prob_vector, bucket_idx}` dicts in chronological order

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `validator.py` | rows in `ci.token_stream` per user | table schema |
| Phase 2 trainer | `ci.token_stream` queryable by `(user_id, date, seq_order)` | column names |
| `test_step5_validate.py` | `serialize_range(user_id, start, end) -> int` | signature |

## Notes
- Implements T1.5 (CI-Server-ub5)
- Re-serializing a day is idempotent: existing rows are deleted before insert
- `soft_prob` stored as FLOAT4[] Postgres array literal `{v1,...}`
- L2 tokens are optional — only written when `ci.l2_content_cluster` has a match
- Migration: `20260228000001_hbpe_token_stream.sql`
- bucket_idx = floor((start_time - midnight) / 1800s), clamped to [0, 47]
