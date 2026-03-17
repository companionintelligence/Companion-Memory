"""
STEP 9 — T2.4 + T2.5: Calibration + Evaluation.

Requires: Step 8 complete (hmt_checkpoint.pt exists).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step9_calibrate_eval.py <user_id>
"""
import sys, os, logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

if len(sys.argv) < 2:
    print("Usage: test_step9_calibrate_eval.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

from ci.model.dataset import make_splits, TokenStreamDataset
from ci.model.calibration import calibrate
from ci.model.evaluator import evaluate

splits   = make_splits(user_id)
val_ds   = TokenStreamDataset(user_id, splits["val"])
test_ds  = TokenStreamDataset(user_id, splits["test"])

# ── T2.4 Calibration ──────────────────────────────────────────────────────────
print("\n── T2.4  Calibration ────────────────────────────────────")
cal = calibrate(user_id, val_ds)

print(f"\n  Temperature       : {cal['temperature']:.4f}")
print(f"  ECE before (L0/L1): {cal['ece_before']['l0']:.4f} / {cal['ece_before']['l1']:.4f}")
print(f"  ECE after  (L0/L1): {cal['ece_after']['l0']:.4f}  / {cal['ece_after']['l1']:.4f}")
print(f"  ECE target < {cal['ece_target']}")
print(f"  L0 passed: {'✓' if cal['l0_passed'] else '✗'}   L1 passed: {'✓' if cal['l1_passed'] else '✗'}")

# ── T2.5 Evaluation ───────────────────────────────────────────────────────────
print("\n── T2.5  Evaluation (test set) ──────────────────────────")
rep = evaluate(user_id, test_ds)

print(f"\n  L0 top-1 : {rep['l0_top1_accuracy']:.1%}  ({rep['l0_total_tokens']} tokens)  "
      f"target={rep['l0_top1_target']:.0%}  {'✓' if rep['l0_top1_passed'] else '✗'}")
print(f"  L1 top-3 : {rep['l1_top3_accuracy']:.1%}  ({rep['l1_total_tokens']} tokens)  "
      f"target={rep['l1_top3_target']:.0%}  {'✓' if rep['l1_top3_passed'] else '✗'}")
print(f"  L2 recall: {rep['l2_recall_at_5']}  ({rep['l2_note']})")

print("\n── Summary ──────────────────────────────────────────────")
all_hard = [rep["l0_top1_passed"], rep["l1_top3_passed"]]
if all(all_hard):
    print("PASS — all hard targets met")
else:
    print("INFO — some targets not met (small corpus expected; see eval_report.json)")
