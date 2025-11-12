"""Storage helpers for summaries."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional, Sequence
from datetime import datetime

import structlog

from .config import settings
from .database import db

logger = structlog.get_logger()


@dataclass
class SummaryMetadata:
    timezone: str = "UTC"
    source_types: Sequence[str] = field(default_factory=lambda: ["memory"])
    structured_context: Optional[Dict[str, Any]] = None
    tags: Optional[Iterable[str]] = None
    participants: Optional[Sequence[str]] = None
    related_goal_ids: Optional[Sequence[str]] = None
    related_activity_ids: Optional[Sequence[str]] = None
    related_habit_ids: Optional[Sequence[str]] = None
    related_entity_ids: Optional[Sequence[str]] = None
    related_document_ids: Optional[Sequence[str]] = None
    related_communication_ids: Optional[Sequence[str]] = None
    related_file_ids: Optional[Sequence[str]] = None
    related_event_ids: Optional[Sequence[str]] = None
    metadata: Optional[Dict[str, Any]] = None


class SummaryStorage:
    """Stores summaries as entities and in relational tables."""

    def store_summary(
        self,
        user_id: uuid.UUID,
        summary_data: Dict[str, Any],
        start_time: datetime,
        end_time: datetime,
        metadata: Optional[SummaryMetadata] = None,
    ) -> uuid.UUID:
        """
        Store a summary as an entity in the knowledge graph.
        
        Args:
            user_id: User UUID
            summary_data: Summary dictionary from summarizer
            start_time: Start time of period
            end_time: End time of period
        
        Returns:
            Entity ID of created summary
        """
        summary_type = summary_data['summary_type']
        entity_type = f"{summary_type.capitalize()}Summary"  # HourlySummary, DailySummary, etc.

        entity_id = uuid.uuid4()
        summary_metadata = metadata or SummaryMetadata()
        
        # Build properties JSONB
        properties = {
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "summary_text": summary_data['summary_text'],
            "summary_type": summary_type,
            "activity_counts": summary_data['activity_counts'],
            "tokens_used": summary_data.get('tokens_used', 0),
        }
        
        # Add type-specific properties
        if 'key_insights' in summary_data:
            properties['key_insights'] = summary_data['key_insights']
        if 'notable_events' in summary_data:
            properties['notable_events'] = summary_data['notable_events']
        if 'anomalies' in summary_data:
            properties['anomalies'] = summary_data['anomalies']
        if 'num_hourly_summaries' in summary_data:
            properties['num_hourly_summaries'] = summary_data['num_hourly_summaries']
        if 'num_daily_summaries' in summary_data:
            properties['num_daily_summaries'] = summary_data['num_daily_summaries']
        
        # Create the entity
        db.execute_write(
            """
            INSERT INTO entities (
                entity_id, entity_type, owner_user_id, name, description,
                properties, embedding, search_content, created_at, updated_at
            ) VALUES (
                :entity_id, :entity_type, :user_id, :name, :description,
                CAST(:properties AS jsonb), CAST(:embedding AS vector), :search_content, NOW(), NOW()
            )
            """,
            {
                "entity_id": entity_id,
                "entity_type": entity_type,
                "user_id": user_id,
                "name": f"{summary_type.capitalize()} Summary: {start_time.strftime('%Y-%m-%d %H:%M')}",
                "description": summary_data['summary_text'][:500],  # Truncated for description
                "properties": json.dumps(properties),
                "embedding": json.dumps(summary_data['embedding']),
                "search_content": summary_data['summary_text'],
            }
        )

        self._insert_relational_summary(
            user_id=user_id,
            summary_data=summary_data,
            start_time=start_time,
            end_time=end_time,
            metadata=summary_metadata,
        )

        logger.info("summary_stored",
                   entity_id=str(entity_id),
                   entity_type=entity_type,
                   user_id=str(user_id))

        return entity_id
    
    def link_to_parent_summary(self, 
                               child_summary_id: uuid.UUID,
                               parent_summary_id: uuid.UUID,
                               user_id: uuid.UUID):
        """
        Create a relationship between a child summary and parent summary.
        E.g., hourly -> daily, daily -> weekly
        """
        relationship_id = uuid.uuid4()
        
        db.execute_write(
            """
            INSERT INTO relationships (
                relationship_id, from_entity_id, to_entity_id, relationship_type,
                owner_user_id, strength, properties, created_at, updated_at
            ) VALUES (
                :relationship_id, :from_entity_id, :to_entity_id, 'SUMMARIZED_BY',
                :user_id, 1.0, '{}'::jsonb, NOW(), NOW()
            )
            """,
            {
                "relationship_id": relationship_id,
                "from_entity_id": child_summary_id,
                "to_entity_id": parent_summary_id,
                "user_id": user_id,
            }
        )
        
        logger.info("summary_relationship_created",
                   child_id=str(child_summary_id),
                   parent_id=str(parent_summary_id))
    
    def get_hourly_summaries(self, 
                            user_id: uuid.UUID,
                            start_time: datetime,
                            end_time: datetime) -> list:
        """Retrieve hourly summaries for a time period."""
        results = db.execute_query(
            """
            SELECT entity_id, properties, embedding
            FROM entities
            WHERE owner_user_id = :user_id
              AND entity_type = 'HourlySummary'
              AND (properties->>'start_time')::timestamptz >= :start_time
              AND (properties->>'start_time')::timestamptz < :end_time
            ORDER BY (properties->>'start_time')::timestamptz
            """,
            {
                "user_id": user_id,
                "start_time": start_time,
                "end_time": end_time,
            }
        )
        
        # Parse properties JSON
        for r in results:
            if isinstance(r['properties'], str):
                import json
                r['properties'] = json.loads(r['properties'])

        return results

    # ------------------------------------------------------------------
    # Relational storage helpers
    # ------------------------------------------------------------------
    def _insert_relational_summary(
        self,
        user_id: uuid.UUID,
        summary_data: Dict[str, Any],
        start_time: datetime,
        end_time: datetime,
        metadata: SummaryMetadata,
        title: Optional[str] = None,
    ) -> None:
        summary_id = uuid.uuid4()
        params = {
            "summary_id": str(summary_id),
            "user_id": str(user_id),
            "period_start": start_time,
            "period_end": end_time,
            "period_type": summary_data['summary_type'],
            "timezone": metadata.timezone,
            "source_types": list(metadata.source_types) or ["memory"],
            "title": title or f"{summary_data['summary_type'].capitalize()} Summary",
            "content": summary_data['summary_text'],
            "structured_context": self._to_json(metadata.structured_context or {}),
            "tags": self._to_json(list(metadata.tags) if metadata.tags is not None else []),
            "participants": self._to_uuid_array(metadata.participants),
            "related_goal_ids": self._to_uuid_array(metadata.related_goal_ids),
            "related_activity_ids": self._to_uuid_array(metadata.related_activity_ids),
            "related_habits_ids": self._to_uuid_array(metadata.related_habit_ids),
            "related_entities_ids": self._to_uuid_array(metadata.related_entity_ids),
            "related_documents_ids": self._to_uuid_array(metadata.related_document_ids),
            "related_communications_ids": self._to_uuid_array(metadata.related_communication_ids),
            "related_files_ids": self._to_uuid_array(metadata.related_file_ids),
            "related_events_ids": self._to_uuid_array(metadata.related_event_ids),
            "confidence_score": summary_data.get('confidence_score', 1.0),
            "summary_embedding": json.dumps(summary_data.get('embedding', [])),
            "metadata": self._to_json(metadata.metadata or {}),
        }

        db.execute_write(
            """
            INSERT INTO summaries (
                summary_id,
                user_id,
                period_start,
                period_end,
                period_type,
                timezone,
                source_types,
                title,
                content,
                structured_context,
                tags,
                participants,
                related_goal_ids,
                related_activity_ids,
                related_habits_ids,
                related_entities_ids,
                related_documents_ids,
                related_communications_ids,
                related_files_ids,
                related_events_ids,
                confidence_score,
                summary_embedding,
                metadata,
                created_at,
                updated_at
            ) VALUES (
                :summary_id,
                :user_id,
                :period_start,
                :period_end,
                :period_type,
                :timezone,
                :source_types,
                :title,
                :content,
                CAST(:structured_context AS jsonb),
                CAST(:tags AS jsonb),
                :participants,
                :related_goal_ids,
                :related_activity_ids,
                :related_habits_ids,
                :related_entities_ids,
                :related_documents_ids,
                :related_communications_ids,
                :related_files_ids,
                :related_events_ids,
                :confidence_score,
                CAST(:summary_embedding AS vector),
                CAST(:metadata AS jsonb),
                NOW(),
                NOW()
            )
            """,
            params,
        )

    def _to_uuid_array(self, values: Optional[Sequence[str]]) -> Optional[list[str]]:
        if not values:
            return None
        return [str(v) for v in values]

    def _to_json(self, data: Any) -> str:
        return json.dumps(data, default=self._json_default)

    def _json_default(self, obj: Any):
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, uuid.UUID):
            return str(obj)
        return str(obj)
    
    def get_daily_summaries(self,
                           user_id: uuid.UUID,
                           start_time: datetime,
                           end_time: datetime) -> list:
        """Retrieve daily summaries for a time period."""
        results = db.execute_query(
            """
            SELECT entity_id, properties, embedding
            FROM entities
            WHERE owner_user_id = :user_id
              AND entity_type = 'DailySummary'
              AND (properties->>'start_time')::timestamptz >= :start_time
              AND (properties->>'start_time')::timestamptz < :end_time
            ORDER BY (properties->>'start_time')::timestamptz
            """,
            {
                "user_id": user_id,
                "start_time": start_time,
                "end_time": end_time,
            }
        )
        
        # Parse properties JSON
        for r in results:
            if isinstance(r['properties'], str):
                import json
                r['properties'] = json.loads(r['properties'])
        
        return results


# Global storage instance
storage = SummaryStorage()

__all__ = ["storage", "SummaryStorage", "SummaryMetadata"]
