"""Explicit current-schema projections used by hourly summaries.

Every exclusion predicate below is NULL-safe on purpose. The flags these
queries filter on -- ci.position.is_private, ci.communications.is_archived,
ci.messages.is_deleted, ci.browser_activity.is_incognito and
contains_sensitive, ci.answers.is_sensitive -- are all nullable in the live ci
schema, and `col = false` evaluates to NULL rather than true for a NULL row, so
a plain equality drops that row from every hourly summary and logs nothing.
Explicit NULLs do get written: bulk ingest paths enumerate columns and partial
upserts skip them, and the column default only applies when the column is
omitted. `col IS NOT TRUE` is used instead, so a NULL counts as "not excluded".

For the privacy flags that direction is the safe one, not the lazy one. These
columns default to false, so a NULL is an absent marking rather than an unknown
to be feared. The filter is prompt hygiene honouring an explicit "keep this
out" -- the summary is generated for, and read by, the same user who owns the
row, so failing open exposes nothing to anyone else, while failing closed
silently starves the summary. The introspection-based aggregator this registry
replaced applied no such filter at all, so every row excluded here is a new
exclusion; only an explicit `true` is a positive assertion of privacy, and only
that excludes.

ci.answers.answer_source is nullable for the same reason, and
`answer_source != 'inferred'` is NULL for a NULL source, so it uses
`IS DISTINCT FROM`. ci.events.is_deleted is NOT NULL, so its `= false` is
already total and stays as it is.
"""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SummarySource:
    """One bounded, user-scoped source of grounded summary material."""

    name: str
    query: str
    limit: int = 100


