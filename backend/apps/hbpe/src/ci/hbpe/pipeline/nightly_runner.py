"""
Nightly Runner — step functions for the nightly HBPE pipeline.

Job order (orchestrated by ci.hbpe.functions.nightly, dispatched from the
NestJS pg-boss scheduler through the function runner):
  1. label_unlabeled      long-running — run QwenLabeler on any events/content
                                         that arrived without labels. CPU-bound;
                                         a large backlog can drain over hours.
  2. l1_stale_sweep       < 30 sec    — deactivate L1 clusters unused for 90 days.
  3. l2_stale_sweep       < 30 sec    — deactivate L2 clusters unused for 90 days.
  4. lora_fine_tune       <  5 min    — per-user LoRA adapter update.
  4b. backfill_actuals    < 30 sec    — fill prediction_log.actual_* for elapsed
                                        forecast buckets from observed token_stream
                                        labels (Phase 5a / T5.1).
  4c. recurrence_profile  <  5 min    — rebuild hbpe.recurrence_profiles (week/
                                        month-horizon occurrence + due forecasts)
                                        and backfill occurrence_log actuals.
  5. drift_detection                  score prediction_log vs actuals (Brier/ECE)
  6. cache_invalidation               [Phase 5 stub]

Each step has fail-continue semantics in the orchestrator: one step's error
does not block subsequent steps.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def __getattr__(name: str):
    # Lazily re-export the Phase 5a backfill entry point so callers can reach it
    # via this module (``from ci.pipeline.nightly_runner import
    # backfill_prediction_actuals``) without importing psycopg2 at module load.
    if name == "backfill_prediction_actuals":
        from ci.hbpe.pipeline.actuals_backfill import backfill_prediction_actuals

        return backfill_prediction_actuals
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# On-device inference (Qwen via llama.cpp) runs on a single-worker executor so
# blocking label work never runs concurrently across users' nightly runs.
# Concurrent use of the shared llama.cpp context corrupts its KV cache and
# aborts the process (GGML_ASSERT). The executor is created lazily on first use
# (inside the async helper, on the event-loop thread) so importing this module
# never spawns threads.
_INFERENCE_EXECUTOR = None


async def _run_inference(fn):
    """
    Run a blocking inference function on the single-flight inference executor.

    ``fn(should_stop)`` receives a ``threading.Event`` it should poll between
    items. If the surrounding task is cancelled, we set the event so the
    abandoned thread stops at the next item boundary instead of zombie-running
    the rest of the batch — bounding wasted work and freeing the single
    executor slot.
    """
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    global _INFERENCE_EXECUTOR
    if _INFERENCE_EXECUTOR is None:
        _INFERENCE_EXECUTOR = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="hbpe-infer"
        )

    should_stop = threading.Event()
    loop = asyncio.get_event_loop()
    fut = loop.run_in_executor(_INFERENCE_EXECUTOR, fn, should_stop)
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        should_stop.set()
        raise


# ── Step 1 — Label unlabeled events and content ────────────────────────────────


async def label_unlabeled(user_id: str) -> dict:
    """
    Step 1: Assign L0/L1 to any events and L0/L1/L2 to any content items
    that do not yet have a label in ci.l1_event_cluster / ci.l2_content_cluster.

    Uses QwenLabeler for all assignments.  New vocabulary entries trigger an
    HMT retrain flag (tracked in the return dict).
    """

    def _run(should_stop) -> dict:
        from ci.hbpe.data_client import get_unlabeled_content, get_unlabeled_events
        from ci.hbpe.functions import update_pipeline_progress
        from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler

        labeler = QwenLabeler()
        new_labels = 0
        labeled_events = 0
        labeled_content = 0
        errors = 0

        # ── Unlabeled events ─────────────────────────────────────────────────
        unlabeled_events = get_unlabeled_events(user_id)
        unlabeled_content = get_unlabeled_content(user_id)
        total = len(unlabeled_events) + len(unlabeled_content)
        done = 0
        update_pipeline_progress(
            user_id, done=0, total=max(total, 1), detail=f"0 of {total}"
        )

        for row in unlabeled_events:
            if should_stop.is_set():
                break
            try:
                result = labeler.label_event(
                    event_id=row["event_id"],
                    user_id=user_id,
                    title=row.get("title") or "",
                    description=row.get("description"),
                )
                labeled_events += 1
                if result.get("is_new_l1"):
                    new_labels += 1
            except Exception:
                log.exception(
                    "label_unlabeled event failed: event_id=%s", row["event_id"]
                )
                errors += 1
            done += 1
            if done == 1 or done % 10 == 0 or done == total:
                update_pipeline_progress(user_id, done=done, total=max(total, 1))

        for row in unlabeled_content:
            if should_stop.is_set():
                break
            try:
                result = labeler.label_content(
                    content_id=row["content_id"],
                    user_id=user_id,
                    title=row.get("title") or "",
                    content_type=row.get("content_type"),
                )
                labeled_content += 1
                if result.get("is_new_l1") or result.get("is_new_l2"):
                    new_labels += 1
            except Exception:
                log.exception(
                    "label_unlabeled content failed: content_id=%s", row["content_id"]
                )
                errors += 1
            done += 1
            if done == 1 or done % 10 == 0 or done == total:
                update_pipeline_progress(user_id, done=done, total=max(total, 1))

        return {
            "user_id": user_id,
            "labeled_events": labeled_events,
            "labeled_content": labeled_content,
            "new_labels": new_labels,
            "errors": errors,
        }

    return await _run_inference(_run)


# ── Step 1b — Label hourly summaries ──────────────────────────────────────────


async def label_summary_tokens(user_id: str) -> dict:
    """
    Step 1b: Label yesterday's hourly summaries with L0+L1 via Qwen.

    Summary tokens fill 30-min buckets that have no event-derived coverage
    (sleep, leisure, off-calendar hours).  Labels are stored in
    ci.summary_l1_label and merged into the token stream at serialization time.
    """
    import datetime

    def _run(should_stop) -> dict:
        from ci.hbpe.tokenizer.summary_tokenizer import SummaryTokenizer

        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        n = SummaryTokenizer().label_day(user_id, yesterday.isoformat())
        return {"labeled": n, "date": yesterday.isoformat()}

    return await _run_inference(_run)


# ── Step 2 — L1 staleness sweep ────────────────────────────────────────────────


async def l1_stale_sweep(user_id: str) -> int:
    """Step 2: Deactivate L1 clusters with no activity in staleness_days."""
    import asyncio

    def _run() -> int:
        from ci.hbpe.tokenizer.l1_staleness import L1Staleness

        return L1Staleness().run(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 3 — L2 staleness sweep ────────────────────────────────────────────────


async def l2_stale_sweep(user_id: str) -> int:
    """Step 3: Deactivate L2 clusters with no activity in staleness_days."""
    import asyncio

    def _run() -> int:
        from ci.hbpe.tokenizer.l2_staleness import L2Staleness

        return L2Staleness().run(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4 — LoRA fine-tune ────────────────────────────────────────────────────


async def lora_fine_tune(user_id: str) -> dict:
    """
    Step 4: Fine-tune the per-user LoRA adapter on yesterday's token stream.

    Skipped gracefully if the base HMT checkpoint does not exist yet
    (cold-start: requires the full training pipeline to run first).
    """
    import asyncio
    import datetime

    def _run() -> dict:
        from ci.hbpe.model.checkpoints import HMT_CKPT, user_ckpt_dir

        checkpoint = user_ckpt_dir(user_id) / HMT_CKPT
        if not checkpoint.exists():
            log.info(
                "lora_fine_tune: base checkpoint not found — skipping (cold start)"
            )
            return {"skipped": True, "reason": "no_base_checkpoint"}

        from ci.hbpe.model.nightly_finetune import fine_tune_nightly

        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        return fine_tune_nightly(user_id, yesterday)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def needs_bootstrap(user_id: str) -> dict:
    """
    Decide whether the user needs a (re)bootstrap before LoRA fine-tune.

    Returns {"needs": bool, "reason": str}. Needs is True when the user has no
    per-user HMT checkpoint (cold start), when the checkpoint was trained with
    a different HMT shape (64-d toy → 256-d), or when their current L1 vocabulary
    has drifted away from the one their checkpoint was trained with (so a freshly
    built model would no longer load the saved weights — the size-mismatch that
    motivated CI-Server-ad4).
    """
    import asyncio

    def _run() -> dict:
        import torch

        from ci.hbpe.model.checkpoints import (
            HMT_CALIBRATED,
            HMT_CKPT,
            architecture_fingerprint,
            architecture_matches,
            l1_vocab_fingerprint,
            model_exists,
            user_ckpt_dir,
        )
        from ci.hbpe.model.vocab import build_l1_vocab

        if not model_exists(user_id):
            return {"needs": True, "reason": "no_checkpoint"}

        if not architecture_matches(user_id):
            return {"needs": True, "reason": "architecture_mismatch"}

        d = user_ckpt_dir(user_id)
        ckpt_path = (
            d / HMT_CALIBRATED if (d / HMT_CALIBRATED).exists() else d / HMT_CKPT
        )
        try:
            ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        except Exception:
            return {"needs": True, "reason": "checkpoint_unreadable"}

        stored_arch = ckpt.get("architecture")
        if stored_arch and stored_arch != architecture_fingerprint():
            return {"needs": True, "reason": "architecture_mismatch"}

        stored = ckpt.get("l1_vocab_fingerprint")
        current = l1_vocab_fingerprint(build_l1_vocab(user_id))
        if stored != current:
            return {"needs": True, "reason": "vocab_drift"}
        return {"needs": False, "reason": "up_to_date"}

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4b — Backfill prediction actuals (Phase 5a / T5.1) ─────────────────────


async def backfill_actuals(user_id: str) -> dict:
    """
    Step 4b: Fill hbpe.prediction_log.actual_l0/l1/l2 for elapsed forecast
    buckets from the observed hbpe.token_stream labels of the day that has
    since passed.

    Enables retrospective accuracy measurement (§6 success metric: ≥95% of
    buckets whose window has elapsed are backfilled). Idempotent — only rewrites
    rows whose observed labels changed.
    """
    import asyncio

    def _run() -> dict:
        from ci.hbpe.pipeline.actuals_backfill import backfill_prediction_actuals

        return backfill_prediction_actuals(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4c — Recurrence profiles (week/month-horizon forecasts) ───────────────


async def recurrence_profile(user_id: str) -> dict:
    """
    Step 4c: Rebuild hbpe.recurrence_profiles from token_stream history
    (per-L1-cluster DoW/daypart histograms, inter-arrival stats, periodicity
    confidence), then backfill hbpe.occurrence_log.actual for elapsed
    week-forecast days. Backs GET /forecast and GET /forecast/due.
    """
    import asyncio

    def _run() -> dict:
        from ci.hbpe.pipeline.recurrence import (
            backfill_occurrence_actuals,
            build_recurrence_profiles,
        )

        result = build_recurrence_profiles(user_id)
        result["occurrence_actuals"] = backfill_occurrence_actuals(user_id)["updated"]
        return result

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Phase 5 stubs ──────────────────────────────────────────────────────────────


async def drift_detection(user_id: str) -> str:
    import asyncio

    from ci.hbpe.pipeline.baselines import score_baselines_and_store
    from ci.hbpe.pipeline.l2_gate import count_l2_tokens
    from ci.hbpe.pipeline.scoring import score_and_store

    result = await asyncio.get_event_loop().run_in_executor(
        None, lambda: score_and_store(user_id)
    )
    status = str(result.get("status", "scored"))
    log.info("drift_detection: %s (user=%s)", status, user_id)

    base = await asyncio.get_event_loop().run_in_executor(
        None, lambda: score_baselines_and_store(user_id)
    )
    log.info("drift_detection baselines: %s (user=%s)", base.get("status"), user_id)

    n_l2 = await asyncio.get_event_loop().run_in_executor(
        None, lambda: count_l2_tokens(user_id)
    )
    log.info("L2 token count user=%s n=%d", user_id[:8], n_l2)

    return status


async def cache_invalidation(user_id: str) -> str:
    log.info("cache_invalidation: stub — Phase 5 (user=%s)", user_id)
    return "skipped"
