"""
STEP 4 — Verify labels: check L1/L2 vocab and assignment coverage in the DB.

Requirements: Steps 2–3 complete (events and content labeled).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... PYTHONPATH=src \
        python scripts/test_step4_router.py <user_id>
"""
import sys
import os

if len(sys.argv) < 2:
    print("Usage: test_step4_router.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
print("── Step 4: Verify Labels ────────────────────────────────")

import psycopg2.extras
from ci.database import get_conn
from ci.tokenizer.vocab_registry import get_l1_vocab, get_l2_vocab, L0_CLASSES

# ── L1 vocab ───────────────────────────────────────────────────────────────────
print(f"\n[1/3] L1 vocabulary for user={user_id[:8]} ...")
total_l1 = 0
for l0 in L0_CLASSES:
    entries = get_l1_vocab(user_id, l0)
    total_l1 += len(entries)
    if entries:
        labels = [e["label"] for e in entries]
        print(f"  {l0:<10}  {len(entries):>3} labels  {labels[:5]}")

print(f"\n  Total L1 labels: {total_l1}")

if total_l1 == 0:
    print("ERROR: No L1 labels found. Run Step 2 first.")
    sys.exit(1)

# ── L2 vocab ───────────────────────────────────────────────────────────────────
print(f"\n[2/3] L2 vocabulary sample ...")
total_l2 = 0
for l0 in L0_CLASSES:
    for entry in get_l1_vocab(user_id, l0)[:3]:   # check first 3 L1s per L0
        l2_entries = get_l2_vocab(user_id, l0, entry["cluster_id"])
        total_l2 += len(l2_entries)
        if l2_entries:
            labels = [e["label"] for e in l2_entries]
            print(f"  {l0}/{entry['label'][:20]:<22}  {len(l2_entries):>3} L2 labels  {labels[:3]}")

print(f"\n  Total L2 labels (sampled): {total_l2}")

# ── Assignment coverage ────────────────────────────────────────────────────────
print(f"\n[3/3] Assignment coverage ...")
with get_conn() as conn:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT
                (SELECT COUNT(*) FROM ci.events
                 WHERE user_id = %s::uuid AND is_deleted = FALSE) AS total_events,
                (SELECT COUNT(*) FROM ci.l1_event_cluster ec
                 JOIN ci.events e ON e.event_id = ec.event_id
                 WHERE e.user_id = %s::uuid) AS labeled_events,
                (SELECT COUNT(*) FROM ci.content WHERE user_id = %s::uuid) AS total_content,
                (SELECT COUNT(*) FROM ci.l2_content_cluster lc
                 JOIN ci.content c ON c.id = lc.content_id
                 WHERE c.user_id = %s::uuid) AS labeled_content
        """, (user_id, user_id, user_id, user_id))
        cov = dict(cur.fetchone())

ev_pct = (cov["labeled_events"] / cov["total_events"] * 100) if cov["total_events"] else 0
ct_pct = (cov["labeled_content"] / cov["total_content"] * 100) if cov["total_content"] else 0

print(f"  Events:  {cov['labeled_events']:>5} / {cov['total_events']:>5} labeled  ({ev_pct:.0f}%)")
print(f"  Content: {cov['labeled_content']:>5} / {cov['total_content']:>5} labeled  ({ct_pct:.0f}%)")

if cov["labeled_events"] == 0:
    print("ERROR: No events labeled. Run Step 2 first.")
    sys.exit(1)

print("PASS — labels verified, vocab populated")
