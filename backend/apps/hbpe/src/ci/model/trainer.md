# trainer.py

## Purpose
MAE pre-training loop for the L0 HMT backbone (T2.2).
T2.3 will extend this file with the hierarchical joint fine-tuning loop.

## Components

### `train_l0_mae`
- **Does**: Runs N_EPOCHS of masked-token training on L0 sequences; early stops on val plateau; saves best checkpoint to `<models_dir>/hmt/l0_mae_checkpoint.pt`
- **Interacts with**: `L0MAEModel`, `build_l0_vocab`, `TokenStreamDataset`, AdamW, CosineAnnealingLR

### `_run_epoch`
- **Does**: One pass over a dataset (train or val); returns mean CE loss

### `_prepare_batch`
- **Does**: Converts one day's token list to tensors; applies 75% random masking to non-special tokens; returns `(token_ids, bucket_idxs, padding_mask, targets, mask_positions)`

### `_masked_ce_loss`
- **Does**: Cross-entropy averaged over masked positions only (ignores SOD/EOD)

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `test_step7_pretrain.py` | `train_l0_mae(user_id, train_ds, val_ds) -> Path` | Signature |
| T2.3 trainer | checkpoint keys: `model_state`, `epoch`, `vocab_size`, `val_loss` | Keys |

## Notes
- MASK_RATE=0.75, LR=1e-4, N_EPOCHS=50, PATIENCE=7, WEIGHT_DECAY=0.01
- Grad clipping at 1.0 for stability
- Each day is a batch of 1 (no padding needed across days)
