# nightly_finetune.py

## Purpose
One epoch of LoRA adapter fine-tuning on a single day's serialised token
stream (T3.2). Loads the calibrated HMT backbone, applies/resumes the
per-user LoRA adapter, trains for one epoch, and saves the updated adapter.
Designed to complete in < 5 minutes on CPU.

## Components

### `fine_tune_nightly(user_id, date, device)`
- **Does**: Loads `hmt_calibrated.pt` → applies LoRA → loads existing `lora_{user_id}.pt` if present → trains 1 epoch on `date`'s `ci.token_stream` rows → saves adapter → returns report dict.
- **Interacts with**: `_load_calibrated` (evaluator.py), `apply_lora`/`load_adapter`/`save_adapter` (lora.py), `_build_full_batch` (calibration.py), `TokenStreamDataset` (dataset.py)
- **Rationale**: Re-uses `_build_full_batch` so the training format exactly mirrors the calibration/eval format.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `nightly_runner.py` | `fine_tune_nightly(user_id, date) -> dict` | Signature |
| `test_step10_lora.py` | same | Signature |

## Notes
- Adapter path: `{models_dir}/hmt/lora_{user_id}.pt`
- AdamW lr=5e-5, grad clip max_norm=1.0
- Loss: joint CE on L0 + L1 positions (same form as T2.3)
- When Phase 4 adds `ci.prediction_log`, the caller (nightly_runner) should filter the dataset to mispredicted buckets before calling this function
- Implements T3.2 (CI-Server-76y)
