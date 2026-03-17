# inference_engine.py

## Purpose
Incremental 48-bucket behavioural forecast engine (T4.2). Aggregates per-day
HMT model outputs across a 30-day sliding window, weighted by recency and
day-of-week similarity. Memoises per-day outputs so only the affected day
needs to be recomputed on a new event (O(1) invalidation, single-day recompute).

## Components

### `InferenceEngine`
- **Does**: Long-lived engine instance per user. Loads ONNX session on init, records the model's fixed input width when present, and maintains `_output_cache: dict[date, {l0, l1}]`. Also loads `_l1_display_names` (cluster UUID → human-readable display_name) from `ci.l1_clusters` for readable l1_probs output.
- **Interacts with**: `ort.InferenceSession` (hmt_int8.onnx → hmt_fp32.onnx → PyTorch fallback), `ci.token_stream` (DB), `ci.l1_clusters` (DB), `_build_full_batch` (calibration.py)

### `InferenceEngine.predict(horizon_start)`
- **Does**: Aggregates past 30 days' cached per-bucket logits with recency + DoW weighting → 48-element list with `{bucket_index, start_time, l0_probs, l1_probs, l2_probs, q10, q50, q90}`. Buckets with no history get uniform L0 prior.
- **Returns**: `list[dict]` (48 items)

### `InferenceEngine.invalidate(date)`
- **Does**: Evicts one date from `_output_cache`. Call when a new event arrives for that date.

### `InferenceEngine.invalidate_all()`
- **Does**: Clears entire cache. Call after nightly LoRA adapter update.

### `_PyTorchSession`
- **Does**: Thin ORT-compatible wrapper around HMTModel for when ONNX files are absent.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `histogram_api.py` (T4.4) | `predict() -> list[dict]` with keys `bucket_index`, `start_time`, `l0_probs`, `l1_probs`, `l2_probs`, `q10`, `q50`, `q90` | Return schema |
| `ingester.py` (T4.3) | `invalidate(date)` | Signature |
| `api.py` | Engine held in `app.state.engine` | Attribute name |

## Notes
- "KV-cache": memoized per-day encoder outputs (not per-layer KV tensors — encoder-only arch makes true decoder-style KV reuse impractical without architecture changes)
- Load order: hmt_int8.onnx → hmt_fp32.onnx → PyTorch (evaluator._load_calibrated)
- DECAY_LAMBDA=7 days, DOW_BOOST=2×, WINDOW_DAYS=30
- When using ONNX, day batches are right-padded to the model's declared fixed sequence width; if a day exceeds that width, inference raises a clear re-export error instead of producing malformed ORT input
- Implements T4.2 (CI-Server-04d)
