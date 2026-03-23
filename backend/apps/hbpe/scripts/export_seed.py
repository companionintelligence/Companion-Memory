"""
Export current hbpe pipeline data as a dbmate seed migration.

Dumps hbpe.l1_clusters, hbpe.l1_event_cluster, and hbpe.token_stream for
the first user found in ci.users.  Writes a migration file that can be
committed and replayed on a fresh DB, letting the pipeline test skip the
Qwen labeling step.

Usage (inside the container):
    python3 scripts/export_seed.py > /tmp/seed.sql
    # then copy out: docker cp ci-server-hbpe-service-1:/tmp/seed.sql .
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

import psycopg2.extras

from ci.database import get_conn


def _q(v: object) -> str:
    """Format a Python value as a SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, datetime):
        return f"'{v.isoformat()}'"
    s = str(v).replace("'", "''")
    return f"'{s}'"


def export() -> None:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:

            # ── resolve user ──────────────────────────────────────────────────
            cur.execute("SELECT id::text FROM ci.users ORDER BY created_at LIMIT 1")
            row = cur.fetchone()
            if not row:
                print("-- ERROR: no users in ci.users", file=sys.stderr)
                sys.exit(1)
            user_id = row["id"]

            # ── fetch data ────────────────────────────────────────────────────
            cur.execute("""
                SELECT
                    cluster_id::text, user_id::text, l0_class, label, display_name,
                    keywords, member_count, naming_method, is_active,
                    last_active_at, created_at, updated_at
                FROM hbpe.l1_clusters
                WHERE user_id = %s::uuid
                ORDER BY l0_class, label
            """, (user_id,))
            clusters = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT event_id::text, cluster_id::text, similarity, assigned_at
                FROM hbpe.l1_event_cluster ec
                JOIN hbpe.l1_clusters cl ON cl.cluster_id = ec.cluster_id
                WHERE cl.user_id = %s::uuid
                ORDER BY assigned_at
            """, (user_id,))
            event_clusters = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT id::text, user_id::text, date::text, seq_order,
                       bucket_idx, level, token_id, soft_prob, serialized_at
                FROM hbpe.token_stream
                WHERE user_id = %s::uuid
                ORDER BY date, seq_order
            """, (user_id,))
            tokens = [dict(r) for r in cur.fetchall()]

    now = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    cluster_ids = [c["cluster_id"] for c in clusters]
    event_ids   = [e["event_id"]   for e in event_clusters]
    token_ids   = [t["id"]         for t in tokens]

    out = []

    out.append("-- migrate:up")
    out.append(f"-- HBPE seed data — exported {datetime.now(timezone.utc).isoformat()[:19]}Z")
    out.append(f"-- user_id: {user_id}")
    out.append(f"-- {len(clusters)} L1 clusters · {len(event_clusters)} event assignments · {len(tokens)} token rows")
    out.append("")

    # ── l1_clusters ───────────────────────────────────────────────────────────
    if clusters:
        out.append("-- hbpe.l1_clusters")
        out.append("INSERT INTO hbpe.l1_clusters")
        out.append("    (cluster_id, user_id, l0_class, label, display_name,")
        out.append("     keywords, member_count, naming_method, is_active,")
        out.append("     last_active_at, created_at, updated_at)")
        out.append("VALUES")
        rows = []
        for c in clusters:
            kw = ("ARRAY[" + ",".join(f"'{k}'" for k in c["keywords"]) + "]") if c["keywords"] else "NULL"
            rows.append(
                f"    ({_q(c['cluster_id'])}::uuid, {_q(c['user_id'])}::uuid, "
                f"{_q(c['l0_class'])}, {_q(c['label'])}, {_q(c['display_name'])}, "
                f"{kw}, {_q(c['member_count'])}, {_q(c['naming_method'])}, {_q(c['is_active'])}, "
                f"{_q(c['last_active_at'])}, {_q(c['created_at'])}, {_q(c['updated_at'])})"
            )
        out.append(",\n".join(rows))
        out.append("ON CONFLICT (cluster_id) DO NOTHING;")
        out.append("")

    # ── l1_event_cluster ──────────────────────────────────────────────────────
    if event_clusters:
        out.append("-- hbpe.l1_event_cluster")
        out.append("INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity, assigned_at)")
        out.append("VALUES")
        rows = []
        for e in event_clusters:
            rows.append(
                f"    ({_q(e['event_id'])}::uuid, {_q(e['cluster_id'])}::uuid, "
                f"{_q(e['similarity'])}, {_q(e['assigned_at'])})"
            )
        out.append(",\n".join(rows))
        out.append("ON CONFLICT (event_id) DO NOTHING;")
        out.append("")

    # ── token_stream ──────────────────────────────────────────────────────────
    if tokens:
        out.append("-- hbpe.token_stream")
        out.append("INSERT INTO hbpe.token_stream")
        out.append("    (id, user_id, date, seq_order, bucket_idx, level, token_id, soft_prob, serialized_at)")
        out.append("VALUES")
        rows = []
        for t in tokens:
            prob = "ARRAY[" + ",".join(str(p) for p in t["soft_prob"]) + "]::float4[]"
            rows.append(
                f"    ({_q(t['id'])}::uuid, {_q(t['user_id'])}::uuid, "
                f"{_q(t['date'])}::date, {_q(t['seq_order'])}, {_q(t['bucket_idx'])}, "
                f"{_q(t['level'])}, {_q(t['token_id'])}, {prob}, {_q(t['serialized_at'])})"
            )
        out.append(",\n".join(rows))
        out.append("ON CONFLICT (id) DO NOTHING;")
        out.append("")

    # ── rollback ──────────────────────────────────────────────────────────────
    out.append("-- migrate:down")
    if token_ids:
        id_list = ", ".join(f"'{i}'" for i in token_ids)
        out.append(f"DELETE FROM hbpe.token_stream WHERE id IN ({id_list});")
    if event_ids:
        id_list = ", ".join(f"'{i}'" for i in event_ids)
        out.append(f"DELETE FROM hbpe.l1_event_cluster WHERE event_id IN ({id_list});")
    if cluster_ids:
        id_list = ", ".join(f"'{i}'" for i in cluster_ids)
        out.append(f"DELETE FROM hbpe.l1_clusters WHERE cluster_id IN ({id_list});")

    print("\n".join(out))


if __name__ == "__main__":
    export()
