"""
STEP 2 — Label events: run QwenLabeler on all unlabeled events in ci.events.

Requirements: Step 1 complete. DB running with ci.events populated.

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... PYTHONPATH=src \
        python scripts/test_step2_features.py <user_id>
"""
import sys
import os

if len(sys.argv) < 2:
    print("Usage: test_step2_features.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
print("── Step 2: Label Events ─────────────────────────────────")

import psycopg2.extras
from ci.database import get_conn
from ci.tokenizer.qwen_labeler import QwenLabeler

# ── Count unlabeled events ─────────────────────────────────────────────────────
with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) FROM ci.events e
            LEFT JOIN ci.l1_event_cluster ec ON ec.event_id = e.event_id
            WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE AND ec.event_id IS NULL
        """, (user_id,))
        unlabeled = cur.fetchone()[0]

    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) FROM ci.events WHERE user_id = %s::uuid AND is_deleted = FALSE
        """, (user_id,))
        total_events = cur.fetchone()[0]

print(f"\n[1/3] Found {unlabeled} unlabeled / {total_events} total events for user={user_id[:8]}...")

if total_events == 0:
    print("ERROR: No events found for this user. Ensure ci.events has data.")
    sys.exit(1)

if unlabeled == 0:
    print("      All events already labeled — skipping labeling step")
else:
    # ── Fetch unlabeled events ─────────────────────────────────────────────────
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT e.event_id::text, e.title, e.description
                FROM ci.events e
                LEFT JOIN ci.l1_event_cluster ec ON ec.event_id = e.event_id
                WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE AND ec.event_id IS NULL
                ORDER BY e.start_time
                LIMIT 500
            """, (user_id,))
            events = [dict(r) for r in cur.fetchall()]

    print(f"\n[2/3] Labeling {len(events)} events with Qwen ...")

    labeler = QwenLabeler()
    labeled = 0
    new_labels = 0
    errors = 0

    for i, ev in enumerate(events):
        title = (ev.get("title") or "(no title)")[:50]
        print(f"  [{i+1:>4}/{len(events)}] {title:<50}", end="", flush=True)
        try:
            result = labeler.label_event(
                event_id=ev["event_id"],
                user_id=user_id,
                title=ev.get("title") or "",
                description=ev.get("description"),
            )
            labeled += 1
            if result.get("is_new_l1"):
                new_labels += 1
            print(f"  → {result['l0']} / {result['l1']!r}")
        except Exception as exc:
            errors += 1
            print(f"  ✗ {exc}")

    print(f"\n      Labeled: {labeled}  New L1 labels: {new_labels}  Errors: {errors}")

# ── Verify in DB ───────────────────────────────────────────────────────────────
print(f"\n[3/3] Verifying ci.l1_event_cluster ...")
with get_conn() as conn:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT l0_class, COUNT(*) AS n, cl1.naming_method
            FROM ci.l1_event_cluster ec
            JOIN ci.l1_clusters cl1 ON cl1.cluster_id = ec.cluster_id
            JOIN ci.events e ON e.event_id = ec.event_id
            WHERE e.user_id = %s::uuid
            GROUP BY l0_class, cl1.naming_method
            ORDER BY l0_class
        """, (user_id,))
        rows = [dict(r) for r in cur.fetchall()]

if not rows:
    print("ERROR: No rows in ci.l1_event_cluster for this user.")
    sys.exit(1)

print(f"  {'L0':<12}  {'method':<10}  {'events':>6}")
print(f"  {'-'*12}  {'-'*10}  {'-'*6}")
for row in rows:
    print(f"  {row['l0_class']:<12}  {row['naming_method']:<10}  {row['n']:>6}")

total_assigned = sum(r["n"] for r in rows)
print(f"\n  Total assigned: {total_assigned}")
print("PASS — events labeled successfully")
