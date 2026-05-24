"""
Data aggregation for proactive action generation.

Collects context from summaries, insights, events, and user dossier
to enable LLM-powered action card generation.

Actions are different from insights:
- Insights are observations about patterns and connections
- Actions are conversation starters and proactive suggestions for the user's time
"""
import structlog
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
from uuid import UUID

from .database import db

logger = structlog.get_logger()


class ActionAggregator:
    """Aggregates context data for generating proactive action cards."""

    def aggregate_action_context(
        self,
        user_id: UUID,
        lookback_days: int = 7,
    ) -> Dict[str, Any]:
        """
        Aggregate context needed for action generation.

        Unlike insights which look at raw data changes, actions are built from
        higher-level summaries and insights to suggest conversation topics
        and time management ideas.

        Args:
            user_id: The user to generate actions for
            lookback_days: How many days of summaries/insights to consider

        Returns:
            Dict containing context for action generation
        """
        now = datetime.utcnow()
        since = now - timedelta(days=lookback_days)

        logger.info(
            "aggregating_action_context",
            user_id=str(user_id),
            lookback_days=lookback_days,
        )

        context = {
            "user_id": str(user_id),
            "generated_at": now.isoformat(),
        }

        # Get user profile for personalization
        context["user_dossier"] = self._get_user_dossier(user_id)

        # Get recent summaries (daily, weekly) for context on what's been happening
        context["recent_summaries"] = self._get_recent_summaries(user_id, since)

        # Get recent insights for topics that are already identified as interesting
        context["recent_insights"] = self._get_recent_insights(user_id, since)

        # Get upcoming events for time-relevant suggestions
        context["upcoming_events"] = self._get_upcoming_events(user_id, days=7)

        # Get key people (strongest relationships) for conversation suggestions
        context["key_people"] = self._get_key_people(user_id, limit=5)

        # Log summary of what we collected
        logger.info(
            "action_context_aggregated",
            user_id=str(user_id),
            recent_summaries=len(context["recent_summaries"]),
            recent_insights=len(context["recent_insights"]),
            upcoming_events=len(context["upcoming_events"]),
            key_people=len(context["key_people"]),
            has_dossier=context["user_dossier"] is not None,
        )

        return context

    def _get_user_dossier(self, user_id: UUID) -> Optional[Dict[str, Any]]:
        """Get the user's dossier from their entity record."""
        user_query = """
        SELECT entity_id FROM ci.users WHERE id = :user_id
        """
        user_result = db.execute_query(user_query, {"user_id": str(user_id)})

        if not user_result or not user_result[0].get("entity_id"):
            return None

        entity_id = user_result[0]["entity_id"]

        dossier_query = """
        SELECT dossier FROM ci.entities WHERE entity_id = :entity_id
        """
        dossier_result = db.execute_query(dossier_query, {"entity_id": str(entity_id)})

        if dossier_result and dossier_result[0].get("dossier"):
            return dossier_result[0]["dossier"]

        return None

    def _get_recent_summaries(
        self, user_id: UUID, since: datetime
    ) -> List[Dict[str, Any]]:
        """Get recent daily and weekly summaries."""
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
          AND period_type IN ('daily', 'weekly', 'hourly')
        ORDER BY period_end DESC
        LIMIT 15
        """
        return db.execute_query(query, {"user_id": str(user_id), "since": since})

    def _get_recent_insights(
        self, user_id: UUID, since: datetime
    ) -> List[Dict[str, Any]]:
        """Get recent insights that were generated."""
        query = """
        SELECT
            summary_id,
            title,
            content->>'summary_text' as insight_text,
            content->'key_actions' as suggested_actions,
            tags,
            created_at
        FROM ci.summaries
        WHERE user_id = :user_id
          AND created_at >= :since
          AND period_type = 'insight'
        ORDER BY created_at DESC
        LIMIT 10
        """
        return db.execute_query(query, {"user_id": str(user_id), "since": since})

    def _get_upcoming_events(self, user_id: UUID, days: int = 7) -> List[Dict[str, Any]]:
        """Get events in the next N days."""
        now = datetime.utcnow()
        future = now + timedelta(days=days)

        query = """
        SELECT
            event_id as id,
            title,
            description,
            start_time,
            end_time,
            location_name as location,
            event_type,
            is_all_day
        FROM ci.events
        WHERE user_id = :user_id
          AND start_time >= :now
          AND start_time < :future
          AND (status IS NULL OR status != 'cancelled')
        ORDER BY start_time ASC
        LIMIT 10
        """
        return db.execute_query(
            query, {"user_id": str(user_id), "now": now, "future": future}
        )

    def _get_key_people(self, user_id: UUID, limit: int = 5) -> List[Dict[str, Any]]:
        """Get the user's key relationships for conversation suggestions."""
        query = """
        SELECT
            e.entity_id,
            e.name,
            e.description,
            r.relationship_type,
            r.strength
        FROM ci.relationships r
        JOIN ci.entities e ON e.entity_id = r.to_entity_id
        WHERE r.owner_user_id = :user_id
          AND r.is_active = true
          AND e.entity_type = 'Person'
        ORDER BY r.strength DESC
        LIMIT :limit
        """
        return db.execute_query(query, {"user_id": str(user_id), "limit": limit})


# Global instance
action_aggregator = ActionAggregator()

__all__ = ["action_aggregator", "ActionAggregator"]
