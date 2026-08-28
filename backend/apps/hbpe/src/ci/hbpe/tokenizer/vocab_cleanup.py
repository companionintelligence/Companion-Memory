"""
One-shot (idempotent) cleanup of junk L1 names and media filed under them.

Deactivates non-displayable clusters, moves media.* assignments onto the
static ambient clusters, and detaches hourly summaries from junk L1 ids.
"""

from __future__ import annotations

import logging

from ci.hbpe.database import get_conn
from ci.hbpe.tokenizer.label_quality import is_displayable_label
from ci.hbpe.tokenizer.static_labeler import load_kind_map
from ci.hbpe.tokenizer.vocab_registry import get_or_create_l1

log = logging.getLogger(__name__)


def cleanup_junk_vocab(user_id: str) -> dict:
    deactivated = _deactivate_junk_clusters(user_id)
    relabeled = _relabel_mapped_off_junk(user_id)
    summaries = _detach_junk_summaries(user_id)
    log.info(
        "vocab_cleanup user=%s deactivated=%d relabeled=%d summaries=%d",
        user_id[:8],
        deactivated,
        relabeled,
        summaries,
    )
    return {
        "deactivated": deactivated,
        "relabeled": relabeled,
        "summaries_detached": summaries,
    }


def _deactivate_junk_clusters(user_id: str) -> int:
    sql = """
        SELECT cluster_id::text, label
        FROM hbpe.l1_clusters
        WHERE user_id = %s::uuid AND is_active = TRUE
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (str(user_id),))
            rows = cur.fetchall()
    junk_ids = [cid for cid, label in rows if not is_displayable_label(label or "")]
    if not junk_ids:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE hbpe.l1_clusters
                SET is_active = FALSE, updated_at = NOW()
                WHERE cluster_id = ANY(%s::uuid[])
                """,
                (junk_ids,),
            )
            return int(cur.rowcount or 0)


def _relabel_mapped_off_junk(user_id: str) -> int:
    kind_map = load_kind_map()
    moved = 0
    for row in kind_map:
        dest_id, _ = get_or_create_l1(
            user_id,
            row["l0_class"],
            row["l1_label"],
            naming_method="STATIC",
            tier=row["tier"],
        )
        with get_conn() as conn:
            with conn.cursor() as cur:
                # The JOIN in UPDATE ... FROM needs ec in the FROM list on some
                # planners; rewrite as a subquery for portability.
                cur.execute(
                    """
                    UPDATE hbpe.l1_event_cluster
                    SET cluster_id = %s::uuid, similarity = 1.0, assigned_at = NOW()
                    WHERE event_id IN (
                        SELECT e.event_id
                        FROM ci.events e
                        JOIN hbpe.l1_event_cluster ec ON ec.event_id = e.event_id
                        JOIN hbpe.l1_clusters c ON c.cluster_id = ec.cluster_id
                        WHERE e.user_id = %s::uuid
                          AND e.event_type LIKE %s
                          AND (
                                c.is_active = FALSE
                                OR c.naming_method IS DISTINCT FROM 'STATIC'
                              )
                          AND ec.cluster_id IS DISTINCT FROM %s::uuid
                    )
                    """,
                    (dest_id, str(user_id), row["kind_pattern"], dest_id),
                )
                moved += int(cur.rowcount or 0)
    return moved


def _detach_junk_summaries(user_id: str) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE hbpe.summary_l1_label
                SET l1_cluster_id = NULL
                WHERE summary_id IN (
                    SELECT s.summary_id
                    FROM hbpe.summary_l1_label s
                    JOIN ci.summaries sm ON sm.summary_id = s.summary_id
                    JOIN hbpe.l1_clusters c ON c.cluster_id = s.l1_cluster_id
                    WHERE sm.user_id = %s::uuid
                      AND (c.is_active = FALSE OR c.tier = 'ambient')
                )
                """,
                (str(user_id),),
            )
            return int(cur.rowcount or 0)
