"""
STEP 6 — T2.1: Dataset splits.

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... PYTHONPATH=src \
        python scripts/test_step6_splits.py <user_id>
"""
import sys, os
if len(sys.argv) < 2:
    print("Usage: test_step6_splits.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

print("── Step 6: Dataset Splits ───────────────────────────────")

from ci.model.dataset import make_splits, TokenStreamDataset
from collections import Counter
from datetime import date as date_cls

splits = make_splits(user_id)

print(f"\n  train : {len(splits['train'])} days  ({splits['train'][0]} → {splits['train'][-1]})")
print(f"  val   : {len(splits['val'])}  days  ({splits['val'][0]} → {splits['val'][-1]})")
print(f"  test  : {len(splits['test'])} days  ({splits['test'][0]} → {splits['test'][-1]})")

# Verify no overlap
assert not set(splits["train"]) & set(splits["val"]),  "train/val overlap!"
assert not set(splits["train"]) & set(splits["test"]), "train/test overlap!"
assert not set(splits["val"])   & set(splits["test"]), "val/test overlap!"

# Check day-of-week distribution
dow_names = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
def dow_dist(dates):
    c = Counter(date_cls.fromisoformat(d).weekday() for d in dates)
    return {dow_names[i]: c.get(i, 0) for i in range(7)}

print(f"\n  Day-of-week distribution:")
print(f"    train : {dow_dist(splits['train'])}")
print(f"    val   : {dow_dist(splits['val'])}")

# Spot-check loading one day
train_ds = TokenStreamDataset(user_id, splits["train"])
sample = train_ds[0]
print(f"\n  First training day ({splits['train'][0]}): {len(sample)} tokens")
print(f"    {sample[0]}")
print(f"    {sample[1]}")
print(f"    ...")
print(f"    {sample[-1]}")

assert sample[0]["level"] == "SOD", "First token should be SOD"
assert sample[-1]["level"] == "EOD", "Last token should be EOD"

print(f"\nPASS — splits look healthy, dataset loads correctly")
