# evaluator.py

## Purpose
Leave-one-out evaluation of HMT accuracy on the held-out test set (T2.5).
Reports L0 top-1 accuracy and L1 top-3 accuracy; L2 skipped until content data available.

## Components

### `evaluate`
- **Does**: Loads hmt_calibrated.pt; for each test-day token, masks it and predicts from context; measures top-1 (L0) and top-3 (L1) accuracy; writes eval_report.json
- **Returns**: report dict

### `_load_calibrated`
- **Does**: Loads hmt_calibrated.pt (falls back to hmt_checkpoint.pt); returns (model, temperature)

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `test_step9_calibrate_eval.py` | `evaluate(user_id, test_ds) -> dict` | Signature |
| Phase 3+ | eval_report.json keys: `l0_top1_accuracy`, `l1_top3_accuracy` | Key names |

## Notes
- Implements T2.5 (CI-Server-stt)
- Targets: L0 top-1 ≥ 75%, L1 top-3 ≥ 65%
- Leave-one-out: each token is masked individually; all others are visible context
- With only 14 test days, accuracy estimates have wide confidence intervals
