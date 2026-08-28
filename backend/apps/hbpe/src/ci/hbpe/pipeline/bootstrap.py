"""
Bootstrap pipeline — full cold-start training through ONNX export.

Triggered when no HMT checkpoint exists (new user / fresh volume). After this
completes, the nightly pipeline (ci.hbpe.functions.nightly) takes over for
incremental updates. Orchestrated by ci.hbpe.functions.bootstrap.

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

log = logging.getLogger(__name__)


# ── Activities ─────────────────────────────────────────────────────────────────


async def serialize_token_stream(user_id: str) -> dict:
    """Serialize all labeled events/content into hbpe.token_stream."""

    def _run() -> dict:
        from ci.hbpe.database import get_conn
        from ci.hbpe.tokenizer.serializer import TokenSerializer

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

        if not row or row[0] is None:
            return {"rows": 0, "reason": "no_events"}

        start_date, end_date = str(row[0]), str(row[1])
        # Cap the raw serialize window at 90 days so overnight stays cheap;
        # older history lives in recurrence/seasonal SQL, not the HMT corpus.
        from datetime import date, timedelta

        end = date.fromisoformat(end_date)
        start = max(date.fromisoformat(start_date), end - timedelta(days=90))
        total_rows = TokenSerializer().serialize_range(
            user_id, start.isoformat(), end.isoformat()
        )
        from ci.hbpe.pipeline.token_rollup import rebuild_token_rollups

        rollup = rebuild_token_rollups(user_id)
        return {
            "rows": total_rows,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "rollup": rollup,
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def train_hmt_model(user_id: str) -> dict:
    """L0 MAE pre-training followed by HMT joint fine-tuning."""

    def _run() -> dict:
        from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
        from ci.hbpe.model.trainer import train_hmt_joint, train_l0_mae

        splits = make_splits(user_id)
        extra: list[list[dict]] = []
        try:
            from ci.hbpe.pipeline.token_rollup import fetch_rollup_days

            extra = [_rollup_as_day(day) for day in fetch_rollup_days(user_id)]
        except Exception:
            extra = []
        train_ds = TokenStreamDataset(user_id, splits["train"], extra)
        val_ds = TokenStreamDataset(user_id, splits["val"])

        if len(train_ds) == 0:
            return {"skipped": True, "reason": "no_training_data"}

        l0_ckpt = train_l0_mae(user_id, train_ds, val_ds)
        hmt_ckpt = train_hmt_joint(user_id, train_ds, val_ds)

        return {
            "l0_checkpoint": str(l0_ckpt),
            "hmt_checkpoint": str(hmt_ckpt),
            "train_days": len(train_ds),
            "val_days": len(val_ds),
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def calibrate_and_export_onnx(user_id: str) -> dict:
    """Temperature calibration + ONNX FP32 export + INT8 quantization."""

    def _run() -> dict:
        from ci.hbpe.model.calibration import calibrate
        from ci.hbpe.model.dataset import TokenStreamDataset, make_splits
        from ci.hbpe.model.onnx_export import export_and_quantize

        splits = make_splits(user_id)
        val_ds = TokenStreamDataset(user_id, splits["val"])
        test_ds = TokenStreamDataset(user_id, splits["test"])

        calibrate(user_id, val_ds)
        rep = export_and_quantize(user_id, val_ds, test_ds)

        return {
            "fp32_mb": rep["fp32_size_mb"],
            "int8_mb": rep["int8_size_mb"],
            "l0_acc_int8": rep["l0_acc_int8"],
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


def _rollup_as_day(day: dict) -> list[dict]:
    from ci.hbpe.buckets import BUCKETS_PER_DAY

    body = [
        {
            "level": t["level"],
            "token_id": t["token_id"],
            "soft_prob": t["soft_prob"],
            "bucket_idx": t["bucket_idx"],
        }
        for t in day["tokens"]
    ]
    return [
        {"level": "SOD", "token_id": "SOD", "soft_prob": [1.0], "bucket_idx": 0},
        *body,
        {
            "level": "EOD",
            "token_id": "EOD",
            "soft_prob": [1.0],
            "bucket_idx": BUCKETS_PER_DAY - 1,
        },
    ]
