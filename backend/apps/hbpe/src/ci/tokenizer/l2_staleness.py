"""
L2 Staleness Sweep — marks L2 clusters inactive after 90 days of no new content
routing to them (CI-HBPE-SPEC-001 §1.2 and nightly job step 3).

Mirrors L1Staleness but operates on ci.l2_clusters.

Implements the L2 half of T5.2 (CI-Server-cs0).
"""
from __future__ import annotations

import logging

from ci.config import settings
from ci.database import get_conn

log = logging.getLogger(__name__)


class L2Staleness:
    """Nightly sweep: deactivates L2 clusters with no activity in staleness_days."""

    def run(self, user_id: str) -> int:
        """
        Flag stale L2 clusters for user.

        Returns the count of clusters marked inactive.
        """
        return _deactivate_stale_clusters(user_id, settings.cluster_staleness_days)


# ── DB helper ─────────────────────────────────────────────────────────────────


def _deactivate_stale_clusters(user_id: str, staleness_days: int) -> int:
    sql = """
        UPDATE hbpe.l2_clusters
        SET    is_active  = FALSE,
               updated_at = NOW()
        WHERE  user_id    = %s
          AND  is_active  = TRUE
          AND  (
                last_active_at IS NOT NULL
                AND last_active_at < NOW() - INTERVAL '1 day' * %s
               )
        RETURNING cluster_id
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Fail fast on lock contention — a single-row sweep has no business
            # holding the activity hostage for minutes.
            cur.execute("SET LOCAL statement_timeout = '30s'")
            cur.execute(sql, (user_id, staleness_days))
            deactivated = cur.rowcount

    if deactivated:
        log.info(
            "L2 staleness: deactivated %d clusters for user=%s (threshold=%d days)",
            deactivated, user_id, staleness_days,
        )
    return deactivated
