"""
Data aggregation from all CompInt tables for temporal summarization.
"""
import structlog
from typing import Dict, List, Any
from datetime import datetime, timedelta
from uuid import UUID

from .config import settings
from .database import db

logger = structlog.get_logger()


class DataAggregator:
    """Aggregates user activity data from all relevant tables."""
    
    def __init__(self):
        pass
    
    def aggregate_hour(self, user_id: UUID, start_time: datetime, end_time: datetime) -> Dict[str, Any]:
        """
        Aggregate all user activity for a given hour.
        
        Args:
            user_id: User UUID
            start_time: Start of the hour (with overlap)
            end_time: End of the hour (with overlap)
        
        Returns:
            Dictionary with aggregated data from all sources
        """
        logger.info("aggregating_hour_data",
                   user_id=str(user_id),
                   start=start_time.isoformat(),
                   end=end_time.isoformat())
        
        aggregated = {
            "user_id": str(user_id),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "measurements": self._get_measurements(user_id, start_time, end_time),
            "positions": self._get_positions(user_id, start_time, end_time),
            "communications": self._get_communications(user_id, start_time, end_time),
            "activities": self._get_activities(user_id, start_time, end_time),
            "events": self._get_events(user_id, start_time, end_time),
            "messages": self._get_messages(user_id, start_time, end_time),
            "files": self._get_files(user_id, start_time, end_time),
            "api_logs": self._get_api_logs(user_id, start_time, end_time),
            "browser_activity": self._get_browser_activity(user_id, start_time, end_time),
            "screen_captures": self._get_screen_captures(user_id, start_time, end_time),
        }
        
        return aggregated
    
    def _get_measurements(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get sensor measurements for time period."""
        query = """
        SELECT 
            sensor_id,
            measurement_type,
            AVG(value) as avg_value,
            MIN(value) as min_value,
            MAX(value) as max_value,
            COUNT(*) as count,
            units
        FROM measurements
        WHERE user_id = :user_id
          AND time >= :start
          AND time < :end
        GROUP BY sensor_id, measurement_type, units
        ORDER BY count DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_positions(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get location data for time period."""
        query = """
        SELECT 
            ST_AsText(location) as location_text,
            location_entity_id,
            source,
            activity_type,
            COUNT(*) as count
        FROM position
        WHERE user_id = :user_id
          AND time >= :start
          AND time < :end
          AND location IS NOT NULL
        GROUP BY location, location_entity_id, source, activity_type
        ORDER BY count DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_communications(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get communications (email, sms, calls) for time period."""
        query = """
        SELECT 
            communication_type,
            direction,
            from_entity_id,
            to_entity_ids,
            subject,
            content,
            duration_seconds,
            sentiment_score,
            importance_score,
            category,
            time
        FROM communications
        WHERE user_id = :user_id
          AND time >= :start
          AND time < :end
        ORDER BY time DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_activities(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get tracked activities for time period."""
        query = """
        SELECT 
            activity_name,
            activity_type,
            description,
            location_name,
            duration_minutes,
            productivity_score,
            focus_score,
            energy_level,
            mood_score,
            tags,
            start_time,
            end_time
        FROM activities
        WHERE user_id = :user_id
          AND start_time >= :start
          AND start_time < :end
        ORDER BY start_time DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_events(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get calendar events for time period."""
        query = """
        SELECT 
            title,
            description,
            event_type,
            category,
            location_name,
            status,
            start_time,
            end_time,
            duration_minutes,
            tags
        FROM events
        WHERE user_id = :user_id
          AND start_time >= :start
          AND start_time < :end
          AND is_deleted = false
        ORDER BY start_time
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_messages(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get chat messages for time period."""
        query = """
        SELECT 
            m.role,
            m.content,
            m.model_name,
            m.total_tokens,
            m.sentiment_score,
            m.extracted_entities,
            t.title as thread_title,
            m.created_at
        FROM messages m
        JOIN threads t ON m.thread_id = t.thread_id
        WHERE m.user_id = :user_id
          AND m.created_at >= :start
          AND m.created_at < :end
          AND m.is_deleted = false
        ORDER BY m.created_at DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_files(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get file activity for time period."""
        query = """
        SELECT 
            filename,
            file_extension,
            content_type,
            file_size_bytes,
            title,
            summary,
            tags,
            categories,
            created_at,
            modified_at_source
        FROM files
        WHERE user_id = :user_id
          AND (
              created_at >= :start AND created_at < :end
              OR modified_at_source >= :start AND modified_at_source < :end
          )
          AND is_deleted = false
        ORDER BY modified_at_source DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })
    
    def _get_api_logs(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get API interaction logs for time period."""
        query = """
        SELECT 
            scope,
            content,
            created_at
        FROM api_logs
        WHERE user_id = :user_id
          AND created_at >= :start
          AND created_at < :end
        ORDER BY created_at DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })

    def _get_browser_activity(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get browser activity for time period."""
        query = """
        SELECT 
            time,
            url,
            domain,
            title,
            action_type,
            duration_seconds,
            scroll_depth_percent,
            category,
            productivity_score,
            is_incognito,
            contains_sensitive,
            page_summary
        FROM browser_activity
        WHERE user_id = :user_id
          AND time >= :start
          AND time < :end
        ORDER BY time DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })

    def _get_screen_captures(self, user_id: UUID, start: datetime, end: datetime) -> List[Dict]:
        """Get analyzed screen captures for time period."""
        query = """
        SELECT
            time,
            image_path,
            thumbnail_path,
            activity_summary,
            primary_application,
            activity_category,
            applications,
            ui_elements,
            contains_sensitive,
            contains_pii,
            redacted,
            ocr_text
        FROM screen_captures
        WHERE user_id = :user_id
          AND time >= :start
          AND time < :end
        ORDER BY time DESC
        LIMIT :limit
        """
        return db.execute_query(query, {
            "user_id": user_id,
            "start": start,
            "end": end,
            "limit": settings.max_items_per_category
        })

# Global aggregator instance
aggregator = DataAggregator()
