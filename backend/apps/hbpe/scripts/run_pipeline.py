#!/usr/bin/env python3
"""
HBPE Pipeline Runner — cold-start through final predictions.

Runs all 13 steps in order, streaming each step's output live, then
prints a timing summary table.

Usage (from backend/apps/hbpe/):
    DATABASE_URL=postgresql://... MODELS_DIR=/tmp/hbpe_models PYTHONPATH=src \\
        python scripts/run_pipeline.py [user_id] [options]

Options:
    --from-step N    Start from step N, skipping earlier steps (default: 1)
    --to-step N      Stop after step N (default: 13)
    --clean          Delete all model checkpoints in MODELS_DIR before starting
    --help / -h      Show this message

If user_id is omitted it is auto-detected from ci.users (single-user mode).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ── Step registry ──────────────────────────────────────────────────────────────

STEPS = [
    {"num":  1, "phase": "Phase 1 · Tokenizer Pipeline", "name": "Qwen Labeler",           "script": "test_step1_l0.py",            "needs_user": False},
    {"num":  2, "phase": "Phase 1 · Tokenizer Pipeline", "name": "Label Events",           "script": "test_step2_features.py",      "needs_user": True},
    {"num":  3, "phase": "Phase 1 · Tokenizer Pipeline", "name": "Label Content",          "script": "test_step3_discovery.py",     "needs_user": True},
    {"num":  4, "phase": "Phase 1 · Tokenizer Pipeline", "name": "Verify Labels",          "script": "test_step4_router.py",        "needs_user": True},
    {"num":  5, "phase": "Phase 1 · Tokenizer Pipeline", "name": "Serialize + Validate",   "script": "test_step5_validate.py",      "needs_user": True},
    {"num":  6, "phase": "Phase 2 · Model Training",     "name": "Dataset Splits",         "script": "test_step6_splits.py",        "needs_user": True},
    {"num":  7, "phase": "Phase 2 · Model Training",     "name": "L0 MAE Pre-training",    "script": "test_step7_pretrain.py",      "needs_user": True},
    {"num":  8, "phase": "Phase 2 · Model Training",     "name": "HMT Joint Fine-tuning",  "script": "test_step8_joint.py",         "needs_user": True},
    {"num":  9, "phase": "Phase 2 · Model Training",     "name": "Calibration + Eval",     "script": "test_step9_calibrate_eval.py","needs_user": True},
    {"num": 10, "phase": "Phase 3 · Personalization",    "name": "LoRA Adapter",           "script": "test_step10_lora.py",         "needs_user": True},
    {"num": 11, "phase": "Phase 4 · Deployment",         "name": "ONNX Export + INT8",     "script": "test_step11_onnx.py",         "needs_user": True},
    {"num": 12, "phase": "Phase 4 · Deployment",         "name": "E2E Inference Engine",   "script": "test_step12_e2e.py",          "needs_user": True},
    {"num": 13, "phase": "Phase 4 · Deployment",         "name": "Summary Tokenizer",      "script": "test_step13_summaries.py",    "needs_user": True},
]

W = 60   # display width


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


def auto_user_id() -> str | None:
    """Return first user_id from ci.users, or None if unavailable."""
    try:
        import psycopg2
        db_url = os.environ.get("DATABASE_URL", "")
        if not db_url:
            return None
        conn = psycopg2.connect(db_url)
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM ci.users LIMIT 1")
            row = cur.fetchone()
        conn.close()
        return str(row[0]) if row else None
    except Exception:
        return None


def clean_models_dir(models_dir: str) -> None:
    hmt_dir = Path(models_dir) / "hmt"
    if hmt_dir.exists():
        shutil.rmtree(hmt_dir)
        print(f"  Cleaned: {hmt_dir}")
    l1_dir = Path(models_dir) / "l1"
    if l1_dir.exists():
        shutil.rmtree(l1_dir)
        print(f"  Cleaned: {l1_dir}")
    scaler = Path(models_dir) / "scalar_scaler.pkl"
    if scaler.exists():
        scaler.unlink()
        print(f"  Cleaned: {scaler}")


# ── Argument parsing ───────────────────────────────────────────────────────────

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
            opts["from_step"] = int(args[i + 1]); i += 1
        elif a in ("--to-step", "-t"):
            opts["to_step"] = int(args[i + 1]); i += 1
        elif not a.startswith("-"):
            opts["user_id"] = a
        i += 1

    return opts


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    opts       = parse_args()
    models_dir = os.environ.get("MODELS_DIR", "/tmp/hbpe_models")
    pythonpath = os.environ.get("PYTHONPATH", "src")
    scripts_dir = Path(__file__).parent

    # Resolve user_id
    user_id = opts["user_id"] or auto_user_id()

    banner(f"HBPE Pipeline  —  steps {opts['from_step']}–{opts['to_step']}")
    print(f"  User    : {user_id or '(no DB / step 1 only)'}")
    print(f"  Models  : {models_dir}")
    print(f"  Python  : {sys.executable}")

    if opts["clean"]:
        print("\n  --clean: wiping model checkpoints …")
        clean_models_dir(models_dir)

    # Filter steps
    steps_to_run = [s for s in STEPS
                    if opts["from_step"] <= s["num"] <= opts["to_step"]]

    if not steps_to_run:
        print("No steps selected.")
        sys.exit(0)

    # Validate: user_id required for most steps
    needs_user = any(s["needs_user"] for s in steps_to_run)
    if needs_user and not user_id:
        print("\nERROR: user_id required but not found.\n"
              "  Pass it as an argument or set DATABASE_URL so it can be auto-detected.")
        sys.exit(1)

    # ── Run steps ──────────────────────────────────────────────────────────────
    results: list[dict] = []
    current_phase: str = ""
    pipeline_start = time.perf_counter()

    for step in steps_to_run:
        if step["phase"] != current_phase:
            current_phase = step["phase"]
            phase_header(current_phase)

        step_header(step["num"], step["name"])

        cmd = [sys.executable, str(scripts_dir / step["script"])]
        if step["needs_user"] and user_id:
            cmd.append(user_id)

        env = {**os.environ, "PYTHONPATH": pythonpath, "MODELS_DIR": models_dir,
               "PYTHONUNBUFFERED": "1"}

        t0 = time.perf_counter()
        proc = subprocess.run(cmd, env=env)
        elapsed = time.perf_counter() - t0

        passed = proc.returncode == 0
        results.append({"step": step, "passed": passed, "elapsed": elapsed})

        mark = "✓" if passed else "✗"
        print(f"\n  {mark}  {fmt_time(elapsed)}")

        if not passed:
            print(f"\n  Step {step['num']} FAILED — aborting pipeline.")
            break

    # ── Summary ────────────────────────────────────────────────────────────────
    total_elapsed = time.perf_counter() - pipeline_start
    all_passed = all(r["passed"] for r in results)

    banner("Summary")
    col_name  = max(len(r["step"]["name"]) for r in results)
    col_phase = max(len(r["step"]["phase"]) for r in results)

    for r in results:
        s      = r["step"]
        mark   = "✓" if r["passed"] else "✗"
        timing = fmt_time(r["elapsed"])
        print(f"  {mark}  Step {s['num']:2d}  {s['name']:<{col_name}}  {timing:>7}")

    print(f"\n  Total: {fmt_time(total_elapsed)}")
    print()
    if all_passed:
        ran = len(results)
        skipped = 13 - ran
        suffix = f"  ({skipped} skipped)" if skipped else ""
        print(f"  ALL {ran} STEPS PASSED{suffix}")
    else:
        failed = [r for r in results if not r["passed"]]
        names  = ", ".join(f"step {r['step']['num']}" for r in failed)
        print(f"  FAILED: {names}")

    print(f"{'═' * W}\n")
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
