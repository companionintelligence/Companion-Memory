# transformer.py

## Purpose
HMT backbone — the L0 masked autoencoder model for Phase 2 pre-training.
L1/L2 cross-attention layers will be added in T2.3.

## Components

### `L0MAEModel`
- **Does**: Token embedding + bucket position embedding → TransformerEncoder → linear head → logits over L0 vocab
- **Interacts with**: `vocab.PAD_IDX`, `vocab.MASK_IDX`
- **Rationale**: Pre-LN (`norm_first=True`) for stability on small corpora; d_model=64 to avoid overfitting 90 days of data

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `trainer.py` | `L0MAEModel(vocab_size)`, `forward(token_ids, bucket_idxs, padding_mask) -> (B,T,V)` | Signature |

## Notes
- d_model=64, n_heads=4, n_layers=2, d_ff=128, dropout=0.1
- MAX_BUCKETS=48 (30-min slots per day)
- L1/L2 layers: added in T2.3 as cross-attention on top of this backbone
