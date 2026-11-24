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

from ci.hbpe.database import get_conn
from ci.hbpe.tokenizer.label_quality import (
    FALLBACK_LABEL,
    L1_PER_CLASS_MAX,
    is_displayable_label,
    nearest_label,
)

log = logging.getLogger(__name__)

# Fixed L0 taxonomy (CI-HBPE-SPEC-001 §1.1) — never changes
L0_CLASSES = (
    "WORK",
    "EXERCISE",
    "SOCIAL",
    "ERRAND",
    "LEISURE",
    "TRANSIT",
    "SLEEP",
    "UNKNOWN",
)
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


def get_or_create_l1(
    user_id: str,
    l0_class: str,
    label: str,
    naming_method: str = "LLM",
    tier: str = "anchor",
) -> tuple[str, bool]:
    """
    Return (cluster_id, is_new) for a given L1 label.

    Junk names and the 50/class cap never mint. Ambient STATIC labels always
    insert (they are a fixed closed set).
    """
    label = label.strip()
    if naming_method != "STATIC" and not is_displayable_label(label):
        existing = [e["label"] for e in get_l1_vocab(user_id, l0_class)]
        label = nearest_label(label, existing) or FALLBACK_LABEL
        if existing:
            found = _find_l1(user_id, l0_class, label)
            if found:
                return found, False

    found = _find_l1(user_id, l0_class, label)
    if found:
        return found, False

    if naming_method != "STATIC":
        active = _active_l1_count(user_id, l0_class)
        if active >= L1_PER_CLASS_MAX:
            existing = [e["label"] for e in get_l1_vocab(user_id, l0_class)]
            label = nearest_label(label, existing) or (
                existing[0] if existing else FALLBACK_LABEL
            )
            found = _find_l1(user_id, l0_class, label)
            if found:
                return found, False

    cluster_id = str(uuid.uuid4())
    sql_insert = """
        INSERT INTO hbpe.l1_clusters
            (cluster_id, user_id, l0_class, label,
             naming_method, tier, is_active, member_count, created_at, updated_at)
        VALUES
            (%s, %s::uuid, %s, %s, %s, %s, TRUE, 0, NOW(), NOW())
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql_insert,
                    (cluster_id, str(user_id), l0_class, label, naming_method, tier),
                )
        log.info(
            "New L1 cluster: user=%s l0=%s label=%r method=%s tier=%s → %s",
            user_id[:8],
            l0_class,
            label,
            naming_method,
            tier,
            cluster_id,
        )
        return cluster_id, True
    except Exception:
        found = _find_l1(user_id, l0_class, label)
        if found:
            return found, False
        raise


def _find_l1(user_id: str, l0_class: str, label: str) -> str | None:
    sql = """
        SELECT cluster_id::text
        FROM   hbpe.l1_clusters
        WHERE  user_id  = %s::uuid
          AND  l0_class = %s
          AND  label    = %s
        LIMIT 1
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (str(user_id), l0_class, label))
            row = cur.fetchone()
    return str(row[0]) if row else None


