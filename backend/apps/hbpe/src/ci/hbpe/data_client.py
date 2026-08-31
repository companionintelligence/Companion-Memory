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

import psycopg2
import psycopg2.errors
import psycopg2.extras

from ci.hbpe.buckets import BUCKET_SECONDS, MAX_BUCKET_INDEX
from ci.hbpe.database import get_conn
from ci.hbpe.graphql_client import GraphQLUnavailable, decode_gid, gql, paginate

log = logging.getLogger(__name__)

# Circuit-breaker: once a connection-level failure is seen, skip GraphQL for
# the remainder of the process rather than retrying on every date.
_graphql_unreachable: bool = False


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

# Deploy-skew guard for the events CTI migration: once verified ready, the
# probe is skipped for the remainder of the process.
_events_cti_ready: bool = False


def _ensure_events_cti_schema(conn) -> None:
    """
    Refuse to run the CTI-shaped event queries against a pre-migration schema.

    The sidecar deploys separately from the API, so a window exists where this
    code runs before the events CTI migration (20260811061409) has been
    applied.  In that state the base-row JOIN in get_unlabeled_events matches
    nothing (no 'Event' rows exist in ci.entities yet) and labeling would
    silently stall, returning [] with no error signal.  Detect the stale
    schema (ci.events still carrying its pre-CTI title column) and fail
    loudly instead.
    """
    global _events_cti_ready
    if _events_cti_ready:
        return
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'ci' AND table_name = 'events' AND column_name = 'title'
            """
        )
        if cur.fetchone() is not None:
            raise RuntimeError(
                "ci.events still has a title column: the events CTI migration "
                "(20260811061409) has not been applied to this database. "
                "Refusing to query a pre-migration schema. Run the API "
                "migrations, then restart the HBPE sidecar."
            )
    _events_cti_ready = True


def _unlabeled_events_where(
    user_id: str,
    since: datetime | None,
    before: datetime | None,
) -> tuple[str, list]:
    """
    Build the shared WHERE clause for the unlabeled-event queries.

    ``since`` / ``before`` are half-open (``>= since``, ``< before``) so two
    calls carrying the same boundary partition the set exactly: no row is
    visible to both phases of the drain, and no row falls between them.

    The bounds are bound as ``%s::timestamptz`` rather than compared against a
    bare date literal on purpose. Comparing a timestamptz to a date casts using
    the *session* TimeZone; the container happens to run Etc/UTC today, but an
    appliance deployed with any other TimeZone would silently shift the window
    off the one hbpe.pipeline.recurrence computes in UTC.
    """
    from ci.hbpe.tokenizer.static_labeler import mapped_kind_sql

    params: list = [str(user_id)]
    window = ""
    if since is not None:
        window += "\n          AND e.start_time >= %s::timestamptz"
        params.append(since)
    if before is not None:
        window += "\n          AND e.start_time <  %s::timestamptz"
        params.append(before)

    where = f"""WHERE e.user_id    = %s::uuid
          AND e.is_deleted = FALSE
          AND e.event_type IS DISTINCT FROM 'planned_block'
          AND ec.event_id  IS NULL
          AND e.start_time >= '2010-01-01'::timestamptz
          AND NOT ({mapped_kind_sql()}){window}"""
    return where, params


def get_unlabeled_events(
    user_id: str,
    limit: int = 1000,
    after_start: datetime | None = None,
    after_id: str | None = None,
    *,
    since: datetime | None = None,
    before: datetime | None = None,
    newest_first: bool = False,
) -> list[dict]:
    """
    Return events that have no entry in hbpe.l1_event_cluster.

    Kinds present in hbpe.kind_l0_map are excluded — the static labeler owns
    those. Keyset (start_time, event_id) pages the drain loop.

    ``since`` / ``before`` bound the window (half-open, see
    ``_unlabeled_events_where``); ``newest_first`` flips the scan to descending.
    The nightly drain uses those to label the recency window that the
    recurrence profiler actually reads *before* the historical backfill — see
    ``ci.hbpe.pipeline.nightly_runner.label_unlabeled``. Defaults reproduce the
    original oldest-first full-history query, so existing callers are unchanged.

    The ORDER BY must stay the *full composite* in a *single* direction, and the
    keyset comparison must point the same way (``>`` for ASC, ``<`` for DESC).
    Real corpora contain exact duplicate start_times (this dev database has two
    reddit events at 2026-08-30 08:38:22.313+00); ordering by start_time alone,
    or mixing directions between the two clauses, makes the keyset skip rows —
    they are then never labeled, with no error signal anywhere.

    Keys: event_id (str), title (str|None), description (str|None)
    """
    where, params = _unlabeled_events_where(user_id, since, before)

    keyset = ""
    if after_start is not None and after_id:
        cmp = "<" if newest_first else ">"
        keyset = f"AND (e.start_time, e.event_id) {cmp} (%s::timestamptz, %s::uuid)"
        params.extend([after_start, after_id])
    params.append(limit)

    order = (
        "ORDER BY e.start_time DESC, e.event_id DESC"
        if newest_first
        else "ORDER BY e.start_time, e.event_id"
    )

    sql = f"""
        SELECT e.event_id::text, e.start_time, b.name AS title, b.description AS description
        FROM ci.events e
        JOIN ci.entities b ON b.entity_id = e.event_id
        LEFT JOIN hbpe.l1_event_cluster ec ON ec.event_id = e.event_id
        {where}
          {keyset}
        {order}
        LIMIT %s
    """
    with get_conn() as conn:
        _ensure_events_cti_schema(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
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

    The kind_l0_map lookup is a LATERAL ... LIMIT 1, not a plain LEFT JOIN, for
    two independent reasons. It joins on ``metadata->>'kind'`` because that is
    the vocabulary the map is keyed on (see static_labeler.KIND_EXPR); and it
    takes only the longest — i.e. most specific — matching pattern because the
    map is explicitly allowed to hold overlapping ones (``load_kind_map``
    already orders longest-first so the claim loop resolves them that way). A
    plain LEFT JOIN would instead emit the event once per matching pattern, so
    adding e.g. a ``social.post`` row beside the existing ``social.%`` would
    silently double every Instagram post's tokens for that bucket.
    """
    # Imported here, not at module scope, for the same reason
    # _unlabeled_events_where does: static_labeler imports vocab_registry,
    # which imports this module.
    from ci.hbpe.tokenizer.static_labeler import KIND_EXPR

    sql = f"""
        WITH day_events AS (
            SELECT
                e.event_id,
                e.start_time,
                e.end_time,
                e.priority,
                COALESCE(m.tier, cl1.tier, 'anchor') AS tier,
                COALESCE(m.default_duration_min, 5) AS default_duration_min,
                EXTRACT(epoch FROM (e.start_time - date_trunc('day', e.start_time))) / 60.0
                    AS start_min,
                EXTRACT(epoch FROM (e.end_time - date_trunc('day', e.start_time))) / 60.0
                    AS end_min,
                EXTRACT(epoch FROM (e.start_time - date_trunc('day', e.start_time))) / {BUCKET_SECONDS}
                    AS bucket_idx_raw,
                cl1.l0_class          AS l0_class,
                ec.cluster_id::text   AS l1_cluster_id,
                ec.similarity         AS l1_sim
            FROM ci.events e
            JOIN hbpe.l1_event_cluster ec  ON ec.event_id   = e.event_id
            JOIN hbpe.l1_clusters      cl1 ON cl1.cluster_id = ec.cluster_id
            LEFT JOIN LATERAL (
                SELECT km.tier, km.default_duration_min
                FROM hbpe.kind_l0_map km
                WHERE {KIND_EXPR} LIKE km.kind_pattern
                ORDER BY length(km.kind_pattern) DESC
                LIMIT 1
            ) m ON TRUE
            WHERE e.user_id    = %s
              AND e.is_deleted = FALSE
              AND e.event_type IS DISTINCT FROM 'planned_block'
              AND e.start_time >= %s::date
              AND e.start_time <  (%s::date + INTERVAL '1 day')
              AND e.start_time >= '2010-01-01'::timestamptz
            ORDER BY e.start_time
        )
        SELECT
            de.l0_class,
            de.l1_cluster_id,
            de.l1_sim,
            de.tier,
            de.start_min,
            de.end_min,
            de.default_duration_min,
            de.priority,
            LEAST(GREATEST(de.bucket_idx_raw::int, 0), {MAX_BUCKET_INDEX}) AS bucket_idx,
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


def get_completed_tasks_for_day(user_id: str, date_str: str) -> list[dict]:
    """
    Done tasks with an L0 class, occurring at completed_at on date_str.

    Open/scheduled tasks are reconciliation-only and never become tokens.

    Raises on a read failure rather than returning []. The sole caller
    (serializer._fetch_tokens_for_day) still treats the failure as non-fatal,
    but it has to be able to tell "no completed tasks" from "could not read
    the completed tasks" before it deletes a day's token stream.
    """
    sql = """
        SELECT
            t.l0_class,
            t.l1_cluster_id::text AS l1_cluster_id,
            1.0 AS l1_sim,
            'anchor' AS tier,
            EXTRACT(epoch FROM (t.completed_at - date_trunc('day', t.completed_at))) / 60.0
                AS start_min,
            EXTRACT(epoch FROM (t.completed_at - date_trunc('day', t.completed_at))) / 60.0
                + COALESCE(NULLIF(t.actual_minutes, 0), t.estimated_minutes, 15)
                AS end_min,
            COALESCE(NULLIF(t.actual_minutes, 0), t.estimated_minutes, 15) AS default_duration_min,
            t.priority,
            NULL::text AS l2_cluster_id,
            NULL::float AS l2_sim
        FROM ci.tasks t
        WHERE t.user_id = %s::uuid
          AND t.status = 'done'
          AND t.completed_at >= %s::date
          AND t.completed_at < (%s::date + INTERVAL '1 day')
          AND t.l0_class IS NOT NULL
          AND t.l0_class <> 'UNKNOWN'
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), date_str, date_str))
            return [dict(r) for r in cur.fetchall()]


