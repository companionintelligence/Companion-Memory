# vocab.py

## Purpose
Maps token_id strings ↔ integer indices for each hierarchy level.
L0 vocab is fixed (11 tokens). L1/L2 vocabs are built dynamically from the DB.

## Components

### `Vocab`
- **Does**: Dataclass holding `token_to_idx` dict and `idx_to_token` list; `encode`/`decode` methods

### `build_l0_vocab`
- **Does**: Returns fixed Vocab with PAD/MASK/SOD/EOD + 8 L0_CLASSES (11 tokens total)

### `build_l1_vocab`
- **Does**: Queries active `ci.l1_clusters` for user; returns Vocab with special tokens + cluster UUIDs

### `build_l2_vocab`
- **Does**: Queries active `ci.l2_clusters` for user; same pattern as L1

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `trainer.py` | `build_l0_vocab() -> Vocab`, `len(vocab)` for embedding size | Vocab size |
| `transformer.py` | `PAD_IDX`, `MASK_IDX` constants | Index values |

## Notes
- PAD=0, MASK=1, SOD=2, EOD=3 — fixed across all vocab levels
- L1/L2 vocabs must be rebuilt when new clusters are discovered