def _active_l1_count(user_id: str, l0_class: str) -> int:
    sql = """
        SELECT COUNT(*)
        FROM hbpe.l1_clusters
        WHERE user_id = %s::uuid AND l0_class = %s AND is_active = TRUE
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (str(user_id), l0_class))
            return int(cur.fetchone()[0] or 0)


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
    if not is_displayable_label(label):
        existing = [e["label"] for e in get_l2_vocab(user_id, l0_class, l1_cluster_id)]
        label = nearest_label(label, existing) or FALLBACK_LABEL
        if existing:
            sql_existing = """
                SELECT cluster_id::text FROM hbpe.l2_clusters
                WHERE user_id = %s::uuid AND l0_class = %s
                  AND l1_cluster_id = %s::uuid AND label = %s LIMIT 1
            """
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql_existing,
                        (str(user_id), l0_class, str(l1_cluster_id), label),
                    )
                    row = cur.fetchone()
                    if row:
                        return str(row[0]), False

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
                cur.execute(
                    sql_insert,
                    (
                        cluster_id,
                        str(user_id),
                        l0_class,
                        str(l1_cluster_id),
                        label,
                    ),
                )
        log.info(
            "New L2 cluster: user=%s l0=%s l1=%s label=%r → %s",
            user_id[:8],
            l0_class,
            l1_cluster_id[:8],
            label,
            cluster_id,
        )
        return cluster_id, True
    except Exception:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql_find, (str(user_id), l0_class, str(l1_cluster_id), label)
                )
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
    """Assign an L1 cluster to one event; see :func:`write_event_labels`."""
    write_event_labels([(event_id, l1_cluster_id)])


def write_event_labels(assignments: list[tuple[str, str]]) -> None:
    """
    Assign L1 clusters to many events: ``(event_id, l1_cluster_id)`` pairs.

    Two statements for the batch where there used to be two per event — the
    labeler hands over a whole LLM batch at once: one multi-row upsert of
    ``hbpe.l1_event_cluster`` (similarity=1.0 for LLM labels), then one
    ``UPDATE ... FROM unnest`` that bumps each cluster's ``member_count`` by
    how many events it was given and moves ``last_active_at``.

    An event named twice keeps its LAST assignment (an upsert cannot touch one
    row twice in a statement), and is counted once.
    """
    latest = {str(event_id): str(cluster_id) for event_id, cluster_id in assignments}
    if not latest:
        return

    bumps: dict[str, int] = {}
    for cluster_id in latest.values():
        bumps[cluster_id] = bumps.get(cluster_id, 0) + 1

    sql_upsert = """
        INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity, assigned_at)
        VALUES %s
        ON CONFLICT (event_id)
        DO UPDATE SET
            cluster_id  = EXCLUDED.cluster_id,
            similarity  = EXCLUDED.similarity,
            assigned_at = EXCLUDED.assigned_at
    """
    sql_bump = """
        UPDATE hbpe.l1_clusters c
        SET member_count   = c.member_count + b.n,
            last_active_at = NOW(),
            updated_at     = NOW()
        FROM unnest(%s::uuid[], %s::int[]) AS b(cluster_id, n)
        WHERE c.cluster_id = b.cluster_id
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                sql_upsert,
                list(latest.items()),
                template="(%s::uuid, %s::uuid, 1.0, NOW())",
            )
            cur.execute(sql_bump, (list(bumps.keys()), list(bumps.values())))


def write_content_label(
    content_id: str,
    user_id: str,
    l0_class: str,
    l1_cluster_id: str,
    l2_cluster_id: str,
) -> None:
    """Assign L2 cluster + context to one content item; see :func:`write_content_labels`."""
    write_content_labels(
        [(content_id, user_id, l0_class, l1_cluster_id, l2_cluster_id)]
    )


def write_content_labels(
    assignments: list[tuple[str, str, str, str, str]],
) -> None:
    """
    Assign L2 clusters and context to many content items:
    ``(content_id, user_id, l0_class, l1_cluster_id, l2_cluster_id)`` tuples.

    Three statements for the batch where there used to be three per item: one
    multi-row upsert of ``hbpe.l2_content_cluster``, one of
    ``hbpe.content_context``, then one ``UPDATE ... FROM unnest`` bumping each
    L2 cluster's ``member_count`` by how many items it was given. An item
    named twice keeps its last assignment and is counted once.
    """
    latest: dict[str, tuple[str, str, str, str]] = {}
    for content_id, user_id, l0_class, l1_cluster_id, l2_cluster_id in assignments:
        latest[str(content_id)] = (
            str(user_id),
            l0_class,
            str(l1_cluster_id),
            str(l2_cluster_id),
        )
    if not latest:
        return

    bumps: dict[str, int] = {}
    for _, _, _, l2_cluster_id in latest.values():
        bumps[l2_cluster_id] = bumps.get(l2_cluster_id, 0) + 1

    sql_l2 = """
        INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity, assigned_at)
        VALUES %s
        ON CONFLICT (content_id)
        DO UPDATE SET
            cluster_id  = EXCLUDED.cluster_id,
            similarity  = EXCLUDED.similarity,
            assigned_at = EXCLUDED.assigned_at
    """
    sql_ctx = """
        INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id, assigned_at)
        VALUES %s
        ON CONFLICT (content_id)
        DO UPDATE SET
            l0_class      = EXCLUDED.l0_class,
            l1_cluster_id = EXCLUDED.l1_cluster_id,
            user_id       = EXCLUDED.user_id
    """
    sql_bump = """
        UPDATE hbpe.l2_clusters c
        SET member_count   = c.member_count + b.n,
            last_active_at = NOW(),
            updated_at     = NOW()
        FROM unnest(%s::uuid[], %s::int[]) AS b(cluster_id, n)
        WHERE c.cluster_id = b.cluster_id
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                sql_l2,
                [(content_id, l2) for content_id, (_, _, _, l2) in latest.items()],
                template="(%s::uuid, %s::uuid, 1.0, NOW())",
            )
            psycopg2.extras.execute_values(
                cur,
                sql_ctx,
                [
                    (content_id, user_id, l0, l1)
                    for content_id, (user_id, l0, l1, _) in latest.items()
                ],
                template="(%s::uuid, %s::uuid, %s, %s::uuid, NOW())",
            )
            cur.execute(sql_bump, (list(bumps.keys()), list(bumps.values())))
