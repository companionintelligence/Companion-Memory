"""
Static-first labeling for structured event kinds.

Ambient streams (media.play, browser view, social.*) never go through the
chat LLM. Structured anchor kinds (workout, sleep, trip) get a fixed L0/L1
from hbpe.kind_l0_map. Calendar free-text stays on the two-stage labeler.
"""

from __future__ import annotations

import logging

import psycopg2.extras

from ci.hbpe.database import get_conn
from ci.hbpe.tokenizer.vocab_registry import get_or_create_l1

log = logging.getLogger(__name__)


def load_kind_map() -> list[dict]:
    sql = """
        SELECT kind_pattern, l0_class, l1_label, tier, default_duration_min
        FROM hbpe.kind_l0_map
        ORDER BY length(kind_pattern) DESC
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            return [dict(r) for r in cur.fetchall()]


def mapped_kind_sql() -> str:
    """SQL predicate: event_type matches any kind_l0_map pattern."""
    return """
        EXISTS (
            SELECT 1 FROM hbpe.kind_l0_map m
            WHERE e.event_type LIKE m.kind_pattern
        )
    """


def label_mapped_events(user_id: str) -> dict:
    """Assign static L1 clusters to unlabeled events matching kind_l0_map."""
    kind_map = load_kind_map()
    labeled = 0
    by_kind: dict[str, int] = {}

    for row in kind_map:
        cluster_id, _ = get_or_create_l1(
            user_id,
            row["l0_class"],
            row["l1_label"],
            naming_method="STATIC",
            tier=row["tier"],
        )
        sql = """
            WITH claimed AS (
                SELECT e.event_id
                FROM ci.events e
                LEFT JOIN hbpe.l1_event_cluster ec ON ec.event_id = e.event_id
                WHERE e.user_id = %s::uuid
                  AND e.is_deleted = FALSE
                  AND e.event_type LIKE %s
                  AND ec.event_id IS NULL
                  AND e.start_time >= '2010-01-01'::timestamptz
            )
            INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity, assigned_at)
            SELECT event_id, %s::uuid, 1.0, NOW()
            FROM claimed
            ON CONFLICT (event_id) DO NOTHING
        """
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (str(user_id), row["kind_pattern"], cluster_id))
                n = int(cur.rowcount or 0)
                if n:
                    cur.execute(
                        """
                        UPDATE hbpe.l1_clusters
                        SET member_count = member_count + %s,
                            last_active_at = NOW(),
                            updated_at = NOW()
                        WHERE cluster_id = %s::uuid
                        """,
                        (n, cluster_id),
                    )
        labeled += n
        if n:
            by_kind[row["kind_pattern"]] = n

    if labeled:
        log.info("static_labeler user=%s labeled=%d %s", user_id[:8], labeled, by_kind)
    return {"labeled": labeled, "by_kind": by_kind}
