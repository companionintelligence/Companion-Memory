"""
STEP 7 — T2.2: L0 MAE pre-training.

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step7_pretrain.py <user_id>
"""
import sys, os, logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

if len(sys.argv) < 2:
    print("Usage: test_step7_pretrain.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

print("── Step 7: L0 MAE Pre-training ─────────────────────────")

from ci.model.dataset import make_splits, TokenStreamDataset
from ci.model.trainer import train_l0_mae

splits   = make_splits(user_id)
train_ds = TokenStreamDataset(user_id, splits["train"])
val_ds   = TokenStreamDataset(user_id, splits["val"])

print(f"\n  Training on {len(train_ds)} days, validating on {len(val_ds)} days")
print(f"  (this may take a minute)\n")

ckpt_path = train_l0_mae(user_id, train_ds, val_ds)

print(f"\n  Checkpoint saved → {ckpt_path}")

import torch
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
print(f"  Best epoch : {ckpt['epoch']}")
print(f"  Val loss   : {ckpt['val_loss']:.4f}")
print(f"  Vocab size : {ckpt['vocab_size']}")

assert ckpt_path.exists(), "Checkpoint file missing"
assert ckpt["val_loss"] < 5.0, f"Val loss {ckpt['val_loss']:.4f} suspiciously high"

print(f"\nPASS — L0 MAE pre-training complete")
