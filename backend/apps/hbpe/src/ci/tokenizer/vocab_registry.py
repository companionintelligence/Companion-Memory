"""
Vocab Registry — CRUD for the living L1 and L2 label vocabularies.

In the Qwen-based architecture, L1 and L2 clusters are *vocabulary entries*
(label strings) rather than centroid clusters.  This module provides
atomic get-or-create operations so the QwenLabeler can look up existing
labels and transparently add new ones on first encounter.

New labels are returned with is_new=True, which triggers a model-retrain
signal in the nightly runner so the HMT vocabulary stays in sync.
"""
from __future__ import annotations

import logging
import uuid

import psycopg2.extras

from ci.database import get_conn

log = logging.getLogger(__name__)

# Fixed L0 taxonomy (CI-HBPE-SPEC-001 §1.1) — never changes
L0_CLASSES = ("WORK", "EXERCISE", "SOCIAL", "ERRAND", "LEISURE", "TRANSIT", "SLEEP", "UNKNOWN")
_L0_SET = set(L0_CLASSES)


def normalise_l0(raw: str) -> str:
    """Map a raw model output to a valid L0 class, defaulting to UNKNOWN."""
    cleaned = raw.strip().upper().rstrip(".,;:!")
    return cleaned if cleaned in _L0_SET else "UNKNOWN"


# ── L1 ─────────────────────────────────────────────────────────────────────────


def get_l1_vocab(user_id: str, l0_class: str) -> list[dict]:
    """
    Return active L1 clusters for (user_id, l0_class), ordered by popularity.

    Each entry: {"cluster_id": str, "label": str}
    """
    sql = """
        SELECT cluster_id::text, label
        FROM   hbpe.l1_clusters
        WHERE  user_id  = %s::uuid
          AND  l0_class = %s
          AND  is_active = TRUE
        ORDER BY member_count DESC, label
        LIMIT 50
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), l0_class))
            return [dict(r) for r in cur.fetchall()]


def get_or_create_l1(user_id: str, l0_class: str, label: str) -> tuple[str, bool]:
    """
    Return (cluster_id, is_new) for a given L1 label.

    Creates a new cluster with naming_method='LLM' if the label has never
    been seen before for this (user_id, l0_class) pair.

    is_new=True indicates the HMT vocabulary has grown and a retrain is needed.
    """
    label = label.strip()

    sql_find = """
        SELECT cluster_id::text
        FROM   hbpe.l1_clusters
        WHERE  user_id  = %s::uuid
          AND  l0_class = %s
          AND  label    = %s
        LIMIT 1
    """

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql_find, (str(user_id), l0_class, label))
            row = cur.fetchone()
            if row:
                return str(row[0]), False

    # Not found — insert
    cluster_id = str(uuid.uuid4())
    sql_insert = """
        INSERT INTO hbpe.l1_clusters
            (cluster_id, user_id, l0_class, label,
             naming_method, is_active, member_count, created_at, updated_at)
        VALUES
            (%s, %s::uuid, %s, %s, 'LLM', TRUE, 0, NOW(), NOW())
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_insert, (
                    cluster_id, str(user_id), l0_class, label,
                ))
        log.info(
            "New L1 cluster: user=%s l0=%s label=%r → %s",
            user_id[:8], l0_class, label, cluster_id,
        )
        return cluster_id, True
    except Exception:
        # Race condition: another process inserted first
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_find, (str(user_id), l0_class, label))
                row = cur.fetchone()
                if row:
                    return str(row[0]), False
        raise


# ── L2 ─────────────────────────────────────────────────────────────────────────


