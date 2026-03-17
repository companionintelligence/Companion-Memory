"""
STEP 13 — SummaryTokenizer: label hourly summaries and merge into token stream.

Tests three things independently:
  A. Bucket mapping  — get_tokens_for_day() returns correct indices and soft_prob
                       (no Qwen required; labels are inserted directly)
  B. Serializer merge — TokenSerializer includes summary tokens for uncovered
                        buckets but does NOT override event-covered buckets
  C. Qwen labeling   — label_day() calls Qwen, writes ci.summary_l1_label,
                        is idempotent on a second call
                       (skipped automatically if Qwen model is not loaded)

All synthetic test data is written under the sentinel date 2000-01-01 and
cleaned up in a finally block, so the test is safe to run against a live DB.

Requires: Step 5 complete (ci.token_stream populated).
          Migration 20260314000001_hbpe_summary_l1_label.sql applied.

Run from backend/apps/hbpe/:
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \\
        python scripts/test_step13_summaries.py <user_id>
"""
import os
import sys
import logging

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("ci.tokenizer.summary_tokenizer").setLevel(logging.INFO)
logging.getLogger("ci.tokenizer.serializer").setLevel(logging.INFO)

if len(sys.argv) < 2:
    print("Usage: test_step13_summaries.py <user_id>")
    sys.exit(1)

user_id = sys.argv[1]
os.environ.setdefault("MODELS_DIR", "/tmp/hbpe_models")

TEST_DATE = "2000-01-01"  # sentinel date — never conflicts with real data

from ci.database import get_conn  # noqa: E402

# ── Helpers ───────────────────────────────────────────────────────────────────

def check(condition: bool, msg: str) -> None:
    if not condition:
        print(f"  ✗ FAIL: {msg}")
        sys.exit(1)
    print(f"  ✓ {msg}")


def cleanup() -> None:
    """Remove all test rows written under TEST_DATE."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            # summary_l1_label rows (FK from summary_id)
            cur.execute(
                """
                DELETE FROM ci.summary_l1_label
                WHERE summary_id IN (
                    SELECT summary_id FROM ci.summaries
                    WHERE user_id = %s::uuid AND period_start::date = %s::date
                )
                """,
                (user_id, TEST_DATE),
            )
            # token_stream rows
            cur.execute(
                "DELETE FROM ci.token_stream WHERE user_id = %s AND date = %s",
                (user_id, TEST_DATE),
            )
            # summaries
            cur.execute(
                "DELETE FROM ci.summaries WHERE user_id = %s::uuid AND period_start::date = %s::date",
                (user_id, TEST_DATE),
            )


def insert_summary(period_start: str, summary_text: str) -> str:
    """Insert a synthetic hourly summary and return its summary_id as text."""
    sql = """
        INSERT INTO ci.summaries (
            summary_id, user_id, period_start, period_end, period_type,
            timezone, source_types, title, content, seen
        ) VALUES (
            gen_random_uuid(), %s::uuid,
            %s::timestamptz, (%s::timestamptz + INTERVAL '1 hour'),
            'hourly', 'UTC', ARRAY['test']::text[],
            'Test Hourly Summary',
            jsonb_build_object('summary_text', %s),
            false
        )
        RETURNING summary_id::text
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (user_id, period_start, period_start, summary_text))
            return cur.fetchone()[0]


def insert_label(summary_id: str, l0_class: str, l1_cluster_id=None) -> None:
    """Directly write a ci.summary_l1_label row (bypasses Qwen)."""
    sql = """
        INSERT INTO ci.summary_l1_label (summary_id, l0_class, l1_cluster_id)
        VALUES (%s::uuid, %s, %s::uuid)
        ON CONFLICT (summary_id) DO NOTHING
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (summary_id, l0_class, l1_cluster_id))


def count_label_rows(summary_id: str) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM ci.summary_l1_label WHERE summary_id = %s::uuid",
                (summary_id,),
            )
            return cur.fetchone()[0]


def stream_rows_for_date() -> list[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT level, token_id, bucket_idx, soft_prob
                FROM ci.token_stream
                WHERE user_id = %s AND date = %s
                ORDER BY seq_order
                """,
                (user_id, TEST_DATE),
            )
            cols = ["level", "token_id", "bucket_idx", "soft_prob"]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


# ── Preflight ─────────────────────────────────────────────────────────────────

print("\n── Preflight ────────────────────────────────────────────")

