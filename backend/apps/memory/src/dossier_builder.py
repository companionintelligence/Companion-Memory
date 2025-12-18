"""Utilities to synthesize a compact user dossier."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, Optional
from uuid import UUID

import structlog

from .config import settings
from .database import db
from .summarizer import summarizer

logger = structlog.get_logger()


class UserDossierBuilder:
    """Constructs dossier payloads from most recent daily summaries."""

    def __init__(self, lookback_days: int, max_chars: int):
        self._lookback_days = max(1, lookback_days)
        self._max_chars = max(512, max_chars)

    def build(
        self,
        user_id: UUID,
        period_end: datetime,
        timezone: str,
        *,
        lookback_override: Optional[int] = None,
        previous_dossier: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        lookback_days = max(1, lookback_override or self._lookback_days)
        window_end = period_end
        daily_window_start = window_end - timedelta(days=lookback_days)
        hourly_window_start = window_end - timedelta(days=1)

        daily_summaries = self._get_summaries(user_id, daily_window_start, window_end, "daily")
        hourly_summaries = self._get_summaries(user_id, hourly_window_start, window_end, "hourly")

        if not daily_summaries and not hourly_summaries:
            logger.info(
                "dossier_builder_skipped_no_summaries",
                user_id=str(user_id),
                window_start=daily_window_start.isoformat(),
                window_end=window_end.isoformat(),
            )
            return None

        context_payload = daily_summaries[-30:]
        logger.info("generating_dossier_from_llm",
                   daily_count=len(context_payload),
                   hourly_count=len(hourly_summaries[-24:]))

        dossier = summarizer.generate_user_dossier(
            user_id=str(user_id),
            lookback_start=daily_window_start,
            lookback_end=window_end,
            timezone=timezone,
            daily_summaries=context_payload,
            hourly_summaries=hourly_summaries[-24:],
            max_chars=self._max_chars,
            previous_dossier=previous_dossier,
        )
        logger.info("dossier_generated_from_llm")

        if not dossier:
            return None

        dossier.setdefault("version", 1)
        dossier.setdefault("lastUpdatedAt", datetime.utcnow().isoformat())
        dossier.setdefault(
            "sourceWindow",
            {
                "start": daily_window_start.isoformat(),
                "end": window_end.isoformat(),
                "timezone": timezone,
            },
        )

        return dossier

    def _get_summaries(self, user_id: UUID, start: datetime, end: datetime, period_type: str) -> list:
        """Get summaries from database."""
        import json
        rows = db.execute_query(
            """
            SELECT summary_id, content, period_start, period_end
            FROM summaries
            WHERE user_id = :user_id
              AND period_type = :period_type
              AND period_start >= :start
              AND period_start < :end
            ORDER BY period_start
            """,
            {"user_id": str(user_id), "period_type": period_type, "start": start, "end": end},
        )
        # Parse content
        for row in rows:
            content = row.get("content")
            if isinstance(content, str):
                try:
                    row["content"] = json.loads(content)
                except json.JSONDecodeError:
                    row["content"] = {}
            row["summary_text"] = row.get("content", {}).get("summary_text", "")
            row["activity_counts"] = row.get("content", {}).get("activity_counts", {})
        return rows


dossier_builder = UserDossierBuilder(
    lookback_days=settings.dossier_lookback_days,
    max_chars=settings.dossier_max_chars,
)

__all__ = ["UserDossierBuilder", "dossier_builder"]
