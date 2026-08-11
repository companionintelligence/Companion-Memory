"""
Data aggregation from all CompInt tables for temporal summarization.

Simple, schema-resilient approach: introspect tables, exclude noisy columns, query.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

import structlog

from .database import db

logger = structlog.get_logger()


# ============================================================================
# Configuration: Simple dicts, no Pydantic overhead
# ============================================================================

# Columns to exclude globally (embeddings, blobs, etc.)
EXCLUDE_PATTERNS = [
    "embedding",
    "vector",
    "_blob",
    "screenshot",
    "thumbnail",
    "raw_data",
    "search_vector",
    "image_data",
]

# Table configurations: only specify what's non-standard
TABLES = {
    # Aggregate tables: GROUP BY with stats
    "measurements": {
        "strategy": "aggregate",
        "time_col": "time",
        "group_by": ["sensor_id", "measurement_type", "units"],
        "agg": "AVG(value) as avg_value, MIN(value) as min_value, MAX(value) as max_value, COUNT(*) as count",
        "order": "count DESC",
    },
    "position": {
        "strategy": "aggregate",
        "time_col": "time",
        "group_by": ["location_entity_id", "source", "activity_type"],
        "agg": "COUNT(*) as count",
        "where_extra": "location IS NOT NULL",
        "exclude": ["location"],
        "order": "count DESC",
    },
    # Raw tables: just SELECT with time filter
    "communications": {
        "time_col": "time",
        "exclude": ["content", "participants_metadata"],
    },
    "activities": {"time_col": "start_time"},
    "events": {
        "time_col": "start_time",
        # The CTI conversion (20260811061409) moved title/description onto the
        # ci.entities base row; join it back so summaries keep naming events.
        "join": "JOIN ci.entities base ON base.entity_id = events.event_id",
        "select_extra": "base.name AS title, base.description AS description",
    },
    "messages": {"time_col": "created_at", "exclude": ["tool_calls", "edit_history"]},
    "files": {
        "time_col": "created_at",
        "exclude": ["extracted_text", "media_metadata"],
    },
    "api_logs": {"time_col": "created_at", "exclude": ["content"]},
    "browser_activity": {"time_col": "time", "exclude": ["domain"]},
    "screen_captures": {"time_col": "time", "exclude": ["ocr_text"], "limit": 50},
}

# Cache for table schemas
_schema_cache = {}


# ============================================================================
# Simple aggregator
# ============================================================================


class DataAggregator:
    """Aggregates user activity data from all configured tables."""

    def aggregate_hour(
        self, user_id: UUID, start_time: datetime, end_time: datetime
    ) -> dict[str, Any]:
        """
        Aggregate all user activity for a time period.

        Returns dict with table_name -> rows for each table.
        """
        logger.info(
            "aggregating_data",
            user_id=str(user_id),
            start=start_time.isoformat(),
            end=end_time.isoformat(),
        )

        result = {
            "user_id": str(user_id),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
        }

        for table_name, config in TABLES.items():
            try:
                rows = self._query_table(
                    table_name, config, user_id, start_time, end_time
                )
                result[table_name] = rows
                logger.debug("table_queried", table=table_name, rows=len(rows))
            except Exception as exc:
                logger.error("table_query_failed", table=table_name, error=str(exc))
                result[table_name] = []

        return result

    def _query_table(
        self, table: str, config: dict, user_id: UUID, start: datetime, end: datetime
    ) -> list[dict]:
        """Query a single table."""
        # Get semantic columns (cached)
        columns = self._get_semantic_columns(table, config)
        if not columns:
            return []

        # Build query based on strategy
        if config.get("strategy") == "aggregate":
            query = self._build_aggregate_query(table, config, columns)
        else:
            query = self._build_raw_query(table, config, columns)

        # Execute
        params = {
            "user_id": str(user_id),
            "start": start,
            "end": end,
            "limit": config.get("limit", 100),
        }
        return db.execute_query(query, params)

    def _get_semantic_columns(self, table: str, config: dict) -> list[str]:
        """Get columns to select, excluding embeddings/blobs/etc."""
        if table not in _schema_cache:
            # Introspect table
            rows = db.execute_query(
                """
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema IN ('public', 'ci') AND table_name = :table
                ORDER BY ordinal_position
                """,
                {"table": table},
            )
            if not rows:
                return []
            _schema_cache[table] = rows

        all_columns = _schema_cache[table]
        exclude = config.get("exclude", [])

        # Filter out noisy columns
        semantic = []
        for col_info in all_columns:
            name = col_info["column_name"]
            dtype = col_info["data_type"]

            # Skip if explicitly excluded
            if name in exclude:
                continue

            # Skip if matches exclusion pattern
            if any(pattern in name.lower() for pattern in EXCLUDE_PATTERNS):
                continue

            # Skip binary types
            if dtype.lower() in ["bytea", "tsvector"]:
                continue

            semantic.append(name)

        return semantic

    def _build_aggregate_query(
        self, table: str, config: dict, columns: list[str]
    ) -> str:
        """Build GROUP BY query."""
        group_by = config["group_by"]
        agg = config["agg"]
        select_extra = config.get("select_extra", "")

        # SELECT: group columns + aggregations + extras
        select_parts = [*group_by, agg]
        if select_extra:
            select_parts.insert(0, select_extra)

        select = ", ".join(select_parts)
        where = self._build_where(config)
        order = config.get("order", "count DESC")

        return f"""
        SELECT {select}
        FROM {table}
        WHERE {where}
        GROUP BY {", ".join(group_by)}
        ORDER BY {order}
        LIMIT :limit
        """

    def _build_raw_query(self, table: str, config: dict, columns: list[str]) -> str:
        """Build simple SELECT query."""
        select_extra = config.get("select_extra", "")
        join = config.get("join", "")
        # A join makes bare column names ambiguous; qualify with the table name.
        qualifier = table if join else None
        select_parts = [f"{table}.{c}" for c in columns] if join else columns[:]
        if select_extra:
            select_parts.insert(0, select_extra)

        select = ", ".join(select_parts)
        where = self._build_where(config, qualifier)
        time_col = config.get("time_col", "created_at")
        if qualifier:
            time_col = f"{qualifier}.{time_col}"
        order = config.get("order", f"{time_col} DESC")

        return f"""
        SELECT {select}
        FROM {table}
        {join}
        WHERE {where}
        ORDER BY {order}
        LIMIT :limit
        """

    def _build_where(self, config: dict, qualifier: str | None = None) -> str:
        """Build WHERE clause."""
        time_col = config.get("time_col", "created_at")
        user_col = config.get("user_col", "user_id")
        if qualifier:
            time_col = f"{qualifier}.{time_col}"
            user_col = f"{qualifier}.{user_col}"

        where_extra = config.get("where_extra", "")

        parts = [
            f"{user_col} = :user_id",
            f"{time_col} >= :start",
            f"{time_col} < :end",
        ]
        if where_extra:
            parts.append(where_extra)

        return " AND ".join(parts)


# Global instance
aggregator = DataAggregator()

__all__ = ["DataAggregator", "aggregator"]
