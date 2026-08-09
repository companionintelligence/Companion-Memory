"""
Data aggregation for proactive insights generation.

Collects context from graph deltas, relationships, events, summaries,
and communications to enable LLM-powered insight generation.
"""

from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import structlog

from .database import db

logger = structlog.get_logger()


class InsightAggregator:
    """Aggregates context data for generating proactive insights."""

    def aggregate_insights_context(
        self,
        user_id: UUID,
        since: datetime,
        until: datetime | None = None,
    ) -> dict[str, Any]:
        """
        Aggregate all context needed for insight generation.

        Args:
            user_id: The user to generate insights for
            since: Start of the lookback window (for deltas, summaries, communications)
            until: End of the window (defaults to now)

        Returns:
            Dict containing all context for insight generation
        """
        until = until or datetime.utcnow()

        logger.info(
            "aggregating_insights_context",
            user_id=str(user_id),
            since=since.isoformat(),
            until=until.isoformat(),
        )

        context = {
            "user_id": str(user_id),
            "since": since.isoformat(),
            "until": until.isoformat(),
        }

        # Collect all context in parallel-ish fashion (sequential but fast)
        context["graph_deltas"] = self._get_graph_deltas(user_id, since, until)
        context["upcoming_events"] = self._get_upcoming_events(user_id, days=14)
        context["recent_summaries"] = self._get_recent_summaries(user_id, since, until)
        context["strongest_relationships"] = self._get_strongest_relationships(
            user_id, limit=3
        )
        context["recently_changed_relationships"] = (
            self._get_recently_changed_relationships(user_id, since, limit=5)
        )
        context["event_relevant_relationships"] = (
            self._get_event_relevant_relationships(user_id, days=14, limit=5)
        )
        context["recent_communications"] = self._get_recent_communications(
            user_id, since, until
        )
        context["user_dossier"] = self._get_user_dossier(user_id)

        # Log summary of what we collected
        logger.info(
            "insights_context_aggregated",
            user_id=str(user_id),
            graph_deltas=len(context["graph_deltas"]),
            upcoming_events=len(context["upcoming_events"]),
            recent_summaries=len(context["recent_summaries"]),
            strongest_relationships=len(context["strongest_relationships"]),
            recently_changed_relationships=len(
                context["recently_changed_relationships"]
            ),
            event_relevant_relationships=len(context["event_relevant_relationships"]),
            recent_communications=len(context["recent_communications"]),
            has_dossier=context["user_dossier"] is not None,
        )

        return context

    def has_new_data(self, user_id: UUID, since: datetime) -> bool:
        """
        Check if there's new data worth generating insights for.
        Returns True if there are new graph deltas, events, or summaries.
        """
        query = """
        SELECT EXISTS (
            SELECT 1 FROM ci.graph_deltas
            WHERE owner_user_id = :user_id AND changed_at >= :since
            LIMIT 1
        ) OR EXISTS (
            SELECT 1 FROM ci.summaries
            WHERE user_id = :user_id AND created_at >= :since AND period_type != 'insight'
            LIMIT 1
        ) OR EXISTS (
            SELECT 1 FROM ci.events
            WHERE user_id = :user_id AND created_at >= :since
            LIMIT 1
        ) as has_new_data
        """
        result = db.execute_query(query, {"user_id": str(user_id), "since": since})
        return result[0]["has_new_data"] if result else False

    def get_last_insight_time(self, user_id: UUID) -> datetime | None:
        """Get the timestamp of the last generated insight for this user."""
        query = """
        SELECT MAX(created_at) as last_insight
        FROM ci.summaries
        WHERE user_id = :user_id AND period_type = 'insight'
        """
        result = db.execute_query(query, {"user_id": str(user_id)})
        if result and result[0]["last_insight"]:
            return result[0]["last_insight"]
        return None

    def _get_graph_deltas(
        self, user_id: UUID, since: datetime, until: datetime
    ) -> list[dict[str, Any]]:
        """Get recent graph deltas (entity and relationship changes)."""
        query = """
        SELECT
            delta_id,
            entity_id,
            relationship_id,
            node_type,
            entity_type,
            relationship_type,
            from_entity_id,
            to_entity_id,
            change_type,
            changed_fields,
            change_reason,
            changed_at
        FROM ci.graph_deltas
        WHERE owner_user_id = :user_id
          AND changed_at >= :since
          AND changed_at < :until
        ORDER BY changed_at DESC
        LIMIT 50
        """
        return db.execute_query(
            query, {"user_id": str(user_id), "since": since, "until": until}
        )

    def _get_upcoming_events(
        self, user_id: UUID, days: int = 14
    ) -> list[dict[str, Any]]:
        """Get events in the next N days."""
        now = datetime.utcnow()
        future = now + timedelta(days=days)

        # title/description live on the event's CTI base row (ci.entities);
        # aliased back so downstream consumers keep their dict keys.
        query = """
        SELECT
            ev.event_id as id,
            b.name as title,
            b.description as description,
            ev.start_time,
            ev.end_time,
            ev.location_name as location,
            ev.participant_entity_ids as participants,
            ev.event_type,
            ev.is_all_day
        FROM ci.events ev
        JOIN ci.entities b ON b.entity_id = ev.event_id
        WHERE ev.user_id = :user_id
          AND ev.start_time >= :now
          AND ev.start_time < :future
          AND (ev.status IS NULL OR ev.status != 'cancelled')
        ORDER BY ev.start_time ASC
        LIMIT 20
        """
        return db.execute_query(
            query, {"user_id": str(user_id), "now": now, "future": future}
        )

    def _get_recent_summaries(
        self, user_id: UUID, since: datetime, until: datetime
    ) -> list[dict[str, Any]]:
        """Get recent activity summaries (excluding insights)."""
        query = """
        SELECT
            summary_id,
            period_type,
            period_start,
            period_end,
            title,
            content->>'summary_text' as summary_text,
            content->'key_insights' as key_insights,
            tags
        FROM ci.summaries
        WHERE user_id = :user_id
          AND created_at >= :since
          AND created_at < :until
          AND period_type != 'insight'
        ORDER BY period_end DESC
        LIMIT 10
        """
        return db.execute_query(
            query, {"user_id": str(user_id), "since": since, "until": until}
        )

    def _get_strongest_relationships(
        self, user_id: UUID, limit: int = 3
    ) -> list[dict[str, Any]]:
        """Get top relationships by strength."""
        query = """
        SELECT
            r.relationship_id,
            r.relationship_type,
            r.strength,
            r.from_entity_id,
            r.to_entity_id,
            e.name,
            e.entity_type,
            e.description
        FROM ci.relationships r
        JOIN ci.entities e ON e.entity_id = r.to_entity_id
        WHERE r.owner_user_id = :user_id
          AND r.is_active = true
          AND e.entity_type = 'Person'
        ORDER BY r.strength DESC
        LIMIT :limit
        """
        return db.execute_query(query, {"user_id": str(user_id), "limit": limit})

    def _get_recently_changed_relationships(
        self, user_id: UUID, since: datetime, limit: int = 5
    ) -> list[dict[str, Any]]:
        """Get relationships that were recently created or modified (from graph_deltas)."""
        query = """
        SELECT DISTINCT ON (d.relationship_id)
            d.relationship_id,
            d.relationship_type,
            d.change_type,
            d.changed_at,
            d.changed_fields,
            e.entity_id,
            e.name,
            e.entity_type
        FROM ci.graph_deltas d
        LEFT JOIN ci.relationships r ON r.relationship_id = d.relationship_id
        LEFT JOIN ci.entities e ON e.entity_id = r.to_entity_id
        WHERE d.owner_user_id = :user_id
          AND d.node_type = 'relationship'
          AND d.changed_at >= :since
        ORDER BY d.relationship_id, d.changed_at DESC
        LIMIT :limit
        """
        return db.execute_query(
            query, {"user_id": str(user_id), "since": since, "limit": limit}
        )

    def _get_event_relevant_relationships(
        self, user_id: UUID, days: int = 14, limit: int = 5
    ) -> list[dict[str, Any]]:
        """Get relationships to people connected to upcoming events."""
        now = datetime.utcnow()
        future = now + timedelta(days=days)

        # This query finds people who are participants in upcoming events
        # The event's title lives on its CTI base row (ci.entities), joined as
        # ev_base alongside the participant join.
        query = """
        SELECT DISTINCT ON (e.entity_id)
            e.entity_id,
            e.name,
            e.entity_type,
            ev_base.name as event_title,
            ev.start_time as event_start,
            r.relationship_type,
            r.strength
        FROM ci.events ev
        JOIN ci.entities ev_base ON ev_base.entity_id = ev.event_id
        CROSS JOIN LATERAL unnest(ev.participant_entity_ids) as participant_id
        JOIN ci.entities e ON e.entity_id = participant_id::uuid
        LEFT JOIN ci.relationships r ON r.to_entity_id = e.entity_id
            AND r.owner_user_id = :user_id
        WHERE ev.user_id = :user_id
          AND ev.start_time >= :now
          AND ev.start_time < :future
          AND e.entity_type = 'Person'
        ORDER BY e.entity_id, ev.start_time ASC
        LIMIT :limit
        """
        try:
            return db.execute_query(
                query,
                {"user_id": str(user_id), "now": now, "future": future, "limit": limit},
            )
        except Exception as exc:
            # If participants array join fails, return empty
            logger.warning("event_relevant_relationships_query_failed", error=str(exc))
            return []

    def _get_recent_communications(
        self, user_id: UUID, since: datetime, until: datetime
    ) -> list[dict[str, Any]]:
        """Get recent communications (emails, messages, etc.)."""
        query = """
        SELECT
            id,
            subject,
            communication_type,
            direction,
            time,
            from_entity_id,
            to_entity_ids
        FROM ci.communications
        WHERE user_id = :user_id
          AND time >= :since
          AND time < :until
        ORDER BY time DESC
        LIMIT 20
        """
        return db.execute_query(
            query, {"user_id": str(user_id), "since": since, "until": until}
        )

    def _get_user_dossier(self, user_id: UUID) -> dict[str, Any] | None:
        """Get the user's dossier from their entity record."""
        # First, get the user's entity_id from the users table
        user_query = """
        SELECT entity_id FROM ci.users WHERE id = :user_id
        """
        user_result = db.execute_query(user_query, {"user_id": str(user_id)})

        if not user_result or not user_result[0].get("entity_id"):
            return None

        entity_id = user_result[0]["entity_id"]

        # Then get the dossier from the entity
        dossier_query = """
        SELECT dossier FROM ci.entities WHERE entity_id = :entity_id
        """
        dossier_result = db.execute_query(dossier_query, {"entity_id": str(entity_id)})

        if dossier_result and dossier_result[0].get("dossier"):
            return dossier_result[0]["dossier"]

        return None


# Global instance
insight_aggregator = InsightAggregator()

__all__ = ["InsightAggregator", "insight_aggregator"]
