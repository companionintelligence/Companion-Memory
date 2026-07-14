"""
Actuals backfill — Phase 5a (T5.1).

Every ``/histogram`` response logs 48 forecast buckets to ``hbpe.prediction_log``
with ``actual_l0/l1/l2`` left NULL.  Once a forecast's day has elapsed, the day's
observed behavior has been serialized into ``hbpe.token_stream`` by the nightly
label + serialize pipeline, so the *actual* label for each 30-min bucket is now
known.  This module joins elapsed-window prediction rows to the observed token
stream and backfills the ``actual_*`` columns, enabling retrospective accuracy
measurement and the LoRA fine-tune signal.

Join semantics
--------------
A prediction row forecasts bucket ``bucket_index`` of the calendar day
``horizon_start::date`` (the forecast window begins at midnight tonight — see
``histogram_api.build_histogram``).  The observed labels for that bucket live in
``hbpe.token_stream`` at ``(user_id, date = horizon_start::date,
bucket_idx = bucket_index)``.  A bucket may carry several event-derived tokens
per level; we take the dominant one — highest ``soft_prob`` first, then earliest
``seq_order`` — so ties resolve deterministically.  ``token_id`` for an L0 token
is the L0 class name; for L1/L2 it is the cluster UUID (matching what the
histogram probability distributions are keyed by).

A window has "elapsed" once its whole calendar day is in the past
(``horizon_start::date < CURRENT_DATE`` in UTC), guaranteeing the nightly
serialize for that day has had a chance to run.

Spec: CI-HBPE-SPEC-001 §T5.1; subsystem plan §6 success metric
(≥95% of buckets whose window has elapsed are backfilled, rolling 7 d).
"""
from __future__ import annotations

import logging

from ci.database import get_conn

log = logging.getLogger(__name__)

# Default lookback: only re-scan recently-elapsed days so a nightly run is cheap
# and idempotent.  Days older than this are assumed already backfilled (or
# permanently un-backfillable — the user had no token_stream coverage that day).
DEFAULT_LOOKBACK_DAYS = 14

# One statement does the whole backfill.  A lateral join picks the dominant
# token per level for each predicted bucket; ``IS DISTINCT FROM`` keeps the
# UPDATE idempotent (no write when the value is already correct) and lets us
# report how many rows actually changed.
_BACKFILL_SQL = """
    WITH elapsed AS (
        SELECT id, predicted_at, horizon_start, bucket_index
        FROM hbpe.prediction_log
        WHERE user_id = %(user_id)s
          AND (horizon_start AT TIME ZONE 'UTC')::date < (NOW() AT TIME ZONE 'UTC')::date
          AND (horizon_start AT TIME ZONE 'UTC')::date
              >= (NOW() AT TIME ZONE 'UTC')::date - %(lookback)s::int
          AND (actual_l0 IS NULL OR actual_l1 IS NULL OR actual_l2 IS NULL)
    ),
    observed AS (
        SELECT
            e.id,
            e.predicted_at,
            (SELECT ts.token_id FROM hbpe.token_stream ts
              WHERE ts.user_id = %(user_id)s
                AND ts.date = (e.horizon_start AT TIME ZONE 'UTC')::date
                AND ts.bucket_idx = e.bucket_index
                AND ts.level = 'L0'
              ORDER BY ts.soft_prob[1] DESC NULLS LAST, ts.seq_order
              LIMIT 1) AS actual_l0,
            (SELECT ts.token_id FROM hbpe.token_stream ts
              WHERE ts.user_id = %(user_id)s
                AND ts.date = (e.horizon_start AT TIME ZONE 'UTC')::date
                AND ts.bucket_idx = e.bucket_index
                AND ts.level = 'L1'
              ORDER BY ts.soft_prob[1] DESC NULLS LAST, ts.seq_order
              LIMIT 1) AS actual_l1,
            (SELECT ts.token_id FROM hbpe.token_stream ts
              WHERE ts.user_id = %(user_id)s
                AND ts.date = (e.horizon_start AT TIME ZONE 'UTC')::date
                AND ts.bucket_idx = e.bucket_index
                AND ts.level = 'L2'
              ORDER BY ts.soft_prob[1] DESC NULLS LAST, ts.seq_order
              LIMIT 1) AS actual_l2
        FROM elapsed e
    )
    UPDATE hbpe.prediction_log p
    SET actual_l0 = o.actual_l0,
        actual_l1 = o.actual_l1,
        actual_l2 = o.actual_l2
    FROM observed o
    WHERE p.id = o.id
      AND p.predicted_at = o.predicted_at
      AND o.actual_l0 IS NOT NULL          -- only write buckets we actually observed
      AND (p.actual_l0 IS DISTINCT FROM o.actual_l0
        OR p.actual_l1 IS DISTINCT FROM o.actual_l1
        OR p.actual_l2 IS DISTINCT FROM o.actual_l2)
"""

# Coverage over the elapsed window: how many elapsed buckets now have an
# actual_l0, out of all elapsed buckets.  Feeds the §6 ≥95% success metric.
_COVERAGE_SQL = """
    SELECT
        COUNT(*)                                        AS elapsed,
        COUNT(*) FILTER (WHERE actual_l0 IS NOT NULL)   AS filled
    FROM hbpe.prediction_log
    WHERE user_id = %(user_id)s
      AND (horizon_start AT TIME ZONE 'UTC')::date < (NOW() AT TIME ZONE 'UTC')::date
      AND (horizon_start AT TIME ZONE 'UTC')::date
          >= (NOW() AT TIME ZONE 'UTC')::date - %(lookback)s::int
"""


def backfill_prediction_actuals(
    user_id: str,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> dict:
    """
    Backfill ``actual_l0/l1/l2`` on elapsed-window ``prediction_log`` rows from
    observed ``token_stream`` labels for *user_id*.

    Idempotent: re-running only rewrites rows whose observed labels changed
    (e.g. a day re-serialized after new events arrived).

    Args:
        user_id:       User UUID string.
        lookback_days: Only reconsider prediction days within this many days of
                       today; older days are assumed settled.

    Returns:
        ``{"user_id", "updated", "elapsed", "filled", "coverage"}`` where
        ``coverage`` is ``filled / elapsed`` (0.0 when no elapsed buckets), the
        number tracked against the §6 ≥0.95 success metric.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            params = {"user_id": user_id, "lookback": lookback_days}
            cur.execute(_BACKFILL_SQL, params)
            updated = cur.rowcount or 0

            cur.execute(_COVERAGE_SQL, params)
            elapsed, filled = cur.fetchone()

    elapsed = int(elapsed or 0)
    filled = int(filled or 0)
    coverage = (filled / elapsed) if elapsed else 0.0

    log.info(
        "actuals backfill user=%s updated=%d elapsed=%d filled=%d coverage=%.3f",
        (user_id or "?")[:8], updated, elapsed, filled, coverage,
    )
    if elapsed and coverage < 0.95:
        log.warning(
            "actuals coverage %.1f%% below §6 target (95%%) for user=%s "
            "(elapsed=%d filled=%d) — likely token_stream gaps",
            coverage * 100, (user_id or "?")[:8], elapsed, filled,
        )

    return {
        "user_id": user_id,
        "updated": updated,
        "elapsed": elapsed,
        "filled": filled,
        "coverage": round(coverage, 4),
    }
