"""
Bootstrap pipeline — full cold-start training through ONNX export.

Triggered when no HMT checkpoint exists (new user / fresh volume).
After this completes, NightlyHBPEWorkflow takes over for incremental updates.

Step order (mirrors run_pipeline.py steps 2–11):
  1. label_unlabeled      — assign L0/L1 to all events and content
  2. label_summary_tokens — assign L0/L1 to all hourly summaries
  3. serialize            — write hbpe.token_stream for all labeled days
  4. train                — L0 MAE pre-train + HMT joint fine-tune
  5. export               — temperature calibration + ONNX FP32 + INT8
  6. lora                 — initial LoRA adapter fine-tune
"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

log = logging.getLogger(__name__)

_RETRY_ONCE = RetryPolicy(maximum_attempts=1, backoff_coefficient=1.0)
_RETRY_2X   = RetryPolicy(maximum_attempts=2, backoff_coefficient=2.0)


# ── Activities ─────────────────────────────────────────────────────────────────

@activity.defn(name="serialize_token_stream")
async def serialize_token_stream(user_id: str) -> dict:
    """Serialize all labeled events/content into hbpe.token_stream."""
    def _run() -> dict:
        from ci.database import get_conn
        from ci.tokenizer.serializer import TokenSerializer

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT MIN(start_time::date), MAX(start_time::date)
                    FROM ci.events
                    WHERE user_id = %s AND is_deleted = FALSE
                      AND start_time >= '2010-01-01'::timestamptz
                """, (user_id,))
                row = cur.fetchone()

        if not row or row[0] is None:
            return {"rows": 0, "reason": "no_events"}

        start_date, end_date = str(row[0]), str(row[1])
        total_rows = TokenSerializer().serialize_range(user_id, start_date, end_date)
        return {"rows": total_rows, "start": start_date, "end": end_date}

    return await asyncio.get_event_loop().run_in_executor(None, _run)


@activity.defn(name="train_hmt_model")
async def train_hmt_model(user_id: str) -> dict:
    """L0 MAE pre-training followed by HMT joint fine-tuning."""
    def _run() -> dict:
        from ci.model.dataset import make_splits, TokenStreamDataset
        from ci.model.trainer import train_l0_mae, train_hmt_joint

        splits   = make_splits(user_id)
        train_ds = TokenStreamDataset(user_id, splits["train"])
        val_ds   = TokenStreamDataset(user_id, splits["val"])

        if len(train_ds) == 0:
            return {"skipped": True, "reason": "no_training_data"}

        l0_ckpt  = train_l0_mae(user_id, train_ds, val_ds)
        hmt_ckpt = train_hmt_joint(user_id, train_ds, val_ds)

        return {
            "l0_checkpoint":  str(l0_ckpt),
            "hmt_checkpoint": str(hmt_ckpt),
            "train_days":     len(train_ds),
            "val_days":       len(val_ds),
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


@activity.defn(name="calibrate_and_export_onnx")
async def calibrate_and_export_onnx(user_id: str) -> dict:
    """Temperature calibration + ONNX FP32 export + INT8 quantization."""
    def _run() -> dict:
        from ci.model.dataset import make_splits, TokenStreamDataset
        from ci.model.calibration import calibrate
        from ci.model.onnx_export import export_and_quantize

        splits  = make_splits(user_id)
        val_ds  = TokenStreamDataset(user_id, splits["val"])
        test_ds = TokenStreamDataset(user_id, splits["test"])

        calibrate(user_id, val_ds)
        rep = export_and_quantize(user_id, val_ds, test_ds)

        return {
            "fp32_mb":    rep["fp32_size_mb"],
            "int8_mb":    rep["int8_size_mb"],
            "l0_acc_int8": rep["l0_acc_int8"],
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Workflow ───────────────────────────────────────────────────────────────────

@workflow.defn(name="BootstrapHBPEWorkflow")
class BootstrapHBPEWorkflow:
    """
    Full cold-start HBPE pipeline.

    Runs once per user on first trigger when no HMT checkpoint exists.
    Fail-fast on training/export — labeling steps use fail-continue.
    """

    def __init__(self) -> None:
        self._step = "queued"

    @workflow.query
    def current_step(self) -> str:
        return self._step

    @workflow.run
    async def run(self, user_id: str) -> dict:
        from ci.pipeline.nightly_runner import (
            label_unlabeled,
            label_summary_tokens,
            lora_fine_tune,
        )

        results: dict = {"user_id": user_id, "steps": {}, "workflow": "bootstrap"}

        # Step 1 — label all unlabeled events + content
        self._step = "label"
        results["steps"]["label"] = await _safe(
            workflow.execute_activity(
                label_unlabeled, user_id,
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=_RETRY_2X,
            ),
            "label",
        )

        # Step 2 — label all unlabeled hourly summaries
        self._step = "label_summaries"
        results["steps"]["label_summaries"] = await _safe(
            workflow.execute_activity(
                label_summary_tokens, user_id,
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=_RETRY_2X,
            ),
            "label_summaries",
        )

        # Step 3 — serialize labeled data into token stream
        self._step = "serialize"
        results["steps"]["serialize"] = await _safe(
            workflow.execute_activity(
                serialize_token_stream, user_id,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=_RETRY_ONCE,
            ),
            "serialize",
        )

        # Abort if no token data to train on
        ser = results["steps"]["serialize"]
        if ser.get("status") == "error" or ser.get("result", {}).get("rows", -1) == 0:
            results["aborted"]      = True
            results["abort_reason"] = "no_token_data"
            self._step = "done"
            return results

        # Step 4 — train HMT model (L0 MAE pre-train → joint fine-tune)
        self._step = "train"
        results["steps"]["train"] = await _safe(
            workflow.execute_activity(
                train_hmt_model, user_id,
                start_to_close_timeout=timedelta(minutes=90),
                retry_policy=_RETRY_ONCE,
            ),
            "train",
        )

        train = results["steps"]["train"]
        if train.get("status") == "error":
            self._step = "done"
            return results
        if train.get("result", {}).get("skipped"):
            results["aborted"]      = True
            results["abort_reason"] = "no_training_data"
            self._step = "done"
            return results

        # Step 5 — calibrate temperature + export ONNX INT8
        self._step = "export"
        results["steps"]["export"] = await _safe(
            workflow.execute_activity(
                calibrate_and_export_onnx, user_id,
                start_to_close_timeout=timedelta(minutes=20),
                retry_policy=_RETRY_ONCE,
            ),
            "export",
        )

        # Step 6 — initial LoRA fine-tune (non-blocking; checkpoint now exists)
        self._step = "lora"
        results["steps"]["lora"] = await _safe(
            workflow.execute_activity(
                lora_fine_tune, user_id,
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=_RETRY_ONCE,
            ),
            "lora",
        )

        self._step = "done"
        return results


async def _safe(coro, step_name: str) -> dict:
    try:
        return {"status": "ok", "result": await coro}
    except Exception as exc:
        log.exception("Bootstrap step %s failed", step_name)
        return {"status": "error", "error": str(exc)}
