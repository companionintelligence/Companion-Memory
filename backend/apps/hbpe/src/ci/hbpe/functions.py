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
from collections.abc import Awaitable
from typing import Any

log = logging.getLogger(__name__)

# user_id → "NIGHTLY:<step>" | "BOOTSTRAP:<step>" while a pipeline runs.
CURRENT_STEPS: dict[str, str] = {}


async def _safe(coro: Awaitable, step_name: str) -> dict:
    """Await coro; on exception return an error dict instead of raising."""
    try:
        return {"status": "ok", "result": await coro}
    except Exception as exc:
        log.exception("Pipeline step %s failed", step_name)
        return {"status": "error", "error": str(exc)}


def _model_exists(user_id: str) -> bool:
    from ci.hbpe.model.checkpoints import model_exists

    return model_exists(user_id)


async def nightly(user_id: str, **_: Any) -> dict:
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
        reserialize_token_stream,
    )

    results: dict = {"user_id": user_id, "steps": {}, "workflow": "nightly"}

    def step(name: str) -> None:
        CURRENT_STEPS[user_id] = f"NIGHTLY:{name}"

    try:
        step("label")
        results["steps"]["step1_label"] = await _safe(
            label_unlabeled(user_id), "step1_label"
        )

        step("label_summaries")
        results["steps"]["step1b_summaries"] = await _safe(
            label_summary_tokens(user_id), "step1b_summaries"
        )

        step("reserialize")
        results["steps"]["step1c_reserialize"] = await _safe(
            reserialize_token_stream(user_id), "step1c_reserialize"
        )

        step("l1_sweep")
        results["steps"]["step2_l1_stale"] = await _safe(
            l1_stale_sweep(user_id), "step2_l1_stale"
        )

        step("l2_sweep")
        results["steps"]["step3_l2_stale"] = await _safe(
            l2_stale_sweep(user_id), "step3_l2_stale"
        )

        # (Re)bootstrap the per-user HMT model when it is missing or its L1
        # vocab has drifted from the saved checkpoint. Without a checkpoint
        # matching the current vocab, lora_fine_tune can't load the model (the
        # size mismatch behind CI-Server-ad4).
        step("bootstrap_check")
        boot_check = await _safe(needs_bootstrap(user_id), "bootstrap_check")
        results["steps"]["bootstrap_check"] = boot_check

        if boot_check.get("result", {}).get("needs"):
            step("serialize")
            results["steps"]["serialize"] = await _safe(
                serialize_token_stream(user_id), "serialize"
            )

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
        CURRENT_STEPS.pop(user_id, None)

    return results


async def bootstrap(user_id: str, **_: Any) -> dict:
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
        CURRENT_STEPS[user_id] = f"BOOTSTRAP:{name}"

    try:
        step("label")
        results["steps"]["label"] = await _safe(label_unlabeled(user_id), "label")

        step("label_summaries")
        results["steps"]["label_summaries"] = await _safe(
            label_summary_tokens(user_id), "label_summaries"
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
        CURRENT_STEPS.pop(user_id, None)

    return results


async def ensure_bootstrap(user_id: str, **_: Any) -> dict:
    """
    Run bootstrap only when the user has no HMT checkpoint yet. The daily
    scheduler sweep calls this for every user, so the warm-path must be cheap.
    """
    if _model_exists(user_id):
        return {"skipped": True, "reason": "checkpoint_exists", "user_id": user_id}

    if user_id in CURRENT_STEPS:
        return {"skipped": True, "reason": "pipeline_running", "user_id": user_id}

    return await bootstrap(user_id)


# Registry — the only names the function runner will execute. Must stay in
# sync with PYTHON_FUNCTIONS.hbpe in the NestJS python-functions domain.
FUNCTIONS = {
    "nightly": nightly,
    "bootstrap": bootstrap,
    "ensure_bootstrap": ensure_bootstrap,
}

__all__ = ["CURRENT_STEPS", "FUNCTIONS", "bootstrap", "ensure_bootstrap", "nightly"]
