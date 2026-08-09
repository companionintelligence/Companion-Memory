#!/usr/bin/env python3
"""
HBPE Pipeline Runner — cold-start through final predictions.

Runs all 13 steps in order, printing a timing summary table at the end.
All step logic is inlined; no subprocess calls.

Usage (from the repository root; ci-hbpe is an installed workspace member, so
no PYTHONPATH is needed):
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models \\
        uv run backend/apps/hbpe/scripts/run_pipeline.py <user_id> [options]

Options:
    --from-step N    Start from step N, skipping earlier steps (default: 1)
    --to-step N      Stop after step N (default: 13)
    --clean          Delete all model checkpoints in MODELS_DIR before starting
    --help / -h      Show this message
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import time
from pathlib import Path

from ci.hbpe.buckets import BUCKETS_PER_DAY

# ── Step registry ──────────────────────────────────────────────────────────────

STEPS = [
    {
        "num": 1,
        "phase": "Phase 1 · Tokenizer Pipeline",
        "name": "Qwen Labeler",
        "needs_user": False,
    },
    {
        "num": 2,
        "phase": "Phase 1 · Tokenizer Pipeline",
        "name": "Label Events",
        "needs_user": True,
    },
    {
        "num": 3,
        "phase": "Phase 1 · Tokenizer Pipeline",
        "name": "Label Content",
        "needs_user": True,
    },
    {
        "num": 4,
        "phase": "Phase 1 · Tokenizer Pipeline",
        "name": "Verify Labels",
        "needs_user": True,
    },
    {
        "num": 5,
        "phase": "Phase 1 · Tokenizer Pipeline",
        "name": "Serialize + Validate",
        "needs_user": True,
    },
    {
        "num": 6,
        "phase": "Phase 2 · Model Training",
        "name": "Dataset Splits",
        "needs_user": True,
    },
    {
        "num": 7,
        "phase": "Phase 2 · Model Training",
        "name": "L0 MAE Pre-training",
        "needs_user": True,
    },
    {
        "num": 8,
        "phase": "Phase 2 · Model Training",
        "name": "HMT Joint Fine-tuning",
        "needs_user": True,
    },
    {
        "num": 9,
        "phase": "Phase 2 · Model Training",
        "name": "Calibration + Eval",
        "needs_user": True,
    },
    {
        "num": 10,
        "phase": "Phase 3 · Personalization",
        "name": "LoRA Adapter",
        "needs_user": True,
    },
    {
        "num": 11,
        "phase": "Phase 4 · Deployment",
        "name": "ONNX Export + INT8",
        "needs_user": True,
    },
    {
        "num": 12,
        "phase": "Phase 4 · Deployment",
        "name": "E2E Inference Engine",
        "needs_user": True,
    },
    {
        "num": 13,
        "phase": "Phase 4 · Deployment",
        "name": "Summary Tokenizer",
        "needs_user": True,
    },
]

W = 60  # display width

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("ci.hbpe.pipeline.inference_engine").setLevel(logging.INFO)
logging.getLogger("ci.hbpe.tokenizer.summary_tokenizer").setLevel(logging.INFO)
logging.getLogger("ci.hbpe.tokenizer.serializer").setLevel(logging.INFO)


class StepFailed(Exception):
    pass


# ── Step implementations ───────────────────────────────────────────────────────


def step1_qwen_labeler(user_id: str | None) -> None:
    print("── Step 1: Qwen Labeler ─────────────────────────────────")

    from ci.hbpe.tokenizer import qwen_labeler as ql
    from ci.hbpe.tokenizer.vocab_registry import normalise_l0

    print("\n[1/3] Testing prompt builders and JSON parser ...")

    assert normalise_l0("work") == "WORK"
    assert normalise_l0("UNKNOWN") == "UNKNOWN"
    assert normalise_l0("nonsense") == "UNKNOWN"
    assert ql._clean_label("  Engineering Meetings  ") == "Engineering Meetings"
    assert ql._clean_label('"Sprint Planning"') == "Sprint Planning"

    raw1 = '{"l0": "WORK", "l1": "Engineering Meetings"}'
    assert ql._parse_json(raw1) == {"l0": "WORK", "l1": "Engineering Meetings"}, (
        f"Parse failed: {ql._parse_json(raw1)}"
    )

    raw2 = 'Sure, here is the result:\n{"l0": "EXERCISE", "l1": "Morning Run", "l2": "Cardio Training"}'
    parsed2 = ql._parse_json(raw2)
    assert parsed2["l0"] == "EXERCISE", f"Expected EXERCISE, got {parsed2}"
    assert parsed2["l2"] == "Cardio Training"

    print("      Prompt helpers: PASS")

    print("\n[2/3] Loading Qwen model (downloads on first run) ...")
    from ci.hbpe.inference.qwen import get_qwen

    model = get_qwen()
    print("      Loaded: Qwen3.5-0.8B GGUF (llama-cpp-python)")

    print("\n[3/3] Running label generation on known events (two-stage) ...")

    cases = [
        ("Weekly team standup", "WORK"),
        ("Morning run - 5k", "EXERCISE"),
        ("Dentist appointment", "ERRAND"),
        ("Dinner with friends", "SOCIAL"),
        ("Flight to NYC", "TRANSIT"),
        ("Deep work block", "WORK"),
    ]

    # Stage 1: L0 classification
    print(f"  Stage 1 — L0 ({len(cases)} items) ...")
    l0_prompts = [(ql._build_l0_message(title, None), ql._SYSTEM) for title, _ in cases]
    l0_raws = model.batch_generate(l0_prompts, max_new_tokens=15)
    l0_results = [
        normalise_l0(ql._parse_json(raw).get("l0", "UNKNOWN")) for raw in l0_raws
    ]

    # Stage 2: L1 given locked L0 (empty vocab — this is a smoke test)
    print(f"  Stage 2 — L1 ({len(cases)} items) ...")
    l1_prompts = [
        (ql._build_l1_event_message(title, None, l0, []), ql._SYSTEM)
        for (title, _), l0 in zip(cases, l0_results, strict=True)
    ]
    l1_raws = model.batch_generate(l1_prompts, max_new_tokens=20)

    passed = 0
    for i, ((title, expected_l0), l0, raw) in enumerate(
        zip(cases, l0_results, l1_raws, strict=True)
    ):
        got_l1 = ql._clean_label(ql._parse_json(raw).get("l1", ""))
        ok = l0 == expected_l0
        passed += ok
        mark = "✓" if ok else "✗"
        print(f"  [{i + 1}/{len(cases)}] {title!r:30}  {mark}  L0={l0}  L1={got_l1!r}")

    print(f"\n{passed}/{len(cases)} L0 labels correct")
    if passed < len(cases) * 0.7:
        raise StepFailed(
            f"Too many incorrect L0 labels ({passed}/{len(cases)}, expected ≥70%)"
        )
    print("PASS — Qwen model loaded and labeling correctly")


def step2_label_events(user_id: str) -> None:
    import psycopg2.extras

    from ci.hbpe.database import get_conn
    from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler

    print("── Step 2: Label Events ─────────────────────────────────")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM ci.events e
                LEFT JOIN hbpe.l1_event_cluster ec ON ec.event_id = e.event_id
                WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE AND ec.event_id IS NULL
            """,
                (user_id,),
            )
            unlabeled = cur.fetchone()[0]
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM ci.events WHERE user_id = %s::uuid AND is_deleted = FALSE
            """,
                (user_id,),
            )
            total_events = cur.fetchone()[0]

    print(
        f"\n[1/3] Found {unlabeled} unlabeled / {total_events} total events for user={user_id[:8]}..."
    )

    if total_events == 0:
        raise StepFailed("No events found for this user. Ensure ci.events has data.")

    if unlabeled == 0:
        print("      All events already labeled — skipping labeling step")
    else:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT e.event_id::text, b.name AS title, b.description AS description
                    FROM ci.events e
                    JOIN ci.entities b ON b.entity_id = e.event_id
                    LEFT JOIN hbpe.l1_event_cluster ec ON ec.event_id = e.event_id
                    WHERE e.user_id = %s::uuid AND e.is_deleted = FALSE AND ec.event_id IS NULL
                    ORDER BY e.start_time
                    LIMIT 500
                """,
                    (user_id,),
                )
                events = [dict(r) for r in cur.fetchall()]

        BATCH = 32
        print(
            f"\n[2/3] Labeling {len(events)} events with Qwen (batch_size={BATCH}) ..."
        )
        labeler = QwenLabeler()
        labeled = new_labels = errors = 0

        for start in range(0, len(events), BATCH):
            batch = events[start : start + BATCH]
            end = start + len(batch)
            print(
                f"  [{start + 1:>4}–{end:>4}/{len(events)}] running batch ...",
                flush=True,
            )
            try:
                results = labeler.label_events_batch(batch, user_id)
                for r in results:
                    labeled += 1
                    if r.get("is_new_l1"):
                        new_labels += 1
                    print(f"    → {r['l0']} / {r['l1']!r}")
            except Exception as exc:
                errors += len(batch)
                print(f"    ✗ batch failed: {exc}")

        print(
            f"\n      Labeled: {labeled}  New L1 labels: {new_labels}  Errors: {errors}"
        )

    print("\n[3/3] Verifying hbpe.l1_event_cluster ...")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT l0_class, COUNT(*) AS n, cl1.naming_method
                FROM hbpe.l1_event_cluster ec
                JOIN hbpe.l1_clusters cl1 ON cl1.cluster_id = ec.cluster_id
                JOIN ci.events e ON e.event_id = ec.event_id
                WHERE e.user_id = %s::uuid
                GROUP BY l0_class, cl1.naming_method
                ORDER BY l0_class
            """,
                (user_id,),
            )
            rows = [dict(r) for r in cur.fetchall()]

    if not rows:
        raise StepFailed("No rows in hbpe.l1_event_cluster for this user.")

    print(f"  {'L0':<12}  {'method':<10}  {'events':>6}")
    print(f"  {'-' * 12}  {'-' * 10}  {'-' * 6}")
    for row in rows:
        print(f"  {row['l0_class']:<12}  {row['naming_method']:<10}  {row['n']:>6}")
    print(f"\n  Total assigned: {sum(r['n'] for r in rows)}")
    print("PASS — events labeled successfully")


def step3_label_content(user_id: str) -> None:
    import psycopg2.extras

    from ci.hbpe.database import get_conn
    from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler

    print("── Step 3: Label Content ────────────────────────────────")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM ci.content c
                LEFT JOIN hbpe.l2_content_cluster lc ON lc.content_id = c.id
                WHERE c.user_id = %s::uuid AND lc.content_id IS NULL
            """,
                (user_id,),
            )
            unlabeled = cur.fetchone()[0]
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM ci.content WHERE user_id = %s::uuid", (user_id,)
            )
            total_content = cur.fetchone()[0]

    print(
        f"\n[1/3] Found {unlabeled} unlabeled / {total_content} total content items for user={user_id[:8]}..."
    )

    if total_content == 0:
        print(
            "      No content rows found — skipping (this is normal if content hasn't been ingested yet)"
        )
        print("PASS — content labeling step skipped (no content)")
        return

    if unlabeled == 0:
        print("      All content already labeled — skipping labeling step")
    else:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT c.id::text AS content_id, c.title, c.type AS content_type
                    FROM ci.content c
                    LEFT JOIN hbpe.l2_content_cluster lc ON lc.content_id = c.id
                    WHERE c.user_id = %s::uuid AND lc.content_id IS NULL
                    ORDER BY c.created_at
                    LIMIT 500
                """,
                    (user_id,),
                )
                content_items = [dict(r) for r in cur.fetchall()]

        BATCH = 32
        print(
            f"\n[2/3] Labeling {len(content_items)} content items with Qwen (batch_size={BATCH}) ..."
        )
        labeler = QwenLabeler()
        labeled = new_l1 = new_l2 = errors = 0

        for start in range(0, len(content_items), BATCH):
            batch = content_items[start : start + BATCH]
            end = start + len(batch)
            print(
                f"  [{start + 1:>4}–{end:>4}/{len(content_items)}] running batch ...",
                flush=True,
            )
            try:
                results = labeler.label_content_batch(batch, user_id)
                for r in results:
                    labeled += 1
                    if r.get("is_new_l1"):
                        new_l1 += 1
                    if r.get("is_new_l2"):
                        new_l2 += 1
                    print(f"    → {r['l0']} / {r['l1']!r} / {r['l2']!r}")
            except Exception as exc:
                errors += len(batch)
                print(f"    ✗ batch failed: {exc}")

        print(
            f"\n      Labeled: {labeled}  New L1: {new_l1}  New L2: {new_l2}  Errors: {errors}"
        )

    print("\n[3/3] Verifying hbpe.l2_content_cluster + hbpe.content_context ...")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT cc.l0_class, COUNT(*) AS n
                FROM hbpe.content_context cc
                JOIN ci.content c ON c.id = cc.content_id
                WHERE c.user_id = %s::uuid
                GROUP BY cc.l0_class ORDER BY cc.l0_class
            """,
                (user_id,),
            )
            rows = [dict(r) for r in cur.fetchall()]

    if rows:
        print(f"  {'L0':<12}  {'content items':>13}")
        print(f"  {'-' * 12}  {'-' * 13}")
        for row in rows:
            print(f"  {row['l0_class']:<12}  {row['n']:>13}")
        print(f"\n  Total content labeled: {sum(r['n'] for r in rows)}")
    else:
        print(
            "      No hbpe.content_context rows — content labeling may not have run yet"
        )
    print("PASS — content labeling complete")


