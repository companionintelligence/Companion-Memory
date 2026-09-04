"""
Named background functions for the HBPE service.

The former NightlyHBPEWorkflow / BootstrapHBPEWorkflow orchestrations as plain
async functions, scheduled by the NestJS pg-boss crons and dispatched through
``POST /functions/run`` (see runner.py). Steps keep their fail-continue
semantics: one step's error is recorded and does not block the rest.

``CURRENT_STEPS`` replaces the Temporal ``current_step`` workflow query: the
API's forecast status endpoint reads it to show real progress (e.g.
``BOOTSTRAP:train``) while a pipeline is running.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable
from typing import Any

log = logging.getLogger(__name__)

# user_id → "NIGHTLY:<step>" | "BOOTSTRAP:<step>" while a pipeline runs.
CURRENT_STEPS: dict[str, str] = {}
# user_id → {step, eta_seconds, detail, started_at, ...} while a pipeline runs.
CURRENT_PROGRESS: dict[str, dict[str, Any]] = {}

# Conservative wall-clock guesses. Labeling hundreds of items through the 8B
# chat endpoint, then training a 256-d HMT on CPU, is why Predict can take ~an
# hour. The Forecast strip refines these from item/epoch rate once work starts.
STEP_ETA_SECONDS: dict[str, int] = {
    "queued": 30,
    "label": 3600,
    "label_summaries": 180,
    "l1_sweep": 45,
    "l2_sweep": 45,
    "bootstrap_check": 20,
    "serialize": 180,
    "train": 2700,
    "export": 300,
    "lora": 240,
    "backfill_actuals": 90,
    "recurrence": 90,
    "drift": 45,
    "cache": 20,
}


def set_pipeline_step(user_id: str, qualified: str) -> None:
    """Record the live step (e.g. ``NIGHTLY:train``) and a conservative ETA."""
    CURRENT_STEPS[user_id] = qualified
    name = qualified.split(":", 1)[-1]
    now = time.time()
    CURRENT_PROGRESS[user_id] = {
        "step": qualified,
        "started_at": now,
        "updated_at": now,
        "eta_seconds": STEP_ETA_SECONDS.get(name, 120),
        "detail": None,
        "done": None,
        "total": None,
    }


def update_pipeline_progress(
    user_id: str,
    *,
    done: int,
    total: int,
    detail: str | None = None,
) -> None:
    """Refine ETA from observed rate. Safe to call from a worker thread."""
    meta = CURRENT_PROGRESS.get(user_id)
    if not meta:
        return
    now = time.time()
    elapsed = max(now - float(meta.get("started_at") or now), 1e-6)
    remaining = max(int(total) - int(done), 0)
    if done > 0:
        rate = done / elapsed
        eta = int(remaining / rate) if rate > 0 else int(meta.get("eta_seconds") or 120)
        eta = min(max(eta, 5), 7200)
    else:
        eta = int(meta.get("eta_seconds") or 120)
    meta["done"] = int(done)
    meta["total"] = int(total)
    meta["eta_seconds"] = 5 if remaining == 0 else eta
    meta["updated_at"] = now
    meta["detail"] = detail or (f"{done} of {total}" if total else None)


def clear_pipeline(user_id: str) -> None:
    CURRENT_STEPS.pop(user_id, None)
    CURRENT_PROGRESS.pop(user_id, None)


def pipeline_progress(user_id: str | None) -> dict[str, Any] | None:
    if not user_id:
        return None
    meta = CURRENT_PROGRESS.get(user_id)
    return dict(meta) if meta else None


async def _safe(coro: Awaitable, step_name: str) -> dict:
    """Await coro; on exception return an error dict instead of raising."""
    try:
        return {"status": "ok", "result": await coro}
    except Exception as exc:
        log.exception("Pipeline step %s failed", step_name)
        return {"status": "error", "error": str(exc)}


async def nightly(
    user_id: str,
    summary_start_date: str | None = None,
    summary_end_date: str | None = None,
    **_: Any,
) -> dict:
    """
    Nightly incremental pipeline: label new data, sweep stale clusters,
    (re)bootstrap on vocab drift, LoRA fine-tune, backfill actuals, rebuild
    recurrence profiles.
    """
    from ci.hbpe.pipeline.bootstrap import (
        calibrate_and_export_onnx,
        serialize_token_stream,
        train_hmt_model,
    )
    from ci.hbpe.pipeline.nightly_runner import (
        backfill_actuals,
        cache_invalidation,
        drift_detection,
        l1_stale_sweep,
        l2_stale_sweep,
        label_summary_tokens,
        label_unlabeled,
        lora_fine_tune,
        needs_bootstrap,
        recurrence_profile,
    )

    results: dict = {"user_id": user_id, "steps": {}, "workflow": "nightly"}

    def step(name: str) -> None:
        set_pipeline_step(user_id, f"NIGHTLY:{name}")

    try:
        step("label")
        results["steps"]["step1_label"] = await _safe(
            label_unlabeled(user_id), "step1_label"
        )

        step("label_summaries")
        summary_label_args = {}
        if summary_start_date is not None or summary_end_date is not None:
            summary_label_args = {
                "start_date": summary_start_date,
                "end_date": summary_end_date,
            }
        results["steps"]["step1b_summaries"] = await _safe(
            label_summary_tokens(user_id, **summary_label_args), "step1b_summaries"
        )

        step("l1_sweep")
        results["steps"]["step2_l1_stale"] = await _safe(
            l1_stale_sweep(user_id), "step2_l1_stale"
        )

        step("l2_sweep")
        results["steps"]["step3_l2_stale"] = await _safe(
            l2_stale_sweep(user_id), "step3_l2_stale"
        )

        # Publish whatever step 1 just labeled into hbpe.token_stream. This runs
        # UNCONDITIONALLY, before the bootstrap branch below and before the
        # recurrence rebuild that reads the table.
        #
        # It used to sit inside `if needs_bootstrap`, which broke the only path
        # a new label has to a forecast: label_unlabeled writes
        # hbpe.l1_event_cluster, and serialize is the sole writer of
        # hbpe.token_stream (ingester._reserialise covers today alone), which is
        # in turn the only thing build_recurrence_profiles reads. On an
        # established appliance — valid checkpoint, no vocab drift, so
        # needs_bootstrap returns False — a whole night of labeling therefore
        # landed nowhere and /forecast kept returning clusters:[]. That is
        # exactly the state a backlog drain leaves behind: the labels are new,
        # the L1 vocabulary is not.
        #
        # The cost is bounded and idempotent: serialize_token_stream walks
        # bootstrap.token_source_days, which is at most SERIALIZE_WINDOW_DAYS + 1
        # days however far back the corpus reaches, and serialize_day deletes and
        # rewrites one (user, date) at a time, so re-running it over an unchanged
        # corpus is a no-op with the same row count.
        step("serialize")
        results["steps"]["serialize"] = await _safe(
            serialize_token_stream(user_id), "serialize"
        )

        # (Re)bootstrap the per-user HMT model when it is missing or its L1
        # vocab has drifted from the saved checkpoint. Without a checkpoint
        # matching the current vocab, lora_fine_tune can't load the model (the
        # size mismatch behind CI-Server-ad4).
        step("bootstrap_check")
        boot_check = await _safe(needs_bootstrap(user_id), "bootstrap_check")
        results["steps"]["bootstrap_check"] = boot_check

        if boot_check.get("result", {}).get("needs"):
            step("train")
            results["steps"]["train"] = await _safe(train_hmt_model(user_id), "train")

            step("export")
            results["steps"]["export"] = await _safe(
                calibrate_and_export_onnx(user_id), "export"
            )

        step("lora")
        results["steps"]["step4_lora"] = await _safe(
            lora_fine_tune(user_id), "step4_lora"
        )

        step("backfill_actuals")
        results["steps"]["step4b_backfill_actuals"] = await _safe(
            backfill_actuals(user_id), "step4b_backfill_actuals"
        )

        step("recurrence")
        results["steps"]["step4c_recurrence"] = await _safe(
            recurrence_profile(user_id), "step4c_recurrence"
        )

        step("drift")
        results["steps"]["step5_drift"] = await _safe(
            drift_detection(user_id), "step5_drift"
        )

        step("cache")
        results["steps"]["step6_cache"] = await _safe(
            cache_invalidation(user_id), "step6_cache"
        )
    finally:
        clear_pipeline(user_id)

    return results


async def bootstrap(
    user_id: str,
    summary_start_date: str | None = None,
    summary_end_date: str | None = None,
    **_: Any,
) -> dict:
    """
    Full cold-start pipeline: label everything, serialize the token stream,
    train the HMT model, calibrate/export ONNX, initial LoRA fine-tune.
    Fail-fast on training/export; labeling steps use fail-continue.
    """
    from ci.hbpe.pipeline.bootstrap import (
        calibrate_and_export_onnx,
        serialize_token_stream,
        train_hmt_model,
    )
    from ci.hbpe.pipeline.nightly_runner import (
        label_summary_tokens,
        label_unlabeled,
        lora_fine_tune,
    )

    results: dict = {"user_id": user_id, "steps": {}, "workflow": "bootstrap"}

    def step(name: str) -> None:
        set_pipeline_step(user_id, f"BOOTSTRAP:{name}")

    try:
        step("label")
        results["steps"]["label"] = await _safe(label_unlabeled(user_id), "label")

        step("label_summaries")
        summary_label_args = {}
        if summary_start_date is not None or summary_end_date is not None:
            summary_label_args = {
                "start_date": summary_start_date,
                "end_date": summary_end_date,
            }
        results["steps"]["label_summaries"] = await _safe(
            label_summary_tokens(user_id, **summary_label_args), "label_summaries"
        )

        step("serialize")
        results["steps"]["serialize"] = await _safe(
            serialize_token_stream(user_id), "serialize"
        )

        # Abort if no token data to train on
        ser = results["steps"]["serialize"]
        if ser.get("status") == "error" or ser.get("result", {}).get("rows", -1) == 0:
            results["aborted"] = True
            results["abort_reason"] = "no_token_data"
            return results

        step("train")
        results["steps"]["train"] = await _safe(train_hmt_model(user_id), "train")

        train = results["steps"]["train"]
        if train.get("status") == "error":
            return results
        if train.get("result", {}).get("skipped"):
            results["aborted"] = True
            results["abort_reason"] = "no_training_data"
            return results

        step("export")
        results["steps"]["export"] = await _safe(
            calibrate_and_export_onnx(user_id), "export"
        )

        step("lora")
        results["steps"]["lora"] = await _safe(lora_fine_tune(user_id), "lora")
    finally:
        clear_pipeline(user_id)

    return results


async def ensure_bootstrap(user_id: str, **_: Any) -> dict:
    """
    Run bootstrap only when the user has no matching HMT checkpoint.

    The daily scheduler sweep calls this for every user, so the warm-path must
    stay cheap: an architecture.json stamp matching this binary is enough to
    skip. A leftover 64-d toy checkpoint (no stamp, or a mismatched stamp)
    retrains via nightly so Predict/Hub restart actually picks up the new HMT.
    """
    from ci.hbpe.model.checkpoints import architecture_matches, model_exists

    if user_id in CURRENT_STEPS:
        return {"skipped": True, "reason": "pipeline_running", "user_id": user_id}

    if model_exists(user_id) and architecture_matches(user_id):
        return {"skipped": True, "reason": "checkpoint_exists", "user_id": user_id}

    if model_exists(user_id):
        log.info(
            "ensure_bootstrap: architecture mismatch for %s — running nightly retrain",
            user_id[:8],
        )
        return await nightly(user_id)

    return await bootstrap(user_id)


# Registry — the only names the function runner will execute. Must stay in
# sync with PYTHON_FUNCTIONS.hbpe in the NestJS python-functions domain.
FUNCTIONS = {
    "nightly": nightly,
    "bootstrap": bootstrap,
    "ensure_bootstrap": ensure_bootstrap,
}

__all__ = [
    "CURRENT_PROGRESS",
    "CURRENT_STEPS",
    "FUNCTIONS",
    "bootstrap",
    "clear_pipeline",
    "ensure_bootstrap",
    "nightly",
    "pipeline_progress",
    "set_pipeline_step",
    "update_pipeline_progress",
]
