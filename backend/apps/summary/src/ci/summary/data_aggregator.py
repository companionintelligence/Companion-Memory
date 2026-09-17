"""Execute the explicit current-schema projections for hourly summaries."""

from datetime import datetime
from typing import Any
from uuid import UUID

import structlog

from .database import db
from .summary_sources import SUMMARY_SOURCES, SummarySource

logger = structlog.get_logger()


class DataAggregator:
    """Collect grounded user material for one half-open time window."""

    def aggregate_hour(
        self, user_id: UUID, start_time: datetime, end_time: datetime
    ) -> dict[str, Any]:
        logger.info(
            "aggregating_data",
            user_id=str(user_id),
            start=start_time.isoformat(),
            end=end_time.isoformat(),
        )

        result: dict[str, Any] = {
            "user_id": str(user_id),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
        }

        for source in SUMMARY_SOURCES:
            rows = self._query_source(source, user_id, start_time, end_time)
            result[source.name] = rows
            logger.debug("summary_source_queried", source=source.name, rows=len(rows))

        return result

    @staticmethod
    def _query_source(
        source: SummarySource,
        user_id: UUID,
        start: datetime,
        end: datetime,
    ) -> list[dict]:
        return db.execute_query(
            source.query,
            {
                "user_id": str(user_id),
                "start": start,
                "end": end,
                "limit": source.limit,
            },
        )


aggregator = DataAggregator()

__all__ = ["DataAggregator", "aggregator"]
