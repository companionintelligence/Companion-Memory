"""
STEP 5 — Serialize one week of tokens to ci.token_stream + run PipelineValidator.

This is the full Phase 1 acceptance test.

Requirements: Steps 2–4 complete. Migration 20260228000001_hbpe_token_stream.sql applied.

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \
        python scripts/test_step5_validate.py <user_id> [start_date] [end_date]

    start_date / end_date default to the min/max start_time in ci.events.
"""
import sys
import os

if len(sys.argv) < 2:
    print("Usage: test_step5_validate.py <user_id> [start_date YYYY-MM-DD] [end_date YYYY-MM-DD]")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

print("── Step 5: Serialize + Validate ─────────────────────────")

from ci.database import get_conn

# Determine date range
if len(sys.argv) >= 4:
    start_date, end_date = sys.argv[2], sys.argv[3]
else:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT MIN(start_time::date), MAX(start_time::date)
                FROM ci.events
                WHERE user_id = %s AND is_deleted = FALSE
            """, (user_id,))
            row = cur.fetchone()
    start_date, end_date = str(row[0]), str(row[1])

print(f"\n[1/3] Serializing {start_date} → {end_date} for user={user_id} ...")

from ci.tokenizer.serializer import TokenSerializer
ts = TokenSerializer()
total_rows = ts.serialize_range(user_id, start_date, end_date)
print(f"      Written: {total_rows} token rows to ci.token_stream")

if total_rows == 0:
    print("ERROR: No tokens written. Ensure events have L1 assignments (run Step 4 first).")
    sys.exit(1)

# Sample a few rows
print(f"\n[2/3] Sample from ci.token_stream ...")
with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT date, seq_order, bucket_idx, level, token_id, soft_prob
            FROM ci.token_stream
            WHERE user_id = %s
            ORDER BY date, seq_order
            LIMIT 8
        """, (user_id,))
        rows = cur.fetchall()

print(f"  {'date':<12} {'seq':>4} {'bucket':>6}  {'level':<5}  {'token_id':<38}  soft_prob")
print(f"  {'-'*12} {'-'*4} {'-'*6}  {'-'*5}  {'-'*38}  {'-'*10}")
for r in rows:
    date, seq, bucket, level, token_id, soft_prob = r
    tid = str(token_id)[:36]
    print(f"  {str(date):<12} {seq:>4} {bucket:>6}  {level:<5}  {tid:<38}  {soft_prob}")

print(f"\n[3/3] Running PipelineValidator ...")
from ci.tokenizer.validator import PipelineValidator, ValidationError
from pathlib import Path

validator = PipelineValidator()
try:
    report = validator.validate(user_id)
    print("\n✓ Validation PASSED")
except ValidationError as e:
    print(f"\n✗ Validation FAILED: {e}")
    sys.exit(1)
finally:
    import json
    report_path = Path("validation_report.json")
    if report_path.exists():
        report = json.loads(report_path.read_text())
        print(f"\nValidation report:")
        for check, result in report.get("checks", {}).items():
            if isinstance(result, dict):
                status = "✓" if result.get("passed", True) else "✗"
                print(f"  {status}  {check}: {result}")
            else:
                print(f"      {check}: {result}")
