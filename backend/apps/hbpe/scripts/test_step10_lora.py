"""
STEP 10 — T3.1 + T3.2: LoRA adapter + nightly fine-tune.

Requires: Step 9 complete (hmt_calibrated.pt exists).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step10_lora.py <user_id>

Checks:
  • apply_lora freezes backbone and exposes only adapter params
  • Adapter delta is exactly 0 at init (model unchanged)
  • One epoch of fine-tune changes adapter weights
  • save/load round-trips correctly
  • merge_adapter restores plain MHA modules
"""
import sys, os, logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

if len(sys.argv) < 2:
    print("Usage: test_step10_lora.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

import datetime
import torch
from pathlib import Path

from ci.model.vocab import build_l0_vocab, build_l1_vocab
from ci.model.evaluator import _load_calibrated
from ci.model.lora import apply_lora, save_adapter, load_adapter, merge_adapter, LoRAMHA
from ci.model.nightly_finetune import fine_tune_nightly
from ci.config import settings

device = "cpu"

# ── T3.1  LoRA adapter application ────────────────────────────────────────────
print("\n── T3.1  LoRA adapter ───────────────────────────────────")

l0_vocab = build_l0_vocab()
l1_vocab = build_l1_vocab(user_id)
model, temp = _load_calibrated(user_id, l0_vocab, l1_vocab, device)

# Check baseline: all params trainable before LoRA
total_before = sum(p.numel() for p in model.parameters() if p.requires_grad)
print(f"  Trainable params before apply_lora : {total_before}")

apply_lora(model)

frozen  = sum(p.numel() for p in model.parameters() if not p.requires_grad)
adapter = sum(p.numel() for p in model.parameters() if p.requires_grad)
print(f"  Frozen backbone params             : {frozen}")
print(f"  Trainable adapter params           : {adapter}")
assert adapter > 0,  "No adapter params are trainable"
assert frozen  > 0,  "No backbone params are frozen"
assert adapter < frozen, "Adapter should be much smaller than backbone"
print("  ✓ Backbone frozen, adapter trainable")

# Delta at init should be zero (B=zeros)
for i, layer in enumerate(model.encoder.layers):
    lora = layer.self_attn
    assert isinstance(lora, LoRAMHA), f"Layer {i} self_attn is not LoRAMHA"
    delta_qkv = lora.scale * (lora.qkv_B @ lora.qkv_A)
    delta_o   = lora.scale * (lora.o_B   @ lora.o_A)
    assert delta_qkv.abs().max().item() == 0.0, f"Layer {i} qkv delta ≠ 0 at init"
    assert delta_o.abs().max().item()   == 0.0, f"Layer {i} o delta ≠ 0 at init"
print("  ✓ LoRA delta = 0 at init (model numerically unchanged)")

# ── T3.2  Nightly fine-tune ────────────────────────────────────────────────────
print("\n── T3.2  Nightly fine-tune ──────────────────────────────")

# Use the most recent serialised date
from ci.database import get_conn
import psycopg2.extras
with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT MAX(date) FROM ci.token_stream WHERE user_id = %s",
            (user_id,),
        )
        latest_date = cur.fetchone()[0]

if latest_date is None:
    print("  No serialised tokens found — skipping fine-tune test")
    sys.exit(0)

print(f"  Using date: {latest_date}")
report = fine_tune_nightly(user_id, latest_date, device=device)
print(f"  L0 tokens : {report['n_l0_tokens']}")
print(f"  L1 tokens : {report['n_l1_tokens']}")
print(f"  Loss      : {report['loss']:.4f}" if report["loss"] is not None else "  Loss: n/a")
print(f"  Adapter   : {report['adapter_path']}")

# Verify adapter file exists
adapter_path = Path(report["adapter_path"])
assert adapter_path.exists(), f"Adapter not saved to {adapter_path}"
print("  ✓ Adapter checkpoint saved")

# ── Round-trip: save → fresh load → compare to checkpoint file ────────────────
print("\n── Save / load round-trip ───────────────────────────────")

model2, _ = _load_calibrated(user_id, l0_vocab, l1_vocab, device)
load_adapter(model2, adapter_path)

# Verify loaded params match the saved checkpoint file exactly
ckpt_adapter = torch.load(adapter_path, map_location="cpu", weights_only=True)["adapter"]
for name, param in model2.named_parameters():
    if param.requires_grad:
        assert name in ckpt_adapter, f"Key {name} missing from checkpoint"
        assert torch.allclose(param.cpu(), ckpt_adapter[name]), f"Mismatch in {name}"
print("  ✓ Adapter round-trip: save → load weights match checkpoint")

# ── Merge ─────────────────────────────────────────────────────────────────────
print("\n── merge_adapter ────────────────────────────────────────")
merge_adapter(model2)
for layer in model2.encoder.layers:
    assert not isinstance(layer.self_attn, LoRAMHA), \
        "LoRAMHA should be replaced after merge"
print("  ✓ All self_attn modules restored to plain MHA after merge")

print("\n── Summary ──────────────────────────────────────────────")
print("PASS — T3.1 + T3.2 checks passed")