# ── Content ───────────────────────────────────────────────────────────────────


def get_unlabeled_content(user_id: str, limit: int = 1000) -> list[dict]:
    """
    Return content items that have no entry in hbpe.l2_content_cluster.

    Keys: content_id (str), title (str|None), content_type (str|None)

    SQL rationale: same bulk-query reasoning as get_unlabeled_events.
    """
    sql = """
        SELECT c.id::text AS content_id, e.name AS title, c.type AS content_type
        FROM ci.content c
        JOIN ci.entities e ON e.entity_id = c.id
        LEFT JOIN hbpe.l2_content_cluster lc ON lc.content_id = c.id
        WHERE c.user_id     = %s::uuid
          AND lc.content_id IS NULL
          AND c.created_at >= '2010-01-01'::timestamptz
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
        log.warning(
            "count_user_content via GraphQL failed: %s — falling back to SQL", exc
        )
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
            "l0_class": l0_class,
            "l1_cluster_id": l1_cluster_id,
            "period_start": period_by_id[sid],
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
    global _graphql_unreachable
    target = date.fromisoformat(date_str)

    if _graphql_unreachable:
        return _fetch_summaries_sql(user_id, date_str)

    try:
        all_nodes = paginate(_SUMMARIES_QUERY, ["summaries"], {}, user_id)
    except GraphQLUnavailable:
        return _fetch_summaries_sql(user_id, date_str)
    except Exception as exc:
        log.warning(
            "_fetch_summaries_for_date GraphQL failed: %s — falling back to SQL for remainder of run",
            exc,
        )
        _graphql_unreachable = True
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
        result.append(
            {
                "summary_id": decode_gid(node["id"]),
                "period_start": ps_dt,
                # Wrap summaryText in the same dict shape the SQL path returned so
                # SummaryTokenizer._extract_summary_text() keeps working unchanged.
                "content": {"summary_text": node.get("summaryText") or ""},
            }
        )

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


def _get_summary_labels(summary_ids: list[str]) -> dict[str, tuple[str, str | None]]:
    """Return {summary_id: (l0_class, l1_cluster_id)} for labeled summaries."""
    if not summary_ids:
        return {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT sl.summary_id::text, sl.l0_class, sl.l1_cluster_id::text
                FROM hbpe.summary_l1_label sl
                LEFT JOIN hbpe.l1_clusters c ON c.cluster_id = sl.l1_cluster_id
                WHERE sl.summary_id = ANY(%s::uuid[])
                  AND sl.l0_class IS DISTINCT FROM 'UNKNOWN'
                  AND (sl.l1_cluster_id IS NULL OR c.is_active)
                """,
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
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id::text FROM ci.users ORDER BY created_at")
                return [row[0] for row in cur.fetchall()]
    except psycopg2.errors.UndefinedTable:
        log.warning(
            "ci.users does not exist yet (migrations pending) — yielding 0 users"
        )
        return []


def get_first_user_id() -> str | None:
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


def _bootstrap_user_id() -> str | None:
    """One-time SQL read to get a user ID for service JWT signing."""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM ci.users LIMIT 1")
                row = cur.fetchone()
                return str(row[0]) if row else None
    except Exception:
        return None
