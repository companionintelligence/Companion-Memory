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
    """Stores summaries in the relational summaries table."""

    def store_summary(
        self,
        user_id: uuid.UUID,
        summary_data: Dict[str, Any],
        start_time: datetime,
        end_time: datetime,
        metadata: Optional[SummaryMetadata] = None,
    ) -> uuid.UUID:
        """Persist a summary and return its summary_id."""
        summary_metadata = metadata or SummaryMetadata()

        summary_id = self._insert_relational_summary(
            user_id=user_id,
            summary_data=summary_data,
            start_time=start_time,
            end_time=end_time,
            metadata=summary_metadata,
        )

        logger.info(
            "summary_stored",
            summary_id=str(summary_id),
            summary_type=summary_data['summary_type'],
            user_id=str(user_id),
        )

        return summary_id
    
    def get_hourly_summaries(self,
                             user_id: uuid.UUID,
                             start_time: datetime,
                             end_time: datetime) -> list:
        """Retrieve hourly summaries from the summaries table."""
        results = db.execute_query(
            """
            SELECT summary_id, content, structured_context, period_start, period_end
            FROM summaries
            WHERE user_id = :user_id
              AND period_type = 'hourly'
              AND period_start >= :start_time
              AND period_start < :end_time
            ORDER BY period_start
            """,
            {
                "user_id": str(user_id),
                "start_time": start_time,
                "end_time": end_time,
            }
        )

        for row in results:
            row['content'] = self._ensure_json(row.get('content'))
            row['structured_context'] = self._ensure_json(row.get('structured_context'))
            row['summary_text'] = self._extract_summary_text(row)
            row['activity_counts'] = self._extract_activity_counts(row)

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
    ) -> uuid.UUID:
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
            "content": json.dumps(self._prepare_content_payload(summary_data)),
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
                CAST(:content AS jsonb),
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

        return summary_id

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
    
    def _prepare_content_payload(self, summary_data: Dict[str, Any]) -> Dict[str, Any]:
        structured = summary_data.get('structured_summary')
        if isinstance(structured, str):
            try:
                structured = json.loads(structured)
            except json.JSONDecodeError:
                structured = None

        summary_block: Dict[str, Any] | None = None
        if isinstance(structured, dict):
            if isinstance(structured.get('summary'), dict):
                summary_block = structured['summary']
            else:
                summary_block = structured

        if summary_block is None:
            summary_text = summary_data.get('summary_text', '')
            summary_block = {
                "narrative": summary_text,
                "insights": summary_data.get('key_insights', []),
                "events": summary_data.get('events', summary_data.get('notable_events', [])),
                "anomalies": summary_data.get('anomalies', []),
                "tags": summary_data.get('tags', []),
            }

        narrative = summary_block.get('narrative')
        if not isinstance(narrative, str):
            narrative = summary_data.get('summary_text', '')

        insights = summary_block.get('insights')
        if not isinstance(insights, list):
            insights = summary_data.get('key_insights', [])

        anomalies = summary_block.get('anomalies')
        if not isinstance(anomalies, list):
            anomalies = summary_data.get('anomalies', [])

        tags = summary_block.get('tags')
        if not isinstance(tags, list):
            tags = summary_data.get('tags', [])

        events: list[str] = []
        for key in ('events', 'notable_events', 'activities'):
            value = summary_block.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, str) and item.strip():
                        events.append(item.strip())
                    elif isinstance(item, dict):
                        descriptor = item.get('event') or item.get('description') or item.get('title')
                        if isinstance(descriptor, str) and descriptor.strip():
                            text = descriptor.strip()
                            timestamp = item.get('time')
                            if isinstance(timestamp, str) and timestamp.strip():
                                text = f"{text} ({timestamp.strip()})"
                            events.append(text)

        if not events:
            fallback_events = summary_data.get('events', summary_data.get('notable_events', []))
            if isinstance(fallback_events, list):
                events.extend(str(item).strip() for item in fallback_events if str(item).strip())

        summary_block['tags'] = tags
        summary_block['insights'] = insights
        summary_block['anomalies'] = anomalies
        summary_block['events'] = events

        return {
            "summary": summary_block,
            "narrative": narrative,
            "key_insights": insights,
            "events": events,
            "anomalies": anomalies,
            "tags": tags,
            "activity_counts": summary_data.get('activity_counts', {}),
            "tokens_used": summary_data.get('tokens_used', 0),
        }
    
    def get_daily_summaries(self,
                            user_id: uuid.UUID,
                            start_time: datetime,
                            end_time: datetime) -> list:
        """Retrieve daily summaries for a time period."""
        results = db.execute_query(
            """
            SELECT summary_id, content, structured_context, period_start, period_end
            FROM summaries
            WHERE user_id = :user_id
              AND period_type = 'daily'
              AND period_start >= :start_time
              AND period_start < :end_time
            ORDER BY period_start
            """,
            {
                "user_id": str(user_id),
                "start_time": start_time,
                "end_time": end_time,
            }
        )

        for row in results:
            row['content'] = self._ensure_json(row.get('content'))
            row['structured_context'] = self._ensure_json(row.get('structured_context'))
            row['summary_text'] = self._extract_summary_text(row)
            row['activity_counts'] = self._extract_activity_counts(row)

        return results

    def _ensure_json(self, value: Any) -> Dict[str, Any]:
        if value is None:
            return {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return {}
        return {}

    def _extract_summary_text(self, record: Dict[str, Any]) -> str:
        content = record.get('content') or {}
        if isinstance(content, dict):
            summary_text = content.get('summary_text')
            if isinstance(summary_text, str):
                return summary_text
            summary_block = content.get('summary')
            if isinstance(summary_block, dict):
                narrative = summary_block.get('narrative')
                if isinstance(narrative, str):
                    return narrative
        return ""

    def _extract_activity_counts(self, record: Dict[str, Any]) -> Dict[str, Any]:
        content = record.get('content') or {}
        if isinstance(content, dict):
            counts = content.get('activity_counts')
            if isinstance(counts, dict):
                return counts
        context = record.get('structured_context') or {}
        if isinstance(context, dict):
            counts = context.get('activity_counts')
            if isinstance(counts, dict):
                return counts
        return {}


# Global storage instance
storage = SummaryStorage()

__all__ = ["storage", "SummaryStorage", "SummaryMetadata"]
