"""
STEP 12 — T4.2 + T4.3 + T4.4 + T4.5: Inference engine + histogram API + E2E validation.

Requires: Step 11 complete (hmt_int8.onnx exists).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step12_e2e.py <user_id>

Checks:
  • InferenceEngine loads ONNX model
  • predict() returns 48-bucket list with correct schema
  • Incremental invalidation is O(1) (no model re-run on invalidate)
  • Full-refresh latency < 2s,  incremental < 200ms
  • histogram_api.build_histogram produces correct envelope
  • Disk footprint < 500 MB, RAM < 800 MB
"""
import sys, os, time, logging
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
# keep INFO for our own modules
for mod in ("ci.pipeline.inference_engine", "ci.model.onnx_export"):
    logging.getLogger(mod).setLevel(logging.INFO)

if len(sys.argv) < 2:
    print("Usage: test_step12_e2e.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

import datetime
from pathlib import Path
from ci.pipeline.inference_engine import InferenceEngine
from ci.pipeline.histogram_api import build_histogram
from ci.config import settings

# ── T4.2  InferenceEngine ─────────────────────────────────────────────────────
print("\n── T4.2  InferenceEngine ────────────────────────────────")

engine = InferenceEngine(user_id)

# Full-refresh latency: first predict() loads all cached days
t0 = time.perf_counter()
buckets = engine.predict()
t_full = (time.perf_counter() - t0) * 1000  # ms

print(f"  Buckets returned : {len(buckets)}")
assert len(buckets) == 48, f"Expected 48 buckets, got {len(buckets)}"

# Validate bucket schema
required_keys = {"bucket_index", "start_time", "l0_probs", "l1_probs", "l2_probs", "q10", "q50", "q90"}
for b in buckets:
    missing = required_keys - b.keys()
    assert not missing, f"Bucket {b['bucket_index']} missing keys: {missing}"
    assert 0 <= b["bucket_index"] < 48
    assert isinstance(b["l0_probs"], dict) and len(b["l0_probs"]) > 0
    probs_sum = sum(b["l0_probs"].values())
    assert abs(probs_sum - 1.0) < 0.02, f"L0 probs don't sum to 1: {probs_sum:.4f}"

print(f"  Full-refresh latency : {t_full:.1f} ms  (target <2000 ms)")
print(f"  Schema               : ✓  (all 48 buckets have required keys)")
assert t_full < 2000, f"Full refresh too slow: {t_full:.1f} ms"
print("  ✓ Full refresh within 2s SLA")

# Incremental invalidation latency
t1 = time.perf_counter()
engine.invalidate(datetime.date.today())
t_inv = (time.perf_counter() - t1) * 1000
print(f"  Invalidation         : {t_inv:.3f} ms  (O(1))")
assert t_inv < 1, f"Invalidation should be O(1): {t_inv:.3f} ms"

# Incremental re-predict (one day evicted)
t2 = time.perf_counter()
buckets2 = engine.predict()
t_incr = (time.perf_counter() - t2) * 1000
print(f"  Incremental latency  : {t_incr:.1f} ms  (target <200 ms)")
assert t_incr < 200, f"Incremental too slow: {t_incr:.1f} ms"
print("  ✓ Incremental update within 200ms SLA")

# ── T4.4  Histogram API ───────────────────────────────────────────────────────
print("\n── T4.4  Histogram API ──────────────────────────────────")

result = build_histogram(engine, horizon="24h", user_id=user_id)
assert result["horizon"] == "24h"
assert "generated_at" in result
assert len(result["buckets"]) == 48
print(f"  Envelope keys : {list(result.keys())}")
print("  ✓ build_histogram returns correct envelope")

# Unsupported horizon
try:
    build_histogram(engine, horizon="48h")
    assert False, "Should have raised"
except ValueError:
    print("  ✓ Unsupported horizon raises ValueError")

# ── T4.5  Disk footprint ──────────────────────────────────────────────────────
print("\n── T4.5  Resource SLAs ──────────────────────────────────")

model_dir = Path(settings.models_dir) / "hmt"
total_mb = sum(f.stat().st_size for f in model_dir.iterdir() if f.is_file()) / 1_048_576
print(f"  Model dir footprint : {total_mb:.1f} MB  (target <500 MB)")
assert total_mb < 500, f"Model footprint too large: {total_mb:.1f} MB"
print("  ✓ Disk footprint within 500 MB SLA")

try:
    import psutil
    proc_mb = psutil.Process().memory_info().rss / 1_048_576
    print(f"  Process RSS         : {proc_mb:.0f} MB  (target <800 MB)")
    assert proc_mb < 800, f"RAM usage too high: {proc_mb:.0f} MB"
    print("  ✓ RAM within 800 MB SLA")
except ImportError:
    print("  RAM check skipped (psutil not installed)")

print("\n── Summary ──────────────────────────────────────────────")
print("PASS — T4.2 + T4.4 + T4.5 checks passed")
print(f"  Full refresh: {t_full:.0f}ms  |  Incremental: {t_incr:.0f}ms  |  Disk: {total_mb:.1f}MB")