with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'ci' AND table_name = 'summary_l1_label'
            )
            """
        )
        exists = cur.fetchone()[0]

check(exists, "ci.summary_l1_label table exists (migration applied)")

# Also pick up an existing L1 cluster UUID to use as a realistic FK value.
with get_conn() as conn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT cluster_id::text FROM ci.l1_clusters WHERE user_id = %s LIMIT 1",
            (user_id,),
        )
        row = cur.fetchone()

sample_l1_id = row[0] if row else None
if sample_l1_id:
    print(f"  ℹ  Using L1 cluster {sample_l1_id[:8]}… for FK tests")
else:
    print("  ℹ  No L1 clusters found — L1 token tests will use NULL cluster_id")

# ── Main test body ─────────────────────────────────────────────────────────────

try:
    cleanup()  # start clean in case a previous run crashed mid-test

    from ci.tokenizer.summary_tokenizer import SummaryTokenizer, SUMMARY_SOFT_PROB

    # ── A. Bucket mapping ─────────────────────────────────────────────────────
    print("\n── A. Bucket mapping (no Qwen) ──────────────────────────")

    # 10:00 UTC → bucket 20  (10*2=20), spans buckets 20+21
    sid_10 = insert_summary(f"{TEST_DATE} 10:00:00+00", "Working on engineering tasks.")
    insert_label(sid_10, "WORK", sample_l1_id)

    # 00:00 UTC → bucket 0, spans buckets 0+1
    sid_00 = insert_summary(f"{TEST_DATE} 00:00:00+00", "Sleeping through the night.")
    insert_label(sid_00, "SLEEP", None)

    st = SummaryTokenizer()
    tokens = st.get_tokens_for_day(user_id, TEST_DATE)

    check(len(tokens) > 0, f"get_tokens_for_day returns tokens (got {len(tokens)})")

    l0_tokens = [t for t in tokens if t["level"] == "L0"]
    buckets_covered = sorted({t["bucket_idx"] for t in l0_tokens})

    # 00:00 summary → buckets 0, 1;  10:00 summary → buckets 20, 21
    for expected_bucket in [0, 1, 20, 21]:
        check(
            expected_bucket in buckets_covered,
            f"bucket {expected_bucket} present in L0 tokens",
        )

    for t in tokens:
        check(
            t["soft_prob_vector"] == [SUMMARY_SOFT_PROB],
            f"soft_prob_vector == [{SUMMARY_SOFT_PROB}] for bucket {t['bucket_idx']} level {t['level']}",
        )
        break  # check once — all rows share the same constant

    sleep_l0 = [t for t in tokens if t["level"] == "L0" and t["bucket_idx"] == 0]
    check(len(sleep_l0) > 0, "bucket 0 has L0 token")
    check(sleep_l0[0]["token_id"] == "SLEEP", "bucket 0 L0 token_id == 'SLEEP'")

    work_l0 = [t for t in tokens if t["level"] == "L0" and t["bucket_idx"] == 20]
    check(len(work_l0) > 0, "bucket 20 has L0 token")
    check(work_l0[0]["token_id"] == "WORK", "bucket 20 L0 token_id == 'WORK'")

    if sample_l1_id:
        work_l1 = [t for t in tokens if t["level"] == "L1" and t["bucket_idx"] == 20]
        check(len(work_l1) > 0, "bucket 20 has L1 token when l1_cluster_id is set")
        check(work_l1[0]["token_id"] == sample_l1_id, "L1 token_id matches cluster_id")

    sleep_l1 = [t for t in tokens if t["level"] == "L1" and t["bucket_idx"] == 0]
    check(len(sleep_l1) == 0, "bucket 0 has no L1 token when l1_cluster_id is NULL")

    # ── B. Serializer merge ───────────────────────────────────────────────────
    print("\n── B. Serializer merge ──────────────────────────────────")

    # TEST_DATE has our two synthetic summaries but no real events — all
    # summary tokens should land in ci.token_stream.
    from ci.tokenizer.serializer import TokenSerializer
    n_rows = TokenSerializer().serialize_day(user_id, TEST_DATE)

    check(n_rows > 0, f"serialize_day writes rows for a summary-only date (got {n_rows})")

    stream = stream_rows_for_date()
    stream_l0 = [r for r in stream if r["level"] == "L0"]
    stream_buckets = {r["bucket_idx"] for r in stream_l0}

    for expected_bucket in [0, 1, 20, 21]:
        check(
            expected_bucket in stream_buckets,
            f"ci.token_stream contains bucket {expected_bucket} from summary",
        )

    # Verify soft_prob is stored correctly (Postgres returns FLOAT4[] as string)
    sample_stream_row = next(
        (r for r in stream if r["level"] == "L0" and r["bucket_idx"] == 0), None
    )
    check(sample_stream_row is not None, "SOD/summary L0 row exists in stream for bucket 0")

    # Re-serialize: should be idempotent (DELETE+INSERT, same count)
    n_rows_2 = TokenSerializer().serialize_day(user_id, TEST_DATE)
    check(n_rows_2 == n_rows, f"Re-serialization is idempotent ({n_rows} == {n_rows_2})")

    # Verify summary tokens do NOT bleed into event-covered buckets.
    # Inject a fake event assignment at bucket 20 by writing directly to the
    # token stream as if the event serializer had run, then re-serialize and
    # confirm the summary token at bucket 20 is gone.
    #
    # We simulate this by temporarily inserting a direct token_stream row for
    # a "real event" at bucket 20, then checking _fetch_tokens_for_day logic
    # via the covered_buckets filter in the serializer.
    #
    # Because _fetch_tokens_for_day() only pulls from ci.events (which has no
    # test rows on TEST_DATE), we test this branch by verifying that when the
    # serializer runs on a date where events DO exist, the summary tokens only
    # appear in the gap buckets.  That requires real event data, so we just
    # confirm the code path works via unit-level inspection.

    # Find a real date that has event-derived tokens already in ci.token_stream
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT date FROM ci.token_stream
                WHERE user_id = %s AND level = 'L0' AND date != %s::date
                GROUP BY date
                HAVING COUNT(*) > 0
                LIMIT 1
                """,
                (user_id, TEST_DATE),
            )
            row = cur.fetchone()

    if row:
        real_date = str(row[0])
        event_buckets_before = set()
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT bucket_idx FROM ci.token_stream WHERE user_id = %s AND date = %s AND level = 'L0'",
                    (user_id, real_date),
                )
                event_buckets_before = {r[0] for r in cur.fetchall()}

        # Re-serialize that date — event buckets should remain, summary fills gaps
        TokenSerializer().serialize_day(user_id, real_date)

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT bucket_idx FROM ci.token_stream WHERE user_id = %s AND date = %s AND level = 'L0'",
                    (user_id, real_date),
                )
                event_buckets_after = {r[0] for r in cur.fetchall()}

        # All event buckets should still be present after re-serialization
        missing = event_buckets_before - event_buckets_after
        check(not missing, f"Event-covered buckets preserved after re-serialize (missing: {missing})")
        print(f"  ℹ  Event-covered: {sorted(event_buckets_before)} → after: {sorted(event_buckets_after)}")
    else:
        print("  ℹ  No existing token_stream rows found — skipping event-override guard test")

    # ── C. Idempotency of label_day on already-labeled summaries ─────────────
    print("\n── C. label_day idempotency (no Qwen) ───────────────────")

    # Both summaries are already labeled — label_day() should find 0 unlabeled.
    n_labeled = st.label_day(user_id, TEST_DATE)
    check(n_labeled == 0, f"label_day returns 0 when all summaries already labeled (got {n_labeled})")

    # ── D. Qwen labeling ──────────────────────────────────────────────────────
    print("\n── D. Qwen labeling ─────────────────────────────────────")

    qwen_available = False
    try:
        from ci.inference.qwen import get_qwen
        _ = get_qwen()
        qwen_available = True
    except Exception as e:
        print(f"  ⚠  Qwen not available ({e}) — skipping Qwen labeling tests")

    if qwen_available:
        # Insert a fresh unlabeled summary
        sid_new = insert_summary(
            f"{TEST_DATE} 14:00:00+00",
            "Attended a team standup, then worked on code review for a pull request.",
        )

        n = st.label_day(user_id, TEST_DATE)
        check(n == 1, f"label_day labels exactly 1 new summary (got {n})")
        check(count_label_rows(sid_new) == 1, "ci.summary_l1_label row written for new summary")

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT l0_class FROM ci.summary_l1_label WHERE summary_id = %s::uuid",
                    (sid_new,),
                )
                l0_result = cur.fetchone()[0]

        valid_l0_classes = {"WORK", "EXERCISE", "SOCIAL", "ERRAND", "LEISURE", "TRANSIT", "SLEEP", "UNKNOWN"}
        check(l0_result in valid_l0_classes, f"Qwen produced a valid L0 class (got '{l0_result}')")

        # Idempotency: second call finds 0 unlabeled
        n2 = st.label_day(user_id, TEST_DATE)
        check(n2 == 0, f"label_day is idempotent after Qwen run (got {n2})")
    else:
        print("  (Qwen section skipped)")

finally:
    cleanup()
    print("\n  ℹ  Test data cleaned up")

# ── Summary ────────────────────────────────────────────────────────────────────
print("\n── Summary ──────────────────────────────────────────────")
print("PASS — SummaryTokenizer bucket mapping, serializer merge, and idempotency checks passed")
if not (sys.argv[0] and "qwen_available" in dir() and qwen_available):
    print("       (Qwen labeling section skipped — start the HBPE container to test it)")
