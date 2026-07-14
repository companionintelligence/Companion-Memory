"""
Nightly Runner — Temporal workflow that orchestrates the nightly HBPE pipeline.

Job order:
  1. label_unlabeled      long-running — run QwenLabeler on any events/content
                                         that arrived without labels. CPU-bound;
                                         relies on heartbeats, not a wall-clock
                                         timeout, so a large backlog can drain
                                         over hours without being cancelled.
  2. l1_stale_sweep       < 30 sec    — deactivate L1 clusters unused for 90 days.
  3. l2_stale_sweep       < 30 sec    — deactivate L2 clusters unused for 90 days.
  4. lora_fine_tune       <  5 min    — per-user LoRA adapter update.
  4b. backfill_actuals    < 30 sec    — fill prediction_log.actual_* for elapsed
                                        forecast buckets from observed token_stream
                                        labels (Phase 5a / T5.1).
  5. drift_detection                  [Phase 5 stub]
  6. cache_invalidation               [Phase 5 stub]

Each step is a separate Temporal activity with fail-continue semantics:
one user's error does not block others.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

log = logging.getLogger(__name__)


def __getattr__(name: str):
    # Lazily re-export the Phase 5a backfill entry point so callers can reach it
    # via this module (``from ci.pipeline.nightly_runner import
    # backfill_prediction_actuals``) without importing psycopg2 at module load —
    # keeping the Temporal workflow-sandbox reimport of this file DB-free, as the
    # other activities do with their in-body imports.
    if name == "backfill_prediction_actuals":
        from ci.pipeline.actuals_backfill import backfill_prediction_actuals
        return backfill_prediction_actuals
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

_RETRY = RetryPolicy(maximum_attempts=2, backoff_coefficient=2.0)
_ACTIVITY_TIMEOUT = timedelta(minutes=5)
_SWEEP_TIMEOUT    = timedelta(seconds=60)   # single-row UPDATEs — 60s is plenty

# CPU-only labeling of a large backlog is intentionally long-running, so the
# label activities use an effectively-unbounded start_to_close and rely on
# heartbeats for liveness: _run_inference heartbeats every ~30s from the
# activity context, so a stuck/dead worker is detected within _HEARTBEAT_TIMEOUT
# while a legitimately long run is never cancelled mid-batch.
_LABEL_TIMEOUT     = timedelta(hours=24)
_HEARTBEAT_TIMEOUT = timedelta(minutes=2)

# (Re)bootstrap steps are CPU-bound with no heartbeat — generous ceilings so a
# full retrain on drift is never cancelled prematurely (matches BootstrapHBPEWorkflow).
_SERIALIZE_TIMEOUT = timedelta(hours=1)
_TRAIN_TIMEOUT     = timedelta(hours=6)
_EXPORT_TIMEOUT    = timedelta(hours=1)
_LORA_TIMEOUT      = timedelta(hours=1)

# On-device inference (Qwen via llama.cpp) runs on a single-worker executor so
# blocking label work never runs concurrently — neither across users' nightly
# workflows nor when a timed-out attempt's thread is still draining as Temporal
# starts a retry. Concurrent use of the shared llama.cpp context corrupts its KV
# cache and aborts the process (GGML_ASSERT). The executor is created lazily on
# first use (inside the async helper, on the event-loop thread) so the workflow
# sandbox — which re-imports this module — never spawns threads at import time.
_INFERENCE_EXECUTOR = None


async def _run_inference(fn, heartbeat_interval: float = 30.0):
    """
    Run a blocking inference function on the single-flight inference executor.

    ``fn(should_stop)`` receives a ``threading.Event`` it should poll between
    items. If the activity is cancelled (e.g. its heartbeat timed out or the
    workflow was cancelled), we set the event so the abandoned thread stops at
    the next item boundary instead of zombie-running the rest of the batch —
    bounding wasted work and freeing the single executor slot for the retry.

    While the blocking work runs, we heartbeat from the activity context (this
    event-loop coroutine, never the worker thread) every ``heartbeat_interval``
    seconds, keeping a long CPU-bound run alive under its heartbeat_timeout.
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
        while True:
            try:
                # shield: a heartbeat-interval timeout must not cancel the work.
                return await asyncio.wait_for(
                    asyncio.shield(fut), timeout=heartbeat_interval
                )
            except asyncio.TimeoutError:
                try:
                    activity.heartbeat()
                except Exception:
                    # Not inside a Temporal activity (e.g. unit tests) — ignore.
                    pass
    except asyncio.CancelledError:
        should_stop.set()
        raise