def get_l2_vocab(user_id: str, l0_class: str, l1_cluster_id: str) -> list[dict]:
    """
    Return active L2 clusters for (user_id, l0_class, l1_cluster_id).

    Each entry: {"cluster_id": str, "label": str}
    """
    sql = """
        SELECT cluster_id::text, label
        FROM   hbpe.l2_clusters
        WHERE  user_id       = %s::uuid
          AND  l0_class      = %s
          AND  l1_cluster_id = %s::uuid
          AND  is_active     = TRUE
        ORDER BY member_count DESC, label
        LIMIT 50
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), l0_class, str(l1_cluster_id)))
            return [dict(r) for r in cur.fetchall()]


def get_or_create_l2(
    user_id: str,
    l0_class: str,
    l1_cluster_id: str,
    label: str,
) -> tuple[str, bool]:
    """
    Return (cluster_id, is_new) for a given L2 label under a specific L1 cluster.

    centroid column has been removed — embedding-based routing is no longer used.
    """
    label = label.strip()

    sql_find = """
        SELECT cluster_id::text
        FROM   hbpe.l2_clusters
        WHERE  user_id       = %s::uuid
          AND  l0_class      = %s
          AND  l1_cluster_id = %s::uuid
          AND  label         = %s
        LIMIT 1
    """

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql_find, (str(user_id), l0_class, str(l1_cluster_id), label))
            row = cur.fetchone()
            if row:
                return str(row[0]), False

    cluster_id = str(uuid.uuid4())
    sql_insert = """
        INSERT INTO hbpe.l2_clusters
            (cluster_id, user_id, l0_class, l1_cluster_id, label,
             naming_method, is_active, member_count, created_at, updated_at)
        VALUES
            (%s, %s::uuid, %s, %s::uuid, %s, 'LLM', TRUE, 0, NOW(), NOW())
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_insert, (
                    cluster_id, str(user_id), l0_class, str(l1_cluster_id), label,
                ))
        log.info(
            "New L2 cluster: user=%s l0=%s l1=%s label=%r → %s",
            user_id[:8], l0_class, l1_cluster_id[:8], label, cluster_id,
        )
        return cluster_id, True
    except Exception:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_find, (str(user_id), l0_class, str(l1_cluster_id), label))
                row = cur.fetchone()
                if row:
                    return str(row[0]), False
        raise


# ── Write assignments ──────────────────────────────────────────────────────────


def write_event_label(
    event_id: str,
    user_id: str,
    l0_class: str,
    l1_cluster_id: str,
) -> None:
    """
    Assign an L1 cluster to an event.

    Upserts ci.l1_event_cluster (similarity=1.0 for LLM labels) and
    bumps the cluster's member_count + last_active_at.
    """
    sql_upsert = """
        INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity, assigned_at)
        VALUES (%s::uuid, %s::uuid, 1.0, NOW())
        ON CONFLICT (event_id)
        DO UPDATE SET
            cluster_id  = EXCLUDED.cluster_id,
            similarity  = EXCLUDED.similarity,
            assigned_at = EXCLUDED.assigned_at
    """
    sql_bump = """
        UPDATE hbpe.l1_clusters
        SET member_count   = member_count + 1,
            last_active_at = NOW(),
            updated_at     = NOW()
        WHERE cluster_id = %s::uuid
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql_upsert, (str(event_id), str(l1_cluster_id)))
            cur.execute(sql_bump, (str(l1_cluster_id),))


def write_content_label(
    content_id: str,
    user_id: str,
    l0_class: str,
    l1_cluster_id: str,
    l2_cluster_id: str,
) -> None:
    """
    Assign L2 cluster + context to a content item.

    Upserts ci.l2_content_cluster and ci.content_context, then bumps
    the L2 cluster's member_count.
    """
    sql_l2 = """
        INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity, assigned_at)
        VALUES (%s::uuid, %s::uuid, 1.0, NOW())
        ON CONFLICT (content_id)
        DO UPDATE SET
            cluster_id  = EXCLUDED.cluster_id,
            similarity  = EXCLUDED.similarity,
            assigned_at = EXCLUDED.assigned_at
    """
    sql_ctx = """
        INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id, assigned_at)
        VALUES (%s::uuid, %s::uuid, %s, %s::uuid, NOW())
        ON CONFLICT (content_id)
        DO UPDATE SET
            l0_class      = EXCLUDED.l0_class,
            l1_cluster_id = EXCLUDED.l1_cluster_id,
            user_id       = EXCLUDED.user_id
    """
    sql_bump = """
        UPDATE hbpe.l2_clusters
        SET member_count   = member_count + 1,
            last_active_at = NOW(),
            updated_at     = NOW()
        WHERE cluster_id = %s::uuid
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql_l2, (str(content_id), str(l2_cluster_id)))
            cur.execute(sql_ctx, (str(content_id), str(user_id), l0_class, str(l1_cluster_id)))
            cur.execute(sql_bump, (str(l2_cluster_id),))
