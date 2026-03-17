# dataset.py

## Purpose
Loads token sequences from `ci.token_stream` for HMT model training.
Provides the train/val/test split and a dataset abstraction over daily sequences.

## Components

### `make_splits`
- **Does**: Fetches all dates for a user, holds out last 14 days as test, stratifies remainder by day-of-week into train (85%) and val (15%)
- **Returns**: `{"train": [...], "val": [...], "test": [...]}` — ISO date strings
- **Rationale**: Day-of-week stratification ensures both splits see weekday and weekend patterns

### `TokenStreamDataset`
- **Does**: Iterable/indexable dataset over a list of dates; each item is one day's token sequence as a list of dicts
- **Interacts with**: `_fetch_day` → `ci.token_stream`

### `_fetch_dates`
- **Does**: `SELECT DISTINCT date FROM ci.token_stream WHERE user_id = %s ORDER BY date`

### `_fetch_day`
- **Does**: Fetches full token sequence for one date in `seq_order`
- **Returns**: `[{"level", "token_id", "soft_prob", "bucket_idx"}, ...]`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `trainer.py` | `make_splits(user_id) -> dict` | Return keys |
| `trainer.py` | `TokenStreamDataset[i] -> list[dict]` with keys `level, token_id, soft_prob, bucket_idx` | Key names |

## Notes
- Implements T2.1 (CI-Server-oj3)
- `VAL_FRACTION = 0.15`, `TEST_DAYS = 14`
- No PyTorch dependency — plain Python iteration; trainer wraps in a DataLoader if needed