# ── Step 1 — Label unlabeled events and content ────────────────────────────────


@activity.defn(name="label_unlabeled")
async def label_unlabeled(user_id: str) -> dict:
    """
    Step 1: Assign L0/L1 to any events and L0/L1/L2 to any content items
    that do not yet have a label in ci.l1_event_cluster / ci.l2_content_cluster.

    Uses QwenLabeler for all assignments.  New vocabulary entries trigger an
    HMT retrain flag (tracked in the return dict).
    """
    def _run(should_stop) -> dict:
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
                log.exception("label_unlabeled event failed: event_id=%s", row["event_id"])
                errors += 1

        # ── Unlabeled content ────────────────────────────────────────────────
        unlabeled_content = get_unlabeled_content(user_id)

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
                log.exception("label_unlabeled content failed: content_id=%s", row["content_id"])
                errors += 1

        return {
            "user_id": user_id,
            "labeled_events": labeled_events,
            "labeled_content": labeled_content,
            "new_labels": new_labels,
            "errors": errors,
        }

    return await _run_inference(_run)


# ── Step 1b — Label hourly summaries ──────────────────────────────────────────


@activity.defn(name="label_summary_tokens")
async def label_summary_tokens(user_id: str) -> dict:
    """
    Step 1b: Label yesterday's hourly summaries with L0+L1 via Qwen.

    Summary tokens fill 30-min buckets that have no event-derived coverage
    (sleep, leisure, off-calendar hours).  Labels are stored in
    ci.summary_l1_label and merged into the token stream at serialization time.
    """
    import datetime

    def _run(should_stop) -> dict:
        from ci.tokenizer.summary_tokenizer import SummaryTokenizer
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        n = SummaryTokenizer().label_day(user_id, yesterday.isoformat())
        return {"labeled": n, "date": yesterday.isoformat()}

    return await _run_inference(_run)


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
        from ci.model.checkpoints import user_ckpt_dir, HMT_CKPT

        checkpoint = user_ckpt_dir(user_id) / HMT_CKPT
        if not checkpoint.exists():
            log.info("lora_fine_tune: base checkpoint not found — skipping (cold start)")
            return {"skipped": True, "reason": "no_base_checkpoint"}

        from ci.model.nightly_finetune import fine_tune_nightly
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        return fine_tune_nightly(user_id, yesterday)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


@activity.defn(name="needs_bootstrap")
async def needs_bootstrap(user_id: str) -> dict:
    """
    Decide whether the user needs a (re)bootstrap before LoRA fine-tune.

    Returns {"needs": bool, "reason": str}. Needs is True when the user has no
    per-user HMT checkpoint (cold start) or when their current L1 vocabulary has
    drifted away from the one their checkpoint was trained with (so a freshly
    built model would no longer load the saved weights — the size-mismatch that
    motivated CI-Server-ad4).
    """
    import asyncio

    def _run() -> dict:
        import torch
        from ci.model.checkpoints import (
            user_ckpt_dir, model_exists, l1_vocab_fingerprint,
            HMT_CALIBRATED, HMT_CKPT,
        )
        from ci.model.vocab import build_l1_vocab

        if not model_exists(user_id):
            return {"needs": True, "reason": "no_checkpoint"}

        d = user_ckpt_dir(user_id)
        ckpt_path = d / HMT_CALIBRATED if (d / HMT_CALIBRATED).exists() else d / HMT_CKPT
        try:
            ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        except Exception:
            return {"needs": True, "reason": "checkpoint_unreadable"}

        stored = ckpt.get("l1_vocab_fingerprint")
        current = l1_vocab_fingerprint(build_l1_vocab(user_id))
        if stored != current:
            return {"needs": True, "reason": "vocab_drift"}
        return {"needs": False, "reason": "up_to_date"}

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4b — Backfill prediction actuals (Phase 5a / T5.1) ─────────────────────


