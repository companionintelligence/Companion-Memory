"""
L1 Staleness Sweep — marks L1 clusters inactive after 90 days of no new events
routing to them (CI-HBPE-SPEC-001 §1.2 and nightly job step 2).

A cluster is stale when last_active_at < NOW() - staleness_days.
Deactivated clusters (is_active=false) are excluded from routing but remain
in the DB for historical token corpus integrity.

Implements the L1 half of T5.2 (CI-Server-cs0).
"""
from __future__ import annotations

import logging

import psycopg2.extras

from ci.config import settings
from ci.database import get_conn

log = logging.getLogger(__name__)


class L1Staleness:
    """Nightly sweep: deactivates L1 clusters with no activity in staleness_days."""

    def run(self, user_id: str) -> int:
        """
        Flag stale L1 clusters for user.

        Returns the count of clusters marked inactive.
        """
        return _deactivate_stale_clusters(user_id, settings.cluster_staleness_days)


# ── DB helper ─────────────────────────────────────────────────────────────────


def _deactivate_stale_clusters(user_id: str, staleness_days: int) -> int:
    sql = """
        UPDATE hbpe.l1_clusters
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
            cur.execute(sql, (user_id, staleness_days))
            deactivated = cur.rowcount

    if deactivated:
        log.info(
            "L1 staleness: deactivated %d clusters for user=%s (threshold=%d days)",
            deactivated, user_id, staleness_days,
        )
    return deactivated
