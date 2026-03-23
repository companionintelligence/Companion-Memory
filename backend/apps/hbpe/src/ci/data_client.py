"""
Data client — reads from app-owned tables on behalf of HBPE.

All reads from CI application tables (ci.events, ci.content, ci.summaries,
ci.users) are channelled through this module.  Where the GraphQL API provides
an efficient path the implementation uses graphql_client; where it does not,
direct SQL is used with a documented reason.

GraphQL is used for:
  • summaries (bounded per-day, ≤ 24 hourly)
  • content existence check (just needs a boolean)
  • user ID lookup (me query)

SQL is used for:
  • bulk event / content queries — EventService.findAll() and
    ContentService.findAll() load ALL rows into memory server-side before
    cursor-slicing, so N paginated requests are more expensive than one
    targeted JOIN.  The search endpoint hard-caps at 25 results, which would
    silently truncate days with many events and corrupt the token stream.
  • ci.content → event_id join — ContentType does not expose eventId in the
    GraphQL schema, so the L2-cluster JOIN cannot be expressed via GraphQL.
  • user list (get_all_user_ids) — the API has no admin "list all users" query.
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Optional

import psycopg2.extras

from ci.database import get_conn
from ci.graphql_client import GraphQLUnavailable, decode_gid, gql, paginate

log = logging.getLogger(__name__)


# ── GraphQL query strings ──────────────────────────────────────────────────────

_ME_QUERY = """
query Me {
  me {
    id
  }
}
"""

_SUMMARIES_QUERY = """
query Summaries($after: String) {
  summaries(first: 100, after: $after) {
    edges {
      node {
        id
        periodType
        periodStart
        summaryText
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

_CONTENTS_EXISTS_QUERY = """
query ContentsExists {
  contents(first: 1) {
    edges {
      node { id }
    }
  }
}
"""


# ── Events ────────────────────────────────────────────────────────────────────


def get_unlabeled_events(user_id: str, limit: int = 1000) -> list[dict]:
    """
    Return events that have no entry in hbpe.l1_event_cluster.

    Keys: event_id (str), title (str|None), description (str|None)

    SQL rationale: EventService.findAll() loads all rows server-side before
    cursor-slicing, making paginated GraphQL requests O(n·pages) expensive.
    The search endpoint hard-caps at 25 results.  A single SQL JOIN is O(n).
    """
    sql = """
        SELECT e.event_id::text, e.title, e.description
        FROM ci.events e
        LEFT JOIN hbpe.l1_event_cluster ec ON ec.event_id = e.event_id
        WHERE e.user_id    = %s::uuid
          AND e.is_deleted = FALSE
          AND ec.event_id  IS NULL
        ORDER BY e.start_time
        LIMIT %s
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), limit))
            return [dict(r) for r in cur.fetchall()]


def get_token_events_for_day(user_id: str, date_str: str) -> list[dict]:
    """
    Return all token-relevant data for labeled events on a calendar day.

    Keys: l0_class, l1_cluster_id, l1_sim, bucket_idx, l2_cluster_id (None
    if no content), l2_sim (None if no content).

    SQL rationale: (a) the GraphQL search endpoint hard-caps at 25 events per
    request, which would silently truncate active days and corrupt the token
    stream; (b) ContentType does not expose eventId in the schema, so the
    L2-cluster JOIN cannot be expressed in GraphQL.
    """
    sql = """
        WITH day_events AS (
            SELECT
                e.event_id,
                e.start_time,
                EXTRACT(epoch FROM (e.start_time - date_trunc('day', e.start_time))) / 1800
                    AS bucket_idx_raw,
                cl1.l0_class          AS l0_class,
                ec.cluster_id::text   AS l1_cluster_id,
                ec.similarity         AS l1_sim
            FROM ci.events e
            JOIN hbpe.l1_event_cluster ec  ON ec.event_id   = e.event_id
            JOIN hbpe.l1_clusters      cl1 ON cl1.cluster_id = ec.cluster_id
            WHERE e.user_id    = %s
              AND e.is_deleted = FALSE
              AND e.start_time >= %s::date
              AND e.start_time <  (%s::date + INTERVAL '1 day')
            ORDER BY e.start_time
        )
        SELECT
            de.l0_class,
            de.l1_cluster_id,
            de.l1_sim,
            LEAST(GREATEST(de.bucket_idx_raw::int, 0), 47) AS bucket_idx,
            lc.cluster_id::text AS l2_cluster_id,
            lc.similarity       AS l2_sim
        FROM day_events de
        LEFT JOIN hbpe.l2_content_cluster lc ON lc.content_id = (
            SELECT c.id
            FROM ci.content c
            WHERE c.user_id  = %s
              AND c.event_id = de.event_id
            LIMIT 1
        )
        ORDER BY bucket_idx
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (user_id, date_str, date_str, user_id))
            return [dict(r) for r in cur.fetchall()]


# ── Content ───────────────────────────────────────────────────────────────────


def get_unlabeled_content(user_id: str, limit: int = 1000) -> list[dict]:
    """
    Return content items that have no entry in hbpe.l2_content_cluster.

    Keys: content_id (str), title (str|None), content_type (str|None)

    SQL rationale: same bulk-query reasoning as get_unlabeled_events.
    """
    sql = """
        SELECT c.id::text AS content_id, c.title, c.content_type
        FROM ci.content c
        LEFT JOIN hbpe.l2_content_cluster lc ON lc.content_id = c.id
        WHERE c.user_id     = %s::uuid
          AND lc.content_id IS NULL
        ORDER BY c.created_at
        LIMIT %s
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), limit))
            return [dict(r) for r in cur.fetchall()]


def count_user_content(user_id: str) -> int:
    """
    Return 1 if the user has any content items, 0 otherwise.

    The validator uses this only as a boolean gate (skip L2 validation when
    no content exists), so a single-item existence check is sufficient.
    Uses GraphQL: contents(first: 1).
    """
    try:
        data = gql(_CONTENTS_EXISTS_QUERY, {}, user_id)
        return len(data["contents"]["edges"])
    except GraphQLUnavailable:
        pass  # API_JWT_SECRET not set — expected in standalone / test runs
    except Exception as exc:
        log.warning("count_user_content via GraphQL failed: %s — falling back to SQL", exc)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM ci.content WHERE user_id = %s",
                (str(user_id),),
            )
            return cur.fetchone()[0]


# ── Summaries ─────────────────────────────────────────────────────────────────


def get_unlabeled_summaries(user_id: str, date_str: str) -> list[dict]:
    """
    Return hourly summaries for a date that have no hbpe.summary_l1_label entry.

    Keys: summary_id (str), period_start, content (dict with summary_text key)

    Uses GraphQL to read from ci.summaries, then checks hbpe.summary_l1_label
    (direct SQL — HBPE-owned table) to exclude already-labeled ones.
    """
    summaries = _fetch_summaries_for_date(user_id, date_str)
    if not summaries:
        return []

    labeled_ids = _get_labeled_summary_ids([s["summary_id"] for s in summaries])
    return [s for s in summaries if s["summary_id"] not in labeled_ids]


def get_labeled_summaries(user_id: str, date_str: str) -> list[dict]:
    """
    Return hourly summaries that have a hbpe.summary_l1_label entry.

    Keys: l0_class, l1_cluster_id (str), period_start

    Uses GraphQL to read from ci.summaries, then joins with hbpe.summary_l1_label
    (direct SQL — HBPE-owned table).
    """
    summaries = _fetch_summaries_for_date(user_id, date_str)
    if not summaries:
        return []

    summary_ids = [s["summary_id"] for s in summaries]
    labels = _get_summary_labels(summary_ids)

    period_by_id = {s["summary_id"]: s["period_start"] for s in summaries}

    results = [
        {
            "l0_class":       l0_class,
            "l1_cluster_id":  l1_cluster_id,
            "period_start":   period_by_id[sid],
        }
        for sid, (l0_class, l1_cluster_id) in labels.items()
    ]
    results.sort(key=lambda r: r["period_start"])
    return results


def _fetch_summaries_for_date(user_id: str, date_str: str) -> list[dict]:
    """
    Fetch hourly summaries for a given date via GraphQL.

    Paginates the summaries connection and filters client-side by date and
    period_type, since the summaries query has no filter arguments.
    Returns dicts with keys: summary_id, period_start, content.
    """
    target = date.fromisoformat(date_str)

    try:
        all_nodes = paginate(_SUMMARIES_QUERY, ["summaries"], {}, user_id)
    except GraphQLUnavailable:
        return _fetch_summaries_sql(user_id, date_str)
    except Exception as exc:
        log.warning("_fetch_summaries_for_date GraphQL failed: %s — falling back to SQL", exc)
        return _fetch_summaries_sql(user_id, date_str)

    result: list[dict] = []
    for node in all_nodes:
        if node.get("periodType") != "hourly":
            continue
        raw_ps = node["periodStart"]
        if isinstance(raw_ps, str):
            ps_dt = datetime.fromisoformat(raw_ps.replace("Z", "+00:00"))
        else:
            ps_dt = raw_ps
        if ps_dt.date() != target:
            continue
        result.append({
            "summary_id":   decode_gid(node["id"]),
            "period_start": ps_dt,
            # Wrap summaryText in the same dict shape the SQL path returned so
            # SummaryTokenizer._extract_summary_text() keeps working unchanged.
            "content":      {"summary_text": node.get("summaryText") or ""},
        })

    return result


def _fetch_summaries_sql(user_id: str, date_str: str) -> list[dict]:
    """SQL fallback for _fetch_summaries_for_date."""
    sql = """
        SELECT s.summary_id::text, s.period_start, s.content
        FROM ci.summaries s
        WHERE s.user_id     = %s::uuid
          AND s.period_type = 'hourly'
          AND s.period_start::date = %s::date
        ORDER BY s.period_start
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), date_str))
            return [dict(r) for r in cur.fetchall()]