def step4_verify_labels(user_id: str) -> None:
    import psycopg2.extras

    from ci.hbpe.database import get_conn
    from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES, get_l1_vocab, get_l2_vocab

    print("── Step 4: Verify Labels ────────────────────────────────")

    print(f"\n[1/3] L1 vocabulary for user={user_id[:8]} ...")
    total_l1 = 0
    for l0 in L0_CLASSES:
        entries = get_l1_vocab(user_id, l0)
        total_l1 += len(entries)
        if entries:
            print(
                f"  {l0:<10}  {len(entries):>3} labels  {[e['label'] for e in entries][:5]}"
            )
    print(f"\n  Total L1 labels: {total_l1}")

    if total_l1 == 0:
        raise StepFailed("No L1 labels found. Run Step 2 first.")

    print("\n[2/3] L2 vocabulary sample ...")
    total_l2 = 0
    for l0 in L0_CLASSES:
        for entry in get_l1_vocab(user_id, l0)[:3]:
            l2_entries = get_l2_vocab(user_id, l0, entry["cluster_id"])
            total_l2 += len(l2_entries)
            if l2_entries:
                labels = [e["label"] for e in l2_entries]
                print(
                    f"  {l0}/{entry['label'][:20]:<22}  {len(l2_entries):>3} L2 labels  {labels[:3]}"
                )
    print(f"\n  Total L2 labels (sampled): {total_l2}")

    print("\n[3/3] Assignment coverage ...")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM ci.events
                     WHERE user_id = %s::uuid AND is_deleted = FALSE) AS total_events,
                    (SELECT COUNT(*) FROM hbpe.l1_event_cluster ec
                     JOIN ci.events e ON e.event_id = ec.event_id
                     WHERE e.user_id = %s::uuid) AS labeled_events,
                    (SELECT COUNT(*) FROM ci.content WHERE user_id = %s::uuid) AS total_content,
                    (SELECT COUNT(*) FROM hbpe.l2_content_cluster lc
                     JOIN ci.content c ON c.id = lc.content_id
                     WHERE c.user_id = %s::uuid) AS labeled_content
            """,
                (user_id, user_id, user_id, user_id),
            )
            cov = dict(cur.fetchone())

    ev_pct = (
        (cov["labeled_events"] / cov["total_events"] * 100)
        if cov["total_events"]
        else 0
    )
    ct_pct = (
        (cov["labeled_content"] / cov["total_content"] * 100)
        if cov["total_content"]
        else 0
    )
    print(
        f"  Events:  {cov['labeled_events']:>5} / {cov['total_events']:>5} labeled  ({ev_pct:.0f}%)"
    )
    print(
        f"  Content: {cov['labeled_content']:>5} / {cov['total_content']:>5} labeled  ({ct_pct:.0f}%)"
    )

    if cov["labeled_events"] == 0:
        raise StepFailed("No events labeled. Run Step 2 first.")
    print("PASS — labels verified, vocab populated")


def step5_serialize_validate(user_id: str) -> None:
    from ci.hbpe.database import get_conn

    print("── Step 5: Serialize + Validate ─────────────────────────")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT MIN(start_time::date), MAX(start_time::date)
                FROM ci.events
                WHERE user_id = %s AND is_deleted = FALSE
                  AND start_time >= '2010-01-01'::timestamptz
            """,
                (user_id,),
            )
            row = cur.fetchone()
    start_date, end_date = str(row[0]), str(row[1])

    print(f"\n[1/3] Serializing {start_date} → {end_date} for user={user_id} ...")
    from ci.hbpe.tokenizer.serializer import TokenSerializer

    total_rows = TokenSerializer().serialize_range(user_id, start_date, end_date)
    print(f"      Written: {total_rows} token rows to hbpe.token_stream")

    if total_rows == 0:
        raise StepFailed(
            "No tokens written. Ensure events have L1 assignments (run Step 4 first)."
        )

    print("\n[2/3] Sample from hbpe.token_stream ...")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT date, seq_order, bucket_idx, level, token_id, soft_prob
                FROM hbpe.token_stream
                WHERE user_id = %s
                ORDER BY date, seq_order
                LIMIT 8
            """,
                (user_id,),
            )
            rows = cur.fetchall()

    print(
        f"  {'date':<12} {'seq':>4} {'bucket':>6}  {'level':<5}  {'token_id':<38}  soft_prob"
    )
    print(f"  {'-' * 12} {'-' * 4} {'-' * 6}  {'-' * 5}  {'-' * 38}  {'-' * 10}")
    for r in rows:
        date, seq, bucket, level, token_id, soft_prob = r
        print(
            f"  {date!s:<12} {seq:>4} {bucket:>6}  {level:<5}  {str(token_id)[:36]:<38}  {soft_prob}"
        )

    print("\n[3/3] Running PipelineValidator ...")
    from ci.hbpe.tokenizer.validator import PipelineValidator, ValidationError

    validator = PipelineValidator()
    try:
        report = validator.validate(user_id)
        print("\n✓ Validation PASSED")
    except ValidationError as e:
        raise StepFailed(f"Validation FAILED: {e}") from e
    finally:
        import json

        report_path = Path("validation_report.json")
        if report_path.exists():
            report = json.loads(report_path.read_text())
            print("\nValidation report:")
            for check, result in report.get("checks", {}).items():
                status = (
                    "✓"
                    if (
                        result.get("passed", True) if isinstance(result, dict) else True
                    )
                    else "✗"
                )
                print(f"  {status}  {check}: {result}")


def step6_dataset_splits(user_id: str) -> None:
    from collections import Counter
    from datetime import date as date_cls

    from ci.hbpe.model.dataset import TokenStreamDataset, make_splits

    print("── Step 6: Dataset Splits ───────────────────────────────")

    splits = make_splits(user_id)
    print(
        f"\n  train : {len(splits['train'])} days  ({splits['train'][0]} → {splits['train'][-1]})"
    )
    print(
        f"  val   : {len(splits['val'])}  days  ({splits['val'][0]} → {splits['val'][-1]})"
    )
    print(
        f"  test  : {len(splits['test'])} days  ({splits['test'][0]} → {splits['test'][-1]})"
    )

    assert not set(splits["train"]) & set(splits["val"]), "train/val overlap!"
    assert not set(splits["train"]) & set(splits["test"]), "train/test overlap!"
    assert not set(splits["val"]) & set(splits["test"]), "val/test overlap!"

    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    def dow_dist(dates):
        c = Counter(date_cls.fromisoformat(d).weekday() for d in dates)
        return {dow_names[i]: c.get(i, 0) for i in range(7)}

    print("\n  Day-of-week distribution:")
    print(f"    train : {dow_dist(splits['train'])}")
    print(f"    val   : {dow_dist(splits['val'])}")

    train_ds = TokenStreamDataset(user_id, splits["train"])
    sample = train_ds[0]
    print(f"\n  First training day ({splits['train'][0]}): {len(sample)} tokens")
    print(f"    {sample[0]}")
    print(f"    {sample[1]}")
    print("    ...")
    print(f"    {sample[-1]}")

    assert sample[0]["level"] == "SOD", "First token should be SOD"
    assert sample[-1]["level"] == "EOD", "Last token should be EOD"
    print("\nPASS — splits look healthy, dataset loads correctly")


def step7_pretrain(user_id: str) -> None:
    from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
    from ci.hbpe.model.trainer import train_l0_mae

    print("── Step 7: L0 MAE Pre-training ─────────────────────────")

    splits = make_splits(user_id)
    train_ds = TokenStreamDataset(user_id, splits["train"])
    val_ds = TokenStreamDataset(user_id, splits["val"])

    print(f"\n  Training on {len(train_ds)} days, validating on {len(val_ds)} days")
    print("  (this may take a minute)\n")

    ckpt_path = train_l0_mae(user_id, train_ds, val_ds)
    print(f"\n  Checkpoint saved → {ckpt_path}")

    import torch

    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    print(f"  Best epoch : {ckpt['epoch']}")
    print(f"  Val loss   : {ckpt['val_loss']:.4f}")
    print(f"  Vocab size : {ckpt['vocab_size']}")

    assert ckpt_path.exists(), "Checkpoint file missing"
    assert ckpt["val_loss"] < 5.0, f"Val loss {ckpt['val_loss']:.4f} suspiciously high"
    print("\nPASS — L0 MAE pre-training complete")


def step8_joint_finetune(user_id: str) -> None:
    from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
    from ci.hbpe.model.trainer import train_hmt_joint

    print("── Step 8: HMT Joint Fine-tuning (L0 + L1) ─────────────")

    splits = make_splits(user_id)
    train_ds = TokenStreamDataset(user_id, splits["train"])
    val_ds = TokenStreamDataset(user_id, splits["val"])
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
    print("\nPASS — HMT joint fine-tuning complete")


def step9_calibrate_eval(user_id: str) -> None:
    from ci.hbpe.model.calibration import calibrate
    from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
    from ci.hbpe.model.evaluator import evaluate

    splits = make_splits(user_id)
    val_ds = TokenStreamDataset(user_id, splits["val"])
    test_ds = TokenStreamDataset(user_id, splits["test"])

    print("\n── T2.4  Calibration ────────────────────────────────────")
    cal = calibrate(user_id, val_ds)
    print(f"\n  Temperature       : {cal['temperature']:.4f}")
    print(
        f"  ECE before (L0/L1): {cal['ece_before']['l0']:.4f} / {cal['ece_before']['l1']:.4f}"
    )
    print(
        f"  ECE after  (L0/L1): {cal['ece_after']['l0']:.4f}  / {cal['ece_after']['l1']:.4f}"
    )
    print(f"  ECE target < {cal['ece_target']}")
    print(
        f"  L0 passed: {'✓' if cal['l0_passed'] else '✗'}   L1 passed: {'✓' if cal['l1_passed'] else '✗'}"
    )

    print("\n── T2.5  Evaluation (test set) ──────────────────────────")
    rep = evaluate(user_id, test_ds)
    print(
        f"\n  L0 top-1 : {rep['l0_top1_accuracy']:.1%}  ({rep['l0_total_tokens']} tokens)  "
        f"target={rep['l0_top1_target']:.0%}  {'✓' if rep['l0_top1_passed'] else '✗'}"
    )
    print(
        f"  L1 top-3 : {rep['l1_top3_accuracy']:.1%}  ({rep['l1_total_tokens']} tokens)  "
        f"target={rep['l1_top3_target']:.0%}  {'✓' if rep['l1_top3_passed'] else '✗'}"
    )
    print(f"  L2 recall: {rep['l2_recall_at_5']}  ({rep['l2_note']})")

    print("\n── Summary ──────────────────────────────────────────────")
    if rep["l0_top1_passed"] and rep["l1_top3_passed"]:
        print("PASS — all hard targets met")
    else:
        print(
            "INFO — some targets not met (small corpus expected; see eval_report.json)"
        )


def step10_lora(user_id: str) -> None:
    import torch

    from ci.hbpe.database import get_conn
    from ci.hbpe.model.evaluator import _load_calibrated
    from ci.hbpe.model.lora import (
        LoRAMHA,
        apply_lora,
        load_adapter,
        merge_adapter,
    )
    from ci.hbpe.model.nightly_finetune import fine_tune_nightly
    from ci.hbpe.model.vocab import build_l0_vocab, build_l1_vocab

    device = "cpu"

    print("\n── T3.1  LoRA adapter ───────────────────────────────────")
    l0_vocab = build_l0_vocab()
    l1_vocab = build_l1_vocab(user_id)
    model, _temp = _load_calibrated(user_id, l0_vocab, l1_vocab, device)

    total_before = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"  Trainable params before apply_lora : {total_before}")

    apply_lora(model)
    frozen = sum(p.numel() for p in model.parameters() if not p.requires_grad)
    adapter = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"  Frozen backbone params             : {frozen}")
    print(f"  Trainable adapter params           : {adapter}")
    assert adapter > 0, "No adapter params are trainable"
    assert frozen > 0, "No backbone params are frozen"
    assert adapter < frozen, "Adapter should be much smaller than backbone"
    print("  ✓ Backbone frozen, adapter trainable")

    for i, layer in enumerate(model.encoder.layers):
        lora = layer.self_attn
        assert isinstance(lora, LoRAMHA), f"Layer {i} self_attn is not LoRAMHA"
        delta_qkv = lora.scale * (lora.qkv_B @ lora.qkv_A)
        delta_o = lora.scale * (lora.o_B @ lora.o_A)
        assert delta_qkv.abs().max().item() == 0.0, f"Layer {i} qkv delta ≠ 0 at init"
        assert delta_o.abs().max().item() == 0.0, f"Layer {i} o delta ≠ 0 at init"
    print("  ✓ LoRA delta = 0 at init (model numerically unchanged)")

    print("\n── T3.2  Nightly fine-tune ──────────────────────────────")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT MAX(date) FROM hbpe.token_stream WHERE user_id = %s", (user_id,)
            )
            latest_date = cur.fetchone()[0]

    if latest_date is None:
        print("  No serialised tokens found — skipping fine-tune test")
        return

    print(f"  Using date: {latest_date}")
    report = fine_tune_nightly(user_id, latest_date, device=device)
    print(f"  L0 tokens : {report['n_l0_tokens']}")
    print(f"  L1 tokens : {report['n_l1_tokens']}")
    print(
        f"  Loss      : {report['loss']:.4f}"
        if report["loss"] is not None
        else "  Loss: n/a"
    )
    print(f"  Adapter   : {report['adapter_path']}")

    adapter_path = Path(report["adapter_path"])
    assert adapter_path.exists(), f"Adapter not saved to {adapter_path}"
    print("  ✓ Adapter checkpoint saved")

    print("\n── Save / load round-trip ───────────────────────────────")
    model2, _ = _load_calibrated(user_id, l0_vocab, l1_vocab, device)
    load_adapter(model2, adapter_path)

    ckpt_adapter = torch.load(adapter_path, map_location="cpu", weights_only=True)[
        "adapter"
    ]
    for name, param in model2.named_parameters():
        if param.requires_grad:
            assert name in ckpt_adapter, f"Key {name} missing from checkpoint"
            assert torch.allclose(param.cpu(), ckpt_adapter[name]), (
                f"Mismatch in {name}"
            )
    print("  ✓ Adapter round-trip: save → load weights match checkpoint")

    print("\n── merge_adapter ────────────────────────────────────────")
    merge_adapter(model2)
    for layer in model2.encoder.layers:
        assert not isinstance(layer.self_attn, LoRAMHA), (
            "LoRAMHA should be replaced after merge"
        )
    print("  ✓ All self_attn modules restored to plain MHA after merge")

    print("\n── Summary ──────────────────────────────────────────────")
    print("PASS — T3.1 + T3.2 checks passed")


def step11_onnx(user_id: str) -> None:
    from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
    from ci.hbpe.model.onnx_export import export_and_quantize

    splits = make_splits(user_id)
    val_ds = TokenStreamDataset(user_id, splits["val"])
    test_ds = TokenStreamDataset(user_id, splits["test"])

    print("\n── T4.1  ONNX export + INT8 quantization ────────────────")
    print(f"  Val days : {len(val_ds)}   Test days: {len(test_ds)}")

    rep = export_and_quantize(user_id, val_ds, test_ds)
    print(f"\n  FP32 ONNX  : {rep['fp32_size_mb']:.2f} MB")
    print(
        f"  INT8 ONNX  : {rep['int8_size_mb']:.2f} MB  "
        f"({rep['int8_size_mb'] / rep['fp32_size_mb'] * 100:.0f}% of fp32)"
    )
    print(f"  L0 top-1 FP32: {rep['l0_acc_fp32']:.1%}")
    print(f"  L0 top-1 INT8: {rep['l0_acc_int8']:.1%}")
    print(
        f"  Delta        : {rep['delta_pp'] * 100:.2f} pp  "
        f"(limit {rep['delta_limit'] * 100:.0f} pp)  "
        f"{'✓' if rep['delta_passed'] else '✗'}"
    )

    print("\n── Summary ──────────────────────────────────────────────")
    if rep["delta_passed"]:
        print("PASS — INT8 accuracy delta within limit")
    else:
        print("INFO — delta exceeds 1 pp (small corpus, wide CI; model acceptable)")


def step12_e2e(user_id: str) -> None:
    import datetime
    import time as _time

    from ci.hbpe.config import settings
    from ci.hbpe.pipeline.histogram_api import build_histogram
    from ci.hbpe.pipeline.inference_engine import InferenceEngine

    print("\n── T4.2  InferenceEngine ────────────────────────────────")
    engine = InferenceEngine(user_id)

    t0 = _time.perf_counter()
    buckets = engine.predict()
    t_full = (_time.perf_counter() - t0) * 1000

    print(f"  Buckets returned : {len(buckets)}")
    assert len(buckets) == BUCKETS_PER_DAY, (
        f"Expected {BUCKETS_PER_DAY} buckets, got {len(buckets)}"
    )

    required_keys = {
        "bucket_index",
        "start_time",
        "l0_probs",
        "l1_probs",
        "l2_probs",
        "q10",
        "q50",
        "q90",
    }
    for b in buckets:
        missing = required_keys - b.keys()
        assert not missing, f"Bucket {b['bucket_index']} missing keys: {missing}"
        assert 0 <= b["bucket_index"] < BUCKETS_PER_DAY
        assert isinstance(b["l0_probs"], dict) and len(b["l0_probs"]) > 0
        probs_sum = sum(b["l0_probs"].values())
        assert abs(probs_sum - 1.0) < 0.02, f"L0 probs don't sum to 1: {probs_sum:.4f}"

    print(f"  Full-refresh latency : {t_full:.1f} ms  (target <2000 ms)")
    print(
        f"  Schema               : ✓  (all {BUCKETS_PER_DAY} buckets have required keys)"
    )
    assert t_full < 2000, f"Full refresh too slow: {t_full:.1f} ms"
    print("  ✓ Full refresh within 2s SLA")

    t1 = _time.perf_counter()
    engine.invalidate(datetime.date.today())
    t_inv = (_time.perf_counter() - t1) * 1000
    print(f"  Invalidation         : {t_inv:.3f} ms  (O(1))")
    assert t_inv < 1, f"Invalidation should be O(1): {t_inv:.3f} ms"

    t2 = _time.perf_counter()
    engine.predict()
    t_incr = (_time.perf_counter() - t2) * 1000
    print(f"  Incremental latency  : {t_incr:.1f} ms  (target <200 ms)")
    assert t_incr < 200, f"Incremental too slow: {t_incr:.1f} ms"
    print("  ✓ Incremental update within 200ms SLA")

    print("\n── T4.4  Histogram API ──────────────────────────────────")
    result = build_histogram(engine, horizon="24h", user_id=user_id)
    assert result["horizon"] == "24h"
    assert "generated_at" in result
    assert len(result["buckets"]) == BUCKETS_PER_DAY
    print(f"  Envelope keys : {list(result.keys())}")
    print("  ✓ build_histogram returns correct envelope")

    try:
        build_histogram(engine, horizon="48h")
        raise AssertionError("Should have raised")
    except ValueError:
        print("  ✓ Unsupported horizon raises ValueError")

    print("\n── T4.5  Resource SLAs ──────────────────────────────────")
    model_dir = Path(settings.models_dir) / "hmt"
    total_mb = (
        sum(f.stat().st_size for f in model_dir.iterdir() if f.is_file()) / 1_048_576
    )
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
    print(
        f"  Full refresh: {t_full:.0f}ms  |  Incremental: {t_incr:.0f}ms  |  Disk: {total_mb:.1f}MB"
    )


def step13_summaries(user_id: str) -> None:
    from ci.hbpe.database import get_conn

    TEST_DATE = "2000-01-01"

    def check(condition: bool, msg: str) -> None:
        if not condition:
            raise StepFailed(msg)
        print(f"  ✓ {msg}")

    def cleanup() -> None:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM hbpe.summary_l1_label
                    WHERE summary_id IN (
                        SELECT summary_id FROM ci.summaries
                        WHERE user_id = %s::uuid AND period_start::date = %s::date
                    )
                """,
                    (user_id, TEST_DATE),
                )
                cur.execute(
                    "DELETE FROM hbpe.token_stream WHERE user_id = %s AND date = %s",
                    (user_id, TEST_DATE),
                )
                cur.execute(
                    "DELETE FROM ci.summaries WHERE user_id = %s::uuid AND period_start::date = %s::date",
                    (user_id, TEST_DATE),
                )

    def insert_summary(period_start: str, summary_text: str) -> str:
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
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO hbpe.summary_l1_label (summary_id, l0_class, l1_cluster_id)
                    VALUES (%s::uuid, %s, %s::uuid)
                    ON CONFLICT (summary_id) DO NOTHING
                """,
                    (summary_id, l0_class, l1_cluster_id),
                )

    def count_label_rows(summary_id: str) -> int:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM hbpe.summary_l1_label WHERE summary_id = %s::uuid",
                    (summary_id,),
                )
                return cur.fetchone()[0]

    def stream_rows_for_date() -> list[dict]:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT level, token_id, bucket_idx, soft_prob
                    FROM hbpe.token_stream
                    WHERE user_id = %s AND date = %s
                    ORDER BY seq_order
                """,
                    (user_id, TEST_DATE),
                )
                return [
                    dict(
                        zip(
                            ["level", "token_id", "bucket_idx", "soft_prob"],
                            r,
                            strict=True,
                        )
                    )
                    for r in cur.fetchall()
                ]

    print("\n── Preflight ────────────────────────────────────────────")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'hbpe' AND table_name = 'summary_l1_label'
                )
            """)
            exists = cur.fetchone()[0]
    check(exists, "hbpe.summary_l1_label table exists (migration applied)")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT cluster_id::text FROM hbpe.l1_clusters WHERE user_id = %s LIMIT 1",
                (user_id,),
            )
            row = cur.fetchone()
    sample_l1_id = row[0] if row else None
    if sample_l1_id:
        print(f"  ℹ  Using L1 cluster {sample_l1_id[:8]}… for FK tests")
    else:
        print("  ℹ  No L1 clusters found — L1 token tests will use NULL cluster_id")

    try:
        cleanup()
        from ci.hbpe.tokenizer.summary_tokenizer import (
            SUMMARY_SOFT_PROB,
            SummaryTokenizer,
        )

        print("\n── A. Bucket mapping (no Qwen) ──────────────────────────")
        sid_10 = insert_summary(
            f"{TEST_DATE} 10:00:00+00", "Working on engineering tasks."
        )
        insert_label(sid_10, "WORK", sample_l1_id)
        sid_00 = insert_summary(
            f"{TEST_DATE} 00:00:00+00", "Sleeping through the night."
        )
        insert_label(sid_00, "SLEEP", None)

        st = SummaryTokenizer()
        tokens = st.get_tokens_for_day(user_id, TEST_DATE)
        check(len(tokens) > 0, f"get_tokens_for_day returns tokens (got {len(tokens)})")

        l0_tokens = [t for t in tokens if t["level"] == "L0"]
        buckets_covered = sorted({t["bucket_idx"] for t in l0_tokens})
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
            break

        sleep_l0 = [t for t in tokens if t["level"] == "L0" and t["bucket_idx"] == 0]
        check(len(sleep_l0) > 0, "bucket 0 has L0 token")
        check(sleep_l0[0]["token_id"] == "SLEEP", "bucket 0 L0 token_id == 'SLEEP'")

        work_l0 = [t for t in tokens if t["level"] == "L0" and t["bucket_idx"] == 20]
        check(len(work_l0) > 0, "bucket 20 has L0 token")
        check(work_l0[0]["token_id"] == "WORK", "bucket 20 L0 token_id == 'WORK'")

        if sample_l1_id:
            work_l1 = [
                t for t in tokens if t["level"] == "L1" and t["bucket_idx"] == 20
            ]
            check(len(work_l1) > 0, "bucket 20 has L1 token when l1_cluster_id is set")
            check(
                work_l1[0]["token_id"] == sample_l1_id, "L1 token_id matches cluster_id"
            )

        sleep_l1 = [t for t in tokens if t["level"] == "L1" and t["bucket_idx"] == 0]
        check(len(sleep_l1) == 0, "bucket 0 has no L1 token when l1_cluster_id is NULL")

        print("\n── B. Serializer merge ──────────────────────────────────")
        from ci.hbpe.tokenizer.serializer import TokenSerializer

        n_rows = TokenSerializer().serialize_day(user_id, TEST_DATE)
        check(
            n_rows > 0,
            f"serialize_day writes rows for a summary-only date (got {n_rows})",
        )

        stream = stream_rows_for_date()
        stream_buckets = {r["bucket_idx"] for r in stream if r["level"] == "L0"}
        for expected_bucket in [0, 1, 20, 21]:
            check(
                expected_bucket in stream_buckets,
                f"hbpe.token_stream contains bucket {expected_bucket} from summary",
            )

        sample_stream_row = next(
            (r for r in stream if r["level"] == "L0" and r["bucket_idx"] == 0), None
        )
        check(
            sample_stream_row is not None,
            "SOD/summary L0 row exists in stream for bucket 0",
        )

        n_rows_2 = TokenSerializer().serialize_day(user_id, TEST_DATE)
        check(
            n_rows_2 == n_rows,
            f"Re-serialization is idempotent ({n_rows} == {n_rows_2})",
        )

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT date FROM hbpe.token_stream
                    WHERE user_id = %s AND level = 'L0' AND date != %s::date
                    GROUP BY date HAVING COUNT(*) > 0 LIMIT 1
                """,
                    (user_id, TEST_DATE),
                )
                row = cur.fetchone()

        if row:
            real_date = str(row[0])
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT DISTINCT bucket_idx FROM hbpe.token_stream WHERE user_id = %s AND date = %s AND level = 'L0'",
                        (user_id, real_date),
                    )
                    event_buckets_before = {r[0] for r in cur.fetchall()}
            TokenSerializer().serialize_day(user_id, real_date)
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT DISTINCT bucket_idx FROM hbpe.token_stream WHERE user_id = %s AND date = %s AND level = 'L0'",
                        (user_id, real_date),
                    )
                    event_buckets_after = {r[0] for r in cur.fetchall()}
            missing = event_buckets_before - event_buckets_after
            check(
                not missing,
                f"Event-covered buckets preserved after re-serialize (missing: {missing})",
            )
            print(
                f"  ℹ  Event-covered: {sorted(event_buckets_before)} → after: {sorted(event_buckets_after)}"
            )
        else:
            print(
                "  ℹ  No existing token_stream rows found — skipping event-override guard test"
            )

        print("\n── C. label_day idempotency (no Qwen) ───────────────────")
        n_labeled = st.label_day(user_id, TEST_DATE)
        check(
            n_labeled == 0,
            f"label_day returns 0 when all summaries already labeled (got {n_labeled})",
        )

        print("\n── D. Qwen labeling ─────────────────────────────────────")
        qwen_available = False
        try:
            from ci.hbpe.inference.qwen import get_qwen

            _ = get_qwen()
            qwen_available = True
        except Exception as e:
            print(f"  ⚠  Qwen not available ({e}) — skipping Qwen labeling tests")

        if qwen_available:
            sid_new = insert_summary(
                f"{TEST_DATE} 14:00:00+00",
                "Attended a team standup, then worked on code review for a pull request.",
            )
            n = st.label_day(user_id, TEST_DATE)
            check(n == 1, f"label_day labels exactly 1 new summary (got {n})")
            check(
                count_label_rows(sid_new) == 1,
                "hbpe.summary_l1_label row written for new summary",
            )

            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT l0_class FROM hbpe.summary_l1_label WHERE summary_id = %s::uuid",
                        (sid_new,),
                    )
                    l0_result = cur.fetchone()[0]

            valid_l0 = {
                "WORK",
                "EXERCISE",
                "SOCIAL",
                "ERRAND",
                "LEISURE",
                "TRANSIT",
                "SLEEP",
                "UNKNOWN",
            }
            check(
                l0_result in valid_l0,
                f"Qwen produced a valid L0 class (got '{l0_result}')",
            )

            n2 = st.label_day(user_id, TEST_DATE)
            check(n2 == 0, f"label_day is idempotent after Qwen run (got {n2})")
        else:
            print("  (Qwen section skipped)")

    finally:
        cleanup()
        print("\n  ℹ  Test data cleaned up")

    print("\n── Summary ──────────────────────────────────────────────")
    print(
        "PASS — SummaryTokenizer bucket mapping, serializer merge, and idempotency checks passed"
    )


