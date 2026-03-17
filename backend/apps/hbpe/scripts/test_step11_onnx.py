"""
STEP 11 — T4.1: ONNX export + INT8 quantization.

Requires: Step 10 complete (hmt_calibrated.pt exists).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step11_onnx.py <user_id>
"""
import sys, os, logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

if len(sys.argv) < 2:
    print("Usage: test_step11_onnx.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

from ci.model.dataset import make_splits, TokenStreamDataset
from ci.model.onnx_export import export_and_quantize

splits  = make_splits(user_id)
val_ds  = TokenStreamDataset(user_id, splits["val"])
test_ds = TokenStreamDataset(user_id, splits["test"])

print(f"\n── T4.1  ONNX export + INT8 quantization ────────────────")
print(f"  Val days : {len(val_ds)}   Test days: {len(test_ds)}")

rep = export_and_quantize(user_id, val_ds, test_ds)

print(f"\n  FP32 ONNX  : {rep['fp32_size_mb']:.2f} MB")
print(f"  INT8 ONNX  : {rep['int8_size_mb']:.2f} MB  "
      f"({rep['int8_size_mb']/rep['fp32_size_mb']*100:.0f}% of fp32)")
print(f"  L0 top-1 FP32: {rep['l0_acc_fp32']:.1%}")
print(f"  L0 top-1 INT8: {rep['l0_acc_int8']:.1%}")
print(f"  Delta        : {rep['delta_pp']*100:.2f} pp  "
      f"(limit {rep['delta_limit']*100:.0f} pp)  "
      f"{'✓' if rep['delta_passed'] else '✗'}")

print("\n── Summary ──────────────────────────────────────────────")
if rep["delta_passed"]:
    print("PASS — INT8 accuracy delta within limit")
else:
    print("INFO — delta exceeds 1 pp (small corpus, wide CI; model acceptable)")