@activity.defn(name="backfill_actuals")
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
        from ci.pipeline.actuals_backfill import backfill_prediction_actuals
        return backfill_prediction_actuals(user_id)

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
                start_to_close_timeout=_LABEL_TIMEOUT,
                heartbeat_timeout=_HEARTBEAT_TIMEOUT,
                retry_policy=_RETRY,
            ),
            "step1_label",
        )

        # Step 1b — label hourly summaries
        self._step = "label_summaries"
        results["steps"]["step1b_summaries"] = await _safe_execute(
            workflow.execute_activity(
                label_summary_tokens, user_id,
                start_to_close_timeout=_LABEL_TIMEOUT,
                heartbeat_timeout=_HEARTBEAT_TIMEOUT,
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

        # Step 3b — (re)bootstrap the per-user HMT model when it is missing or its
        # L1 vocab has drifted from the saved checkpoint. Without a checkpoint
        # matching the current vocab, lora_fine_tune can't load the model (the
        # size mismatch behind CI-Server-ad4). These activities are shared with
        # BootstrapHBPEWorkflow and called by name to avoid importing that module.
        self._step = "bootstrap_check"
        boot_check = await _safe_execute(
            workflow.execute_activity(
                needs_bootstrap, user_id,
                start_to_close_timeout=_SWEEP_TIMEOUT,
                retry_policy=_RETRY,
            ),
            "bootstrap_check",
        )
        results["steps"]["bootstrap_check"] = boot_check

        if boot_check.get("result", {}).get("needs"):
            self._step = "serialize"
            results["steps"]["serialize"] = await _safe_execute(
                workflow.execute_activity(
                    "serialize_token_stream", user_id,
                    start_to_close_timeout=_SERIALIZE_TIMEOUT,
                    retry_policy=RetryPolicy(maximum_attempts=1),
                ),
                "serialize",
            )

            self._step = "train"
            results["steps"]["train"] = await _safe_execute(
                workflow.execute_activity(
                    "train_hmt_model", user_id,
                    start_to_close_timeout=_TRAIN_TIMEOUT,
                    retry_policy=RetryPolicy(maximum_attempts=1),
                ),
                "train",
            )

            self._step = "export"
            results["steps"]["export"] = await _safe_execute(
                workflow.execute_activity(
                    "calibrate_and_export_onnx", user_id,
                    start_to_close_timeout=_EXPORT_TIMEOUT,
                    retry_policy=RetryPolicy(maximum_attempts=1),
                ),
                "export",
            )

        # Step 4 — LoRA fine-tune
        self._step = "lora"
        results["steps"]["step4_lora"] = await _safe_execute(
            workflow.execute_activity(
                lora_fine_tune, user_id,
                start_to_close_timeout=_LORA_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=1),
            ),
            "step4_lora",
        )

        # Step 4b — backfill prediction_log actuals for elapsed forecast windows
        self._step = "backfill_actuals"
        results["steps"]["step4b_backfill_actuals"] = await _safe_execute(
            workflow.execute_activity(
                backfill_actuals, user_id,
                start_to_close_timeout=_SWEEP_TIMEOUT,
                retry_policy=_RETRY,
            ),
            "step4b_backfill_actuals",
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
