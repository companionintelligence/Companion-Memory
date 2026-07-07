"""
Histogram API backing logic — formats InferenceEngine output for the endpoint.

Accepts the 48-bucket list from InferenceEngine.predict() and applies any
horizon-specific post-processing before returning to the HTTP layer.  Also
writes every issued forecast to ci.prediction_log for retrospective accuracy
measurement and LoRA fine-tuning signal (T5.1).

Full spec: CI-HBPE-SPEC-001 §T4.4.
Response schema: 48 buckets × {bucket_index, start_time, l0_probs, l1_probs,
                                l2_probs, q10, q50, q90}

Implements T4.4 (CI-Server-k64).
"""
from __future__ import annotations

import datetime
import json
import logging
from pathlib import Path
from typing import Optional

import psycopg2.extras

from ci.config import settings
from ci.database import get_conn
from ci.model.checkpoints import (
    user_ckpt_dir, model_exists, HMT_CALIBRATED, HMT_FP32_ONNX, HMT_INT8_ONNX,
)

log = logging.getLogger(__name__)

# Only 24h horizon supported currently (48 × 30-min buckets)
SUPPORTED_HORIZONS = {"24h"}

# Furthest-out day selectable via horizon_start (today + N). Seven days covers
# weekly scheduling and the week-heatmap dashboard (CI-Engineering#61) while
# staying inside the range where the kernel's day-of-week boost is meaningful.
MAX_HORIZON_DAYS_AHEAD = 7

_INSERT_LOG_SQL = """
    INSERT INTO hbpe.prediction_log
        (user_id, predicted_at, horizon_start, bucket_index,
         l0_probs, l1_probs, l2_probs, model_version)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
"""


def build_histogram(
    engine,                            # InferenceEngine — typed loosely to avoid circular import
    horizon:       str = "24h",
    user_id:       Optional[str] = None,
    system_status: Optional[str] = None,
    horizon_start: Optional[datetime.date] = None,
) -> dict:
    """
    Generate the histogram response dict for GET /histogram.

    Also writes all 48 forecast buckets to ci.prediction_log.  The write is
    non-fatal: errors are logged but do not affect the API response.  Every
    served day — including multi-day range calls — goes through the same
    logging path, so each day's forecast remains scoreable by the nightly
    actuals backfill (ADR HBPE-0009 discipline).

    Args:
        engine:  An InferenceEngine instance (or compatible object with predict()).
        horizon: Forecast window string ("24h" is the only supported value).
        user_id: User UUID string; required for prediction logging.
        system_status: Pre-resolved engine status; resolved from checkpoints if None.
        horizon_start: UTC day the 24h window starts. None keeps the legacy
            default (tomorrow) and a byte-identical response shape.  When set it
            must satisfy today <= horizon_start <= today + MAX_HORIZON_DAYS_AHEAD.

    Honesty note (CI-Engineering#61): every selectable day is produced by the
    SAME kernel — a recency x day-of-week weighted blend over the trailing
    30 days of per-day model outputs.  Forecast quality therefore does not
    degrade with distance the way a learned autoregressive model's would; a
    day+7 forecast is essentially "what does this weekday usually look like",
    i.e. approximately day+0's same-weekday pattern.  Likewise q10/q50/q90
    remain a cross-day confidence spread, not calibrated predictive intervals.

    Returns:
        {
          "horizon": "24h",
          "generated_at": "<ISO timestamp>",
          "system_status": "<READY | COLD_START | workflow step>",
          "buckets": [<48 bucket dicts>],
          "horizon_start": "YYYY-MM-DD"   # only when horizon_start was provided
        }

    Raises:
        ValueError if horizon is not supported or horizon_start is out of range.
    """
    if horizon not in SUPPORTED_HORIZONS:
        raise ValueError(f"Unsupported horizon '{horizon}'. Supported: {SUPPORTED_HORIZONS}")

    now   = datetime.datetime.utcnow()
    today = now.date()

    if horizon_start is None:
        # Legacy default: forecast begins at midnight tonight (tomorrow, UTC).
        # Existing single-day clients hit this branch and see zero change.
        explicit_start = False
        start_dt = datetime.datetime(now.year, now.month, now.day) + datetime.timedelta(days=1)
    else:
        explicit_start = True
        if not (today <= horizon_start <= today + datetime.timedelta(days=MAX_HORIZON_DAYS_AHEAD)):
            raise ValueError(
                f"horizon_start {horizon_start.isoformat()} out of range: must be between "
                f"{today.isoformat()} (today) and today+{MAX_HORIZON_DAYS_AHEAD} inclusive"
            )
        start_dt = datetime.datetime.combine(horizon_start, datetime.time.min)

    log.info("Building histogram: user=%s  horizon=%s  start=%s",
             (user_id or "?")[:8], horizon, start_dt.date())

    # Per-day ONNX outputs are memoized in the engine's _output_cache, so an
    # N-day range shares the trailing 30-day history across calls; each extra
    # day costs only the aggregation pass, not N re-inferences.
    buckets = engine.predict(horizon_start=start_dt)

    if system_status is None:
        system_status = "READY" if (user_id and model_exists(user_id)) else "COLD_START"

    if user_id:
        _log_prediction(user_id, now, start_dt, buckets)

    result = {
        "horizon":       horizon,
        "generated_at":  now.isoformat() + "Z",
        "system_status": system_status,
        "buckets":       buckets,
    }
    if explicit_start:
        # Only added when explicitly requested so the default response stays
        # byte-identical for pre-multi-day clients.
        result["horizon_start"] = start_dt.date().isoformat()
    return result


# ── Prediction logging ─────────────────────────────────────────────────────────

def _log_prediction(
    user_id:       str,
    predicted_at:  datetime.datetime,
    horizon_start: datetime.datetime,
    buckets:       list[dict],
) -> None:
    """
    Write all 48 forecast buckets to ci.prediction_log in a single batch.

    Non-fatal: any DB error is logged and swallowed so it never affects the
    API response.  actual_l0/l1/l2 are left NULL here; the nightly
    ``backfill_actuals`` step (ci.pipeline.actuals_backfill) fills them once the
    forecast window has elapsed and the day's token_stream labels exist.
    """
    version = _model_version(user_id)
    rows = [
        (
            user_id,
            predicted_at,
            horizon_start,
            b["bucket_index"],
            json.dumps(b["l0_probs"]),
            json.dumps(b["l1_probs"]),
            json.dumps(b["l2_probs"]) if b.get("l2_probs") else None,
            version,
        )
        for b in buckets
    ]
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                psycopg2.extras.execute_batch(cur, _INSERT_LOG_SQL, rows)
        log.debug("Logged %d prediction buckets for user=%s", len(rows), user_id[:8])
    except Exception:
        log.exception("prediction_log write failed (non-fatal)")


def _model_version(user_id: Optional[str] = None) -> str:
    """
    Return a version string for the user's currently loaded model checkpoint.

    Checks for ONNX and PyTorch checkpoints in order of preference and uses
    the filename + Unix mtime so each nightly export gets a distinct version.
    """
    if not user_id:
        return "unknown"
    ckpt_dir = user_ckpt_dir(user_id)
    for name in (HMT_INT8_ONNX, HMT_FP32_ONNX, HMT_CALIBRATED):
        p = ckpt_dir / name
        if p.exists():
            return f"{name}@{int(p.stat().st_mtime)}"
    return "unknown"
