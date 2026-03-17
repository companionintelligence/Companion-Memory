# histogram_api.py

## Purpose
Thin formatting layer between InferenceEngine and the HTTP endpoint (T4.4).
`build_histogram` validates the horizon parameter, calls `engine.predict()`,
writes all 48 forecast buckets to `ci.prediction_log`, and wraps the result
in the standard envelope consumed by the frontend.

## Components

### `build_histogram(engine, horizon, user_id)`
- **Does**: Validates horizon string, determines `horizon_start` (midnight tonight), calls `engine.predict(horizon_start)`, logs predictions, wraps in `{horizon, generated_at, buckets}`
- **Returns**: dict with 48-element `buckets` list
- **Interacts with**: `InferenceEngine.predict()`, `_log_prediction()`

### `_log_prediction(user_id, predicted_at, horizon_start, buckets)`
- **Does**: Batch-inserts all 48 forecast buckets into `ci.prediction_log` in one `execute_batch` call. Non-fatal — DB errors are logged and swallowed so they never affect the API response. `actual_l0/l1/l2` columns are left NULL for `retro_actual_fill` to backfill nightly (T5.1).
- **Interacts with**: `ci.database.get_conn`, `ci.prediction_log` table

### `_model_version()`
- **Does**: Returns `"{filename}@{mtime}"` for the highest-priority checkpoint found in `{models_dir}/hmt/`. Checked in order: `hmt_int8.onnx` → `hmt_fp32.onnx` → `hmt_calibrated.pt`. Falls back to `"unknown"` if none exist. Gives each nightly ONNX export a distinct, sortable version string.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|---------------------|
| `api.py` GET /histogram | `build_histogram(engine, horizon, user_id) -> dict` | Return schema |
| Frontend | `buckets[i].{bucket_index, start_time, l0_probs, l1_probs, l2_probs, q10, q50, q90}` | Key names |
| `retro_actual_fill` (T5.1) | Rows in `ci.prediction_log` with `actual_l0/l1/l2 = NULL` | Table schema |

## Notes
- Only `"24h"` horizon supported. Extend `SUPPORTED_HORIZONS` and add horizon_start logic for other values.
- Prediction logging is skipped if `user_id` is None (no rows written).
- `model_version` uses file mtime so it changes automatically after each nightly ONNX export — no manual version bumping needed.
- Implements T4.4 (CI-Server-k64)