SUMMARY_SOURCES: tuple[SummarySource, ...] = (
    SummarySource(
        "position",
        """
        SELECT
            COALESCE(place.name, p.name, p.city, p.region, p.country, 'unknown') AS place,
            p.activity_type,
            p.source,
            COUNT(*) AS sample_count,
            MIN(p.time) AS first_seen_at,
            MAX(p.time) AS last_seen_at
        FROM ci.position p
        LEFT JOIN ci.entities place ON place.entity_id = p.location_entity_id
        WHERE p.user_id = :user_id
          AND p.time >= :start
          AND p.time < :end
          AND p.is_private IS NOT TRUE
        GROUP BY
            COALESCE(place.name, p.name, p.city, p.region, p.country, 'unknown'),
            p.activity_type,
            p.source
        ORDER BY MAX(p.time) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "communications",
        """
        SELECT
            LEFT(
                COALESCE(NULLIF(c.summary, ''), NULLIF(c.preview, ''), NULLIF(c.content, '')),
                1000
            ) AS text,
            c.subject,
            c.communication_type,
            c.direction,
            sender.name AS from_name,
            (
                SELECT ARRAY_AGG(recipient.name ORDER BY recipient.name)
                FROM UNNEST(c.to_entity_ids) AS recipient_id
                JOIN ci.entities recipient ON recipient.entity_id = recipient_id
            ) AS to_names,
            c.category,
            c.time AS occurred_at,
            c.duration_seconds,
            c.importance_score,
            c.urgency_score,
            c.source_system
        FROM ci.communications c
        LEFT JOIN ci.entities sender ON sender.entity_id = c.from_entity_id
        WHERE c.user_id = :user_id
          AND c.time >= :start
          AND c.time < :end
          AND c.is_archived IS NOT TRUE
        ORDER BY c.time DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "events",
        """
        SELECT
            base.name AS title,
            LEFT(base.description, 1000) AS description,
            ev.event_type,
            ev.start_time,
            ev.end_time,
            ev.location_name,
            ev.status,
            ev.is_all_day,
            ev.is_predicted,
            ev.is_inferred,
            ev.source_system,
            GREATEST(ev.created_at, ev.updated_at) AS changed_at
        FROM ci.events ev
        JOIN ci.entities base ON base.entity_id = ev.event_id
        WHERE ev.user_id = :user_id
          AND GREATEST(ev.created_at, ev.updated_at) >= :start
          AND GREATEST(ev.created_at, ev.updated_at) < :end
          AND ev.is_deleted = false
        ORDER BY GREATEST(ev.created_at, ev.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "messages",
        """
        SELECT
            LEFT(m.content, 1200) AS text,
            m.created_at,
            m.updated_at,
            m.thread_id
        FROM ci.messages m
        WHERE m.user_id = :user_id
          AND GREATEST(m.created_at, m.updated_at) >= :start
          AND GREATEST(m.created_at, m.updated_at) < :end
          AND m.role = 'user'
          AND m.is_deleted IS NOT TRUE
        ORDER BY GREATEST(m.created_at, m.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "files",
        """
        SELECT
            COALESCE(NULLIF(f.title, ''), f.filename) AS title,
            LEFT(f.description, 1000) AS description,
            f.content_type,
            f.variant,
            f.size,
            f.parse_status,
            f.created_at,
            f.updated_at,
            f.event_id
        FROM ci.files f
        WHERE f.user_id = :user_id
          AND GREATEST(f.created_at, f.updated_at) >= :start
          AND GREATEST(f.created_at, f.updated_at) < :end
          AND f.deleted_at IS NULL
        ORDER BY GREATEST(f.created_at, f.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "content",
        """
        SELECT
            base.name AS title,
            LEFT(c.text, 1200) AS text,
            c.type,
            c.mimetype,
            c.url,
            c.source_type,
            c.source_system,
            c.event_id,
            c.created_at,
            c.updated_at
        FROM ci.content c
        JOIN ci.entities base ON base.entity_id = c.id
        WHERE c.user_id = :user_id
          AND GREATEST(c.created_at, c.updated_at) >= :start
          AND GREATEST(c.created_at, c.updated_at) < :end
        ORDER BY GREATEST(c.created_at, c.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "file_chunks",
        """
        SELECT
            LEFT(fc.content, 1200) AS text,
            fc.section_title,
            f.title AS file_title,
            f.filename,
            fc.chunk_index,
            fc.created_at,
            fc.updated_at
        FROM ci.file_chunks fc
        JOIN ci.files f ON f.id = fc.file_id
        WHERE fc.user_id = :user_id
          AND GREATEST(fc.created_at, fc.updated_at) >= :start
          AND GREATEST(fc.created_at, fc.updated_at) < :end
          AND f.deleted_at IS NULL
        ORDER BY GREATEST(fc.created_at, fc.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "notes",
        """
        SELECT
            n.title,
            LEFT(n.content, 1200) AS text,
            n.created_at,
            n.updated_at
        FROM ci.notes n
        WHERE n.user_id = :user_id
          AND GREATEST(n.created_at, n.updated_at) >= :start
          AND GREATEST(n.created_at, n.updated_at) < :end
        ORDER BY GREATEST(n.created_at, n.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "tasks",
        """
        SELECT
            t.title,
            LEFT(t.description, 1000) AS description,
            LEFT(t.notes, 1000) AS notes,
            t.status,
            t.priority,
            t.due_at,
            t.scheduled_for,
            t.task_time,
            t.completed_at,
            t.source_kind,
            t.created_at,
            t.updated_at
        FROM ci.tasks t
        WHERE t.user_id = :user_id
          AND GREATEST(t.created_at, t.updated_at) >= :start
          AND GREATEST(t.created_at, t.updated_at) < :end
          AND t.status != 'archived'
        ORDER BY GREATEST(t.created_at, t.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "browser_activity",
        """
        SELECT
            b.title,
            LEFT(b.page_summary, 1000) AS page_summary,
            LEFT(b.url, 500) AS url,
            b.action_type,
            b.category,
            b.duration_seconds,
            b.productivity_score,
            b.time AS occurred_at,
            b.source_system
        FROM ci.browser_activity b
        WHERE b.user_id = :user_id
          AND b.time >= :start
          AND b.time < :end
          AND b.is_incognito IS NOT TRUE
          AND b.contains_sensitive IS NOT TRUE
        ORDER BY b.time DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "objects",
        """
        SELECT
            base.name,
            LEFT(base.description, 1000) AS description,
            obj.category,
            obj.subcategory,
            obj.brand,
            obj.model,
            obj.lifecycle_state,
            obj.condition,
            obj.quantity,
            obj.acquired_at,
            obj.last_used_at,
            obj.last_seen_at,
            obj.location_description,
            obj.storage_location,
            obj.identity_method,
            obj.identity_confidence,
            obj.created_at,
            obj.updated_at
        FROM ci.objects obj
        JOIN ci.entities base ON base.entity_id = obj.object_id
        WHERE obj.user_id = :user_id
          AND GREATEST(obj.created_at, obj.updated_at) >= :start
          AND GREATEST(obj.created_at, obj.updated_at) < :end
          AND obj.merged_into_object_id IS NULL
        ORDER BY GREATEST(obj.created_at, obj.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "object_observations",
        """
        SELECT
            obs.label,
            resolved.name AS resolved_object,
            obs.attributes,
            obs.observed_at,
            obs.source_kind,
            obs.label_source,
            obs.detection_confidence,
            obs.resolution_method,
            obs.resolution_confidence,
            obs.confirmed_by_user,
            obs.created_at,
            obs.updated_at
        FROM ci.object_observations obs
        LEFT JOIN ci.entities resolved ON resolved.entity_id = obs.resolved_object_id
        WHERE obs.user_id = :user_id
          AND GREATEST(obs.created_at, obs.updated_at) >= :start
          AND GREATEST(obs.created_at, obs.updated_at) < :end
        ORDER BY GREATEST(obs.created_at, obs.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "receipts",
        """
        SELECT
            r.merchant_name,
            r.purchased_at,
            r.currency,
            r.subtotal_minor,
            r.tax_minor,
            r.tip_minor,
            r.shipping_minor,
            r.discount_minor,
            r.total_minor,
            r.channel,
            r.extraction_state,
            r.extraction_confidence,
            r.created_at,
            r.updated_at
        FROM ci.receipts r
        WHERE r.user_id = :user_id
          AND GREATEST(r.created_at, r.updated_at) >= :start
          AND GREATEST(r.created_at, r.updated_at) < :end
        ORDER BY GREATEST(r.created_at, r.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "receipt_line_items",
        """
        SELECT
            li.description,
            li.brand,
            li.model_number,
            li.category,
            li.quantity,
            li.unit_price_minor,
            li.total_price_minor,
            li.currency,
            li.is_physical,
            receipt.merchant_name,
            receipt.purchased_at,
            li.created_at,
            li.updated_at
        FROM ci.receipt_line_items li
        JOIN ci.receipts receipt ON receipt.receipt_id = li.receipt_id
        WHERE li.user_id = :user_id
          AND GREATEST(li.created_at, li.updated_at) >= :start
          AND GREATEST(li.created_at, li.updated_at) < :end
        ORDER BY GREATEST(li.created_at, li.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "answers",
        """
        SELECT
            question.question_text,
            LEFT(answer.answer_text, 1200) AS answer_text,
            answer.answer_source,
            answer.answer_method,
            answer.answered_at,
            answer.emotional_state,
            answer.location_context,
            answer.sentiment_score,
            answer.created_at,
            answer.updated_at
        FROM ci.answers answer
        JOIN ci.questions question ON question.question_id = answer.question_id
        WHERE answer.user_id = :user_id
          AND GREATEST(answer.created_at, answer.updated_at) >= :start
          AND GREATEST(answer.created_at, answer.updated_at) < :end
          AND answer.is_sensitive IS NOT TRUE
          AND answer.answer_source IS DISTINCT FROM 'inferred'
        ORDER BY GREATEST(answer.created_at, answer.updated_at) DESC
        LIMIT :limit
        """,
    ),
    SummarySource(
        "tool_invocations",
        """
        SELECT
            invocation.intent,
            invocation.tool,
            invocation.domain,
            invocation.source,
            invocation.capability,
            invocation.access,
            invocation.external,
            invocation.destructive,
            invocation.outcome,
            invocation.error_code,
            invocation.duration_ms,
            invocation.occurred_at
        FROM ci.tool_invocations invocation
        WHERE invocation.user_id = :user_id
          AND invocation.occurred_at >= :start
          AND invocation.occurred_at < :end
        ORDER BY invocation.occurred_at DESC
        LIMIT :limit
        """,
    ),
)


__all__ = ["SUMMARY_SOURCES", "SummarySource"]
