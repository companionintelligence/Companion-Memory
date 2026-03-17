# lora.py

## Purpose
Rank-8 LoRA adapters for the HMT attention projections (T3.1). Freezes the
backbone and injects trainable low-rank deltas into Q, K, V (combined
in_proj_weight) and O (out_proj.weight) of each encoder layer. Per-user
checkpoint; merge-capable for ONNX export.

## Components

### `LoRAMHA`
- **Does**: Drop-in replacement for `nn.MultiheadAttention`. At each forward pass computes effective weights `W + scale * B @ A` and delegates to `F.multi_head_attention_forward`. Handles `batch_first=True` transpose.
- **Interacts with**: `nn.MultiheadAttention` (stored as `self.base`), `F.multi_head_attention_forward`
- **Rationale**: Computing effective weights rather than mutating `.data` in-place lets autograd flow gradients back to `qkv_A/B` and `o_A/B` correctly.

### `apply_lora(model, rank, alpha)`
- **Does**: Freezes all backbone params (`requires_grad=False`), replaces each `layer.self_attn` with `LoRAMHA`. After call only LoRA params are trainable.

### `save_adapter(model, path)`
- **Does**: Saves `{lora_rank, lora_alpha, adapter: {name: tensor}}` — only trainable params.

### `load_adapter(model, path)`
- **Does**: Loads checkpoint; calls `apply_lora` first if LoRA not yet injected; restores weights via `load_state_dict(strict=False)`.

### `merge_adapter(model)`
- **Does**: Adds `scale * B @ A` permanently to `in_proj_weight` / `out_proj.weight` then restores plain `nn.MultiheadAttention`. Required before ONNX export (T4.1).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `nightly_finetune.py` | `apply_lora`, `save_adapter`, `load_adapter` | Signatures |
| `onnx_export.py` (T4.1) | `merge_adapter` leaves clean `nn.MultiheadAttention` modules | Module type |
| `test_step10_lora.py` | `apply_lora` → only LoRA params trainable | Param count |

## Notes
- `LORA_RANK=8`, `LORA_ALPHA=16.0` → `scale=2.0`
- Adapter checkpoint path convention: `{models_dir}/hmt/lora_{user_id}.pt`
- Implements T3.1 (CI-Server-6rw)
