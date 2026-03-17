# calibration.py

## Purpose
Temperature scaling and ECE measurement for the HMT model (T2.4).
Finds the scalar T that minimises NLL on the val set, then saves hmt_calibrated.pt.

## Components

### `calibrate`
- **Does**: Loads hmt_checkpoint.pt → measures ECE before → grid-searches T → measures ECE after → saves hmt_calibrated.pt + calibration_report.json
- **Returns**: calibration report dict

### `_find_temperature`
- **Does**: Grid search over [0.1, 5.0] in 100 steps; returns (best_T, best_NLL)

### `_measure_ece`
- **Does**: Bins predictions by max confidence; computes ECE = Σ (|bin|/N) * |conf - acc|
- **Returns**: `{"l0": float, "l1": float}`

### `_build_full_batch`
- **Does**: Builds an unmasked batch from one day's token list (shared with evaluator.py)

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `evaluator.py` | `_build_full_batch` helper | Signature |
| `test_step9_calibrate_eval.py` | `calibrate(user_id, val_ds) -> dict` | Signature |
| T2.5 | `hmt_calibrated.pt` with `temperature` key | Checkpoint key |

## Notes
- Implements T2.4 (CI-Server-cmf)
- ECE target: < 0.08 per level (spec §7.2)
- Temperature > 1 → softer probabilities; < 1 → sharper