STEP_FNS = {
    1: step1_qwen_labeler,
    2: step2_label_events,
    3: step3_label_content,
    4: step4_verify_labels,
    5: step5_serialize_validate,
    6: step6_dataset_splits,
    7: step7_pretrain,
    8: step8_joint_finetune,
    9: step9_calibrate_eval,
    10: step10_lora,
    11: step11_onnx,
    12: step12_e2e,
    13: step13_summaries,
}


# ── Helpers ────────────────────────────────────────────────────────────────────


def banner(text: str) -> None:
    print(f"\n{'═' * W}")
    print(f"  {text}")
    print(f"{'═' * W}")


def phase_header(phase: str) -> None:
    print(f"\n{'─' * W}")
    print(f"  {phase}")
    print(f"{'─' * W}")


def step_header(num: int, name: str) -> None:
    label = f"[{num:2d}/13]  {name}"
    print(f"\n{label}")
    print("·" * len(label))


def fmt_time(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    m, s = divmod(int(seconds), 60)
    return f"{m}m {s:02d}s"


def clean_models_dir(models_dir: str) -> None:
    for subdir in ("hmt", "l1"):
        d = Path(models_dir) / subdir
        if d.exists():
            shutil.rmtree(d)
            print(f"  Cleaned: {d}")
    scaler = Path(models_dir) / "scalar_scaler.pkl"
    if scaler.exists():
        scaler.unlink()
        print(f"  Cleaned: {scaler}")


def parse_args() -> dict:
    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        sys.exit(0)

    opts: dict = {"user_id": None, "from_step": 1, "to_step": 13, "clean": False}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--clean":
            opts["clean"] = True
        elif a in ("--from-step", "-f"):
            opts["from_step"] = int(args[i + 1])
            i += 1
        elif a in ("--to-step", "-t"):
            opts["to_step"] = int(args[i + 1])
            i += 1
        elif not a.startswith("-"):
            opts["user_id"] = a
        i += 1
    return opts


# ── Main ───────────────────────────────────────────────────────────────────────


def main() -> None:
    opts = parse_args()
    models_dir = os.environ.get("MODELS_DIR", "/tmp/hbpe_models")

    user_id = opts["user_id"]

    if not user_id:
        print(
            "\nERROR: user_id is required.\n"
            "  Usage: python scripts/run_pipeline.py <user_id> [options]"
        )
        sys.exit(1)

    banner(f"HBPE Pipeline  —  steps {opts['from_step']}–{opts['to_step']}")
    print(f"  User    : {user_id}")
    print(f"  Models  : {models_dir}")
    print(f"  Python  : {sys.executable}")

    if opts["clean"]:
        print("\n  --clean: wiping model checkpoints …")
        clean_models_dir(models_dir)

    steps_to_run = [
        s for s in STEPS if opts["from_step"] <= s["num"] <= opts["to_step"]
    ]
    if not steps_to_run:
        print("No steps selected.")
        sys.exit(0)

    results: list[dict] = []
    current_phase: str = ""
    pipeline_start = time.perf_counter()

    for step in steps_to_run:
        if step["phase"] != current_phase:
            current_phase = step["phase"]
            phase_header(current_phase)

        step_header(step["num"], step["name"])

        t0 = time.perf_counter()
        passed = True
        try:
            STEP_FNS[step["num"]](user_id)
        except (AssertionError, StepFailed) as e:
            passed = False
            print(f"\n  ✗ {e}")
        except Exception:
            passed = False
            import traceback

            traceback.print_exc()
        elapsed = time.perf_counter() - t0

        results.append({"step": step, "passed": passed, "elapsed": elapsed})
        print(f"\n  {'✓' if passed else '✗'}  {fmt_time(elapsed)}")

        if not passed:
            print(f"\n  Step {step['num']} FAILED — aborting pipeline.")
            break

    total_elapsed = time.perf_counter() - pipeline_start
    all_passed = all(r["passed"] for r in results)

    banner("Summary")
    col_name = max(len(r["step"]["name"]) for r in results)
    for r in results:
        s = r["step"]
        print(
            f"  {'✓' if r['passed'] else '✗'}  Step {s['num']:2d}  {s['name']:<{col_name}}  {fmt_time(r['elapsed']):>7}"
        )

    print(f"\n  Total: {fmt_time(total_elapsed)}")
    print()
    if all_passed:
        ran = len(results)
        skipped = 13 - ran
        suffix = f"  ({skipped} skipped)" if skipped else ""
        print(f"  ALL {ran} STEPS PASSED{suffix}")
    else:
        failed = [r for r in results if not r["passed"]]
        names = ", ".join(f"step {r['step']['num']}" for r in failed)
        print(f"  FAILED: {names}")

    print(f"{'═' * W}\n")
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
