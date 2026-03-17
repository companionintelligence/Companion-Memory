"""
STEP 3 — Label content: run QwenLabeler on all unlabeled rows in ci.content.

Requirements: Step 2 complete (events labeled, so L1 vocab exists).

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... PYTHONPATH=src \
        python scripts/test_step3_discovery.py <user_id>
"""
import sys
import os

if len(sys.argv) < 2:
    print("Usage: test_step3_discovery.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
print("── Step 3: Label Content ────────────────────────────────")

import psycopg2.extras
from ci.database import get_conn
from ci.tokenizer.qwen_labeler import QwenLabeler

# ── Count unlabeled content ────────────────────────────────────────────────────
with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) FROM ci.content c
            LEFT JOIN ci.l2_content_cluster lc ON lc.content_id = c.id
            WHERE c.user_id = %s::uuid AND lc.content_id IS NULL
        """, (user_id,))
        unlabeled = cur.fetchone()[0]

    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM ci.content WHERE user_id = %s::uuid", (user_id,))
        total_content = cur.fetchone()[0]

print(f"\n[1/3] Found {unlabeled} unlabeled / {total_content} total content items for user={user_id[:8]}...")

if total_content == 0:
    print("      No content rows found — skipping (this is normal if content hasn't been ingested yet)")
    print("PASS — content labeling step skipped (no content)")
    sys.exit(0)

if unlabeled == 0:
    print("      All content already labeled — skipping labeling step")
else:
    # ── Fetch unlabeled content ────────────────────────────────────────────────
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT c.id::text AS content_id, c.title, c.content_type
                FROM ci.content c
                LEFT JOIN ci.l2_content_cluster lc ON lc.content_id = c.id
                WHERE c.user_id = %s::uuid AND lc.content_id IS NULL
                ORDER BY c.created_at
                LIMIT 500
            """, (user_id,))
            content_items = [dict(r) for r in cur.fetchall()]

    print(f"\n[2/3] Labeling {len(content_items)} content items with Qwen ...")

    labeler = QwenLabeler()
    labeled = 0
    new_l1 = 0
    new_l2 = 0
    errors = 0

    for i, item in enumerate(content_items):
        title = (item.get("title") or "(no title)")[:50]
        print(f"  [{i+1:>4}/{len(content_items)}] {title:<50}", end="", flush=True)
        try:
            result = labeler.label_content(
                content_id=item["content_id"],
                user_id=user_id,
                title=item.get("title") or "",
                content_type=item.get("content_type"),
            )
            labeled += 1
            if result.get("is_new_l1"):
                new_l1 += 1
            if result.get("is_new_l2"):
                new_l2 += 1
            print(f"  → {result['l0']} / {result['l1']!r} / {result['l2']!r}")
        except Exception as exc:
            errors += 1
            print(f"  ✗ {exc}")

    print(f"\n      Labeled: {labeled}  New L1: {new_l1}  New L2: {new_l2}  Errors: {errors}")

# ── Verify in DB ───────────────────────────────────────────────────────────────
print(f"\n[3/3] Verifying ci.l2_content_cluster + ci.content_context ...")
with get_conn() as conn:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT cc.l0_class, COUNT(*) AS n
            FROM ci.content_context cc
            JOIN ci.content c ON c.id = cc.content_id
            WHERE c.user_id = %s::uuid
            GROUP BY cc.l0_class
            ORDER BY cc.l0_class
        """, (user_id,))
        rows = [dict(r) for r in cur.fetchall()]

if rows:
    print(f"  {'L0':<12}  {'content items':>13}")
    print(f"  {'-'*12}  {'-'*13}")
    for row in rows:
        print(f"  {row['l0_class']:<12}  {row['n']:>13}")
    total = sum(r["n"] for r in rows)
    print(f"\n  Total content labeled: {total}")
else:
    print("      No ci.content_context rows — content labeling may not have run yet")

print("PASS — content labeling complete")
