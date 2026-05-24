"""
Nightly Runner — Temporal workflow that orchestrates the nightly HBPE pipeline.

Job order (total budget: ~15 min):
  1. label_unlabeled      < 10 min  — run QwenLabeler on any events/content
                                       that arrived without labels.
  2. l1_stale_sweep       < 30 sec  — deactivate L1 clusters unused for 90 days.
  3. l2_stale_sweep       < 30 sec  — deactivate L2 clusters unused for 90 days.
  4. lora_fine_tune       <  5 min  — per-user LoRA adapter update.
  5. drift_detection              [Phase 5 stub]
  6. cache_invalidation           [Phase 5 stub]

Each step is a separate Temporal activity with fail-continue semantics:
one user's error does not block others.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

log = logging.getLogger(__name__)

_RETRY = RetryPolicy(maximum_attempts=2, backoff_coefficient=2.0)
_ACTIVITY_TIMEOUT = timedelta(minutes=5)
_SWEEP_TIMEOUT    = timedelta(seconds=60)   # single-row UPDATEs — 60s is plenty


# ── Step 1 — Label unlabeled events and content ────────────────────────────────


@activity.defn(name="label_unlabeled")
async def label_unlabeled(user_id: str) -> dict:
    """
    Step 1: Assign L0/L1 to any events and L0/L1/L2 to any content items
    that do not yet have a label in ci.l1_event_cluster / ci.l2_content_cluster.

    Uses QwenLabeler for all assignments.  New vocabulary entries trigger an
    HMT retrain flag (tracked in the return dict).
    """
    import asyncio

    def _run() -> dict:
        from ci.data_client import get_unlabeled_events, get_unlabeled_content
        from ci.tokenizer.qwen_labeler import QwenLabeler

        labeler = QwenLabeler()
        new_labels = 0
        labeled_events = 0
        labeled_content = 0
        errors = 0

        # ── Unlabeled events ─────────────────────────────────────────────────
        unlabeled_events = get_unlabeled_events(user_id)

        for row in unlabeled_events:
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
                log.exception("label_unlabeled event failed: event_id=%s", row["event_id"])
                errors += 1

        # ── Unlabeled content ────────────────────────────────────────────────
        unlabeled_content = get_unlabeled_content(user_id)

        for row in unlabeled_content:
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
                log.exception("label_unlabeled content failed: content_id=%s", row["content_id"])
                errors += 1

        return {
            "user_id": user_id,
            "labeled_events": labeled_events,
            "labeled_content": labeled_content,
            "new_labels": new_labels,
            "errors": errors,
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 1b — Label hourly summaries ──────────────────────────────────────────


@activity.defn(name="label_summary_tokens")
async def label_summary_tokens(user_id: str) -> dict:
    """
    Step 1b: Label yesterday's hourly summaries with L0+L1 via Qwen.

    Summary tokens fill 30-min buckets that have no event-derived coverage
    (sleep, leisure, off-calendar hours).  Labels are stored in
    ci.summary_l1_label and merged into the token stream at serialization time.
    """
    import asyncio
    import datetime

    def _run() -> dict:
        from ci.tokenizer.summary_tokenizer import SummaryTokenizer
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        n = SummaryTokenizer().label_day(user_id, yesterday.isoformat())
        return {"labeled": n, "date": yesterday.isoformat()}

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 2 — L1 staleness sweep ────────────────────────────────────────────────


@activity.defn(name="l1_stale_sweep")
async def l1_stale_sweep(user_id: str) -> int:
    """Step 2: Deactivate L1 clusters with no activity in staleness_days."""
    import asyncio

    def _run() -> int:
        from ci.tokenizer.l1_staleness import L1Staleness
        return L1Staleness().run(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 3 — L2 staleness sweep ────────────────────────────────────────────────


@activity.defn(name="l2_stale_sweep")
async def l2_stale_sweep(user_id: str) -> int:
    """Step 3: Deactivate L2 clusters with no activity in staleness_days."""
    import asyncio

    def _run() -> int:
        from ci.tokenizer.l2_staleness import L2Staleness
        return L2Staleness().run(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4 — LoRA fine-tune ────────────────────────────────────────────────────


@activity.defn(name="lora_fine_tune")
async def lora_fine_tune(user_id: str) -> dict:
    """
    Step 4: Fine-tune the per-user LoRA adapter on yesterday's token stream.

    Skipped gracefully if the base HMT checkpoint does not exist yet
    (cold-start: requires the full training pipeline to run first).
    """
    import asyncio
    import datetime

    def _run() -> dict:
        from pathlib import Path
        from ci.config import settings

        checkpoint = Path(settings.models_dir) / "hmt" / "hmt_checkpoint.pt"
        if not checkpoint.exists():
            log.info("lora_fine_tune: base checkpoint not found — skipping (cold start)")
            return {"skipped": True, "reason": "no_base_checkpoint"}

        from ci.model.nightly_finetune import fine_tune_nightly
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        return fine_tune_nightly(user_id, yesterday)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Phase 5 stubs ──────────────────────────────────────────────────────────────


@activity.defn(name="drift_detection")
async def drift_detection(user_id: str) -> str:
    log.info("drift_detection: stub — Phase 5 (user=%s)", user_id)
    return "skipped"


@activity.defn(name="cache_invalidation")
async def cache_invalidation(user_id: str) -> str:
    log.info("cache_invalidation: stub — Phase 5 (user=%s)", user_id)
    return "skipped"


# ── Workflow ───────────────────────────────────────────────────────────────────


@workflow.defn(name="NightlyHBPEWorkflow")
class NightlyHBPEWorkflow:
    """
    Temporal workflow: runs the nightly HBPE pipeline per user.

    Fail-continue semantics: each step is attempted independently.
    A step failure logs the error and does not block subsequent steps.
    """

    def __init__(self) -> None:
        self._step = "queued"

    @workflow.query
    def current_step(self) -> str:
        return self._step

    @workflow.run
    async def run(self, user_id: str) -> dict:
        results: dict = {"user_id": user_id, "steps": {}}

        # Step 1 — label unlabeled events/content
        self._step = "label"
        results["steps"]["step1_label"] = await _safe_execute(
            workflow.execute_activity(
                label_unlabeled, user_id,
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=_RETRY,
            ),
            "step1_label",
        )

        # Step 1b — label hourly summaries
        self._step = "label_summaries"
        results["steps"]["step1b_summaries"] = await _safe_execute(
            workflow.execute_activity(
                label_summary_tokens, user_id,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=_RETRY,
            ),
            "step1b_summaries",
        )

        # Step 2 — L1 staleness
        self._step = "l1_sweep"
        results["steps"]["step2_l1_stale"] = await _safe_execute(
            workflow.execute_activity(
                l1_stale_sweep, user_id,
                start_to_close_timeout=_SWEEP_TIMEOUT,
                retry_policy=_RETRY,
            ),
            "step2_l1_stale",
        )

        # Step 3 — L2 staleness
        self._step = "l2_sweep"
        results["steps"]["step3_l2_stale"] = await _safe_execute(
            workflow.execute_activity(
                l2_stale_sweep, user_id,
                start_to_close_timeout=_SWEEP_TIMEOUT,
                retry_policy=_RETRY,
            ),
            "step3_l2_stale",
        )

        # Step 4 — LoRA fine-tune
        self._step = "lora"
        results["steps"]["step4_lora"] = await _safe_execute(
            workflow.execute_activity(
                lora_fine_tune, user_id,
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RetryPolicy(maximum_attempts=1),
            ),
            "step4_lora",
        )

        # Step 5 — drift detection (stub)
        self._step = "drift"
        results["steps"]["step5_drift"] = await _safe_execute(
            workflow.execute_activity(
                drift_detection, user_id,
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=1),
            ),
            "step5_drift",
        )

        # Step 6 — cache invalidation (stub)
        self._step = "cache"
        results["steps"]["step6_cache"] = await _safe_execute(
            workflow.execute_activity(
                cache_invalidation, user_id,
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=1),
            ),
            "step6_cache",
        )

        self._step = "done"
        return results


async def _safe_execute(coro, step_name: str):
    """Await coro; on exception return error dict instead of raising."""
    try:
        return {"status": "ok", "result": await coro}
    except Exception as exc:
        log.exception("Nightly step %s failed", step_name)
        return {"status": "error", "error": str(exc)}
