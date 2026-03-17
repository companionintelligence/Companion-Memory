"""
STEP 8 — T2.3: HMT joint fine-tuning (L0 + L1).

Requires: Step 7 complete (l0_mae_checkpoint.pt exists).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step8_joint.py <user_id>
"""
import sys, os, logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

if len(sys.argv) < 2:
    print("Usage: test_step8_joint.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

print("── Step 8: HMT Joint Fine-tuning (L0 + L1) ─────────────")

from ci.model.dataset import make_splits, TokenStreamDataset
from ci.model.trainer import train_hmt_joint

splits   = make_splits(user_id)
train_ds = TokenStreamDataset(user_id, splits["train"])
val_ds   = TokenStreamDataset(user_id, splits["val"])

print(f"\n  Train={len(train_ds)} days  Val={len(val_ds)} days\n")

ckpt_path = train_hmt_joint(user_id, train_ds, val_ds)

import torch
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
print(f"\n  Checkpoint → {ckpt_path}")
print(f"  Best epoch  : {ckpt['epoch']}")
print(f"  Val loss    : {ckpt['val_loss']:.4f}")
print(f"  L0 vocab    : {ckpt['l0_vocab_size']}")
print(f"  L1 vocab    : {ckpt['l1_vocab_size']}")

assert ckpt_path.exists()
assert ckpt["val_loss"] < 10.0, f"Val loss {ckpt['val_loss']:.4f} suspiciously high"

print(f"\nPASS — HMT joint fine-tuning complete")
