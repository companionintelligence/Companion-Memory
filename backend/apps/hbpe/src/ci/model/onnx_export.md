# onnx_export.py

## Purpose
ONNX export and INT8 static quantization of the HMTModel (T4.1). Produces
`hmt_fp32.onnx` and `hmt_int8.onnx` consumed by the InferenceEngine. Verifies
that the accuracy delta between fp32 and int8 is < 1 pp on L0 top-1.

## Components

### `_HMTONNXWrapper`
- **Does**: ONNX-safe forward — replaces boolean mask assignment (`tok_emb[l0_mask]=...`) with arithmetic blend (`l0_emb*(1-w) + l1_emb*w`) that traces cleanly to ONNX Gather+Mul ops. Clamps token_ids per-level to avoid out-of-bounds embedding lookups.
- **Rationale**: PyTorch tracing resolves dynamic boolean conditions statically; arithmetic blend is always correct regardless of input.

### `_make_ort_input`
- **Does**: Pads a day batch to the fixed export width (`ONNX_SEQ_LEN=256`) and returns a static-shape numpy feed dict for ONNX Runtime.
- **Rationale**: `torch.onnx.export` bakes `MultiheadAttention` reshape sizes from the trace example; static-width export avoids invalid internal reshapes on longer sequences.

### `export_and_quantize(user_id, val_ds, test_ds)`
- **Does**: Loads `hmt_calibrated.pt`, merges LoRA if present, wraps in `_HMTONNXWrapper`, exports fp32 ONNX with a fixed `(1, 256)` input shape, quantises to INT8 using padded val-set inputs for calibration, measures accuracy delta on test set, writes report.
- **Returns**: report dict; files `hmt_fp32.onnx`, `hmt_int8.onnx`, `onnx_export_report.json`

### `_CalibrationReader`
- **Does**: `CalibrationDataReader` for `onnxruntime.quantization.quantize_static`. Yields numpy input dicts from the val dataset.

### `_build_ort_inputs`
- **Does**: Converts `TokenStreamDataset` days to list of numpy dicts for ORT. Passes token_ids **unclamped** — the ONNX wrapper handles per-level clamping internally.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `InferenceEngine` | `hmt_int8.onnx` in `{models_dir}/hmt/` | File name |
| `test_step11_onnx.py` | `export_and_quantize(user_id, val_ds, test_ds) -> dict` | Signature |

## Notes
- Opset 17 requested; onnxscript may upgrade to 18 — both are fine
- INT8 model size may exceed fp32 for tiny models (quantization metadata overhead)
- Runtime inputs longer than 256 tokens raise a clear error; increase `ONNX_SEQ_LEN` and re-export if real user days exceed that width
- Implements T4.1 (CI-Server-0ue)