def _get_labeled_summary_ids(summary_ids: list[str]) -> set[str]:
    """Return the subset of summary_ids already in hbpe.summary_l1_label."""
    if not summary_ids:
        return set()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT summary_id::text FROM hbpe.summary_l1_label "
                "WHERE summary_id = ANY(%s::uuid[])",
                (summary_ids,),
            )
            return {row[0] for row in cur.fetchall()}


def _get_summary_labels(summary_ids: list[str]) -> dict[str, tuple[str, Optional[str]]]:
    """Return {summary_id: (l0_class, l1_cluster_id)} for labeled summaries."""
    if not summary_ids:
        return {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT summary_id::text, l0_class, l1_cluster_id::text "
                "FROM hbpe.summary_l1_label WHERE summary_id = ANY(%s::uuid[])",
                (summary_ids,),
            )
            return {row[0]: (row[1], row[2]) for row in cur.fetchall()}


# ── Users ─────────────────────────────────────────────────────────────────────


def get_all_user_ids() -> list[str]:
    """
    Return all user IDs ordered by creation date.

    SQL rationale: the GraphQL API has no admin "list all users" query — only
    the ``me`` query which returns the currently-authenticated user.  In a
    multi-user deployment the Temporal schedule setup needs all user IDs, so
    SQL against ci.users is the only option.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id::text FROM ci.users ORDER BY created_at")
            return [row[0] for row in cur.fetchall()]


def get_first_user_id() -> Optional[str]:
    """
    Return the first available user ID.

    Bootstraps a user ID from ci.users (one SQL read), then verifies it via
    the GraphQL ``me`` query.  The SQL read is unavoidable: we need a user ID
    to sign the service JWT before we can call GraphQL at all.
    """
    uid = _bootstrap_user_id()
    if not uid:
        return None
    try:
        data = gql(_ME_QUERY, {}, uid)
        me = data.get("me")
        if me:
            return decode_gid(me["id"])
    except GraphQLUnavailable:
        pass  # expected when running standalone
    except Exception as exc:
        log.warning("get_first_user_id GraphQL verify failed: %s", exc)
    return uid


def _bootstrap_user_id() -> Optional[str]:
    """One-time SQL read to get a user ID for service JWT signing."""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM ci.users LIMIT 1")
                row = cur.fetchone()
                return str(row[0]) if row else None
    except Exception:
        return None
