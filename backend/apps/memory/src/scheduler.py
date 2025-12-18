"""
Cron scheduler for memory summaries and dossier refreshes.

Directly executes summary generation on schedule instead of queueing to PgBoss.
"""
import structlog
from datetime import datetime, timezone, timedelta
from typing import Dict, List
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from .database import db
from . import summaries

logger = structlog.get_logger()


class SummaryScheduler:
    """Schedules periodic summary generation jobs."""

    def __init__(self):
        self.scheduler = BackgroundScheduler(timezone='UTC')
        self.timezone = 'UTC'

    def start(self):
        """Start all cron jobs."""
        # Hourly summaries - 5 min past every hour
        self.scheduler.add_job(
            self._execute_hourly_summaries,
            CronTrigger(minute=5, timezone='UTC'),
            id='hourly_summaries',
            name='Execute hourly summaries',
        )

        # Daily summaries - 00:10 UTC
        self.scheduler.add_job(
            self._execute_daily_summaries,
            CronTrigger(hour=0, minute=10, timezone='UTC'),
            id='daily_summaries',
            name='Execute daily summaries',
        )

        # Dossier refresh - 12 min past every hour
        self.scheduler.add_job(
            self._execute_dossier_refresh,
            CronTrigger(minute=12, timezone='UTC'),
            id='dossier_refresh',
            name='Execute dossier refreshes',
        )

        # Weekly summaries - Mondays at 00:15 UTC
        self.scheduler.add_job(
            self._execute_weekly_summaries,
            CronTrigger(day_of_week='mon', hour=0, minute=15, timezone='UTC'),
            id='weekly_summaries',
            name='Execute weekly summaries',
        )

        # Monthly summaries - 1st of month at 00:20 UTC
        self.scheduler.add_job(
            self._execute_monthly_summaries,
            CronTrigger(day=1, hour=0, minute=20, timezone='UTC'),
            id='monthly_summaries',
            name='Execute monthly summaries',
        )

        self.scheduler.start()
        logger.info("summary_scheduler_started", jobs=len(self.scheduler.get_jobs()))

    def stop(self):
        """Stop scheduler."""
        self.scheduler.shutdown(wait=True)
        logger.info("summary_scheduler_stopped")

    # ========================================================================
    # Cron job handlers
    # ========================================================================

    def _execute_hourly_summaries(self):
        """Execute hourly summary for all users."""
        window = self._calculate_window('hourly')
        self._execute_summaries_for_all_users('hourly', window)

    def _execute_daily_summaries(self):
        """Execute daily summary for all users."""
        window = self._calculate_window('daily')
        self._execute_summaries_for_all_users('daily', window)

    def _execute_weekly_summaries(self):
        """Execute weekly summary for all users."""
        window = self._calculate_window('weekly')
        self._execute_summaries_for_all_users('weekly', window)

    def _execute_monthly_summaries(self):
        """Execute monthly summary for all users."""
        window = self._calculate_window('monthly')
        self._execute_summaries_for_all_users('monthly', window)

    def _execute_dossier_refresh(self):
        """Execute dossier refresh for all users."""
        window = self._calculate_window('hourly')
        users = self._get_onboarded_users()

        if not users:
            logger.debug("no_onboarded_users_for_dossier")
            return

        success_count = 0
        error_count = 0

        for user_id in users:
            try:
                summaries.execute_dossier_refresh(
                    user_id=str(user_id),
                    start_time=window['start'],
                    end_time=window['end'],
                    timezone=self.timezone,
                    trigger='auto',
                )
                success_count += 1
            except Exception as exc:
                logger.error("dossier_refresh_failed", user_id=str(user_id), error=str(exc))
                error_count += 1

        logger.info(
            "executed_dossier_refreshes",
            user_count=len(users),
            success=success_count,
            errors=error_count,
            window_start=window['start'].isoformat(),
            window_end=window['end'].isoformat(),
        )

    # ========================================================================
    # Helpers
    # ========================================================================

    def _execute_summaries_for_all_users(self, period_type: str, window: Dict[str, datetime]):
        """Execute summary for all users."""
        users = self._get_onboarded_users()

        if not users:
            logger.debug("no_onboarded_users", period_type=period_type)
            return

        success_count = 0
        error_count = 0

        for user_id in users:
            try:
                # Call appropriate summary execution function
                if period_type == 'hourly':
                    summaries.execute_hourly_summary(
                        user_id=str(user_id),
                        start_time=window['start'],
                        end_time=window['end'],
                        timezone=self.timezone,
                    )
                elif period_type == 'daily':
                    summaries.execute_daily_summary(
                        user_id=str(user_id),
                        start_time=window['start'],
                        end_time=window['end'],
                        timezone=self.timezone,
                    )
                elif period_type == 'weekly':
                    summaries.execute_weekly_summary(
                        user_id=str(user_id),
                        start_time=window['start'],
                        end_time=window['end'],
                        timezone=self.timezone,
                    )
                elif period_type == 'monthly':
                    summaries.execute_monthly_summary(
                        user_id=str(user_id),
                        start_time=window['start'],
                        end_time=window['end'],
                        timezone=self.timezone,
                    )
                success_count += 1
            except Exception as exc:
                logger.error(
                    "summary_execution_failed",
                    user_id=str(user_id),
                    period_type=period_type,
                    error=str(exc)
                )
                error_count += 1

        logger.info(
            "executed_summaries",
            period_type=period_type,
            user_count=len(users),
            success=success_count,
            errors=error_count,
            window_start=window['start'].isoformat(),
            window_end=window['end'].isoformat(),
        )

    def _get_onboarded_users(self) -> List[str]:
        """Get all onboarded user IDs."""
        try:
            rows = db.execute_query(
                "SELECT id FROM core.users WHERE onboarded = true",
                {}
            )
            return [str(row['id']) for row in rows]
        except Exception as exc:
            logger.error("failed_to_fetch_users", error=str(exc))
            return []

    def _calculate_window(self, period_type: str, reference: datetime = None) -> Dict[str, datetime]:
        """Calculate start/end window for a period type."""
        if reference is None:
            reference = datetime.now(timezone.utc)

        if period_type == 'hourly':
            end = self._start_of_utc_hour(reference)
            start = end - timedelta(hours=1)
        elif period_type == 'daily':
            end = self._start_of_utc_day(reference)
            start = end - timedelta(days=1)
        elif period_type == 'weekly':
            end = self._start_of_current_week(reference)
            start = end - timedelta(days=7)
        elif period_type == 'monthly':
            end = self._start_of_month(reference)
            start = end - timedelta(days=30)  # Approximate
        else:
            raise ValueError(f"Unsupported period type: {period_type}")

        return {'start': start, 'end': end}

    def _start_of_utc_hour(self, dt: datetime) -> datetime:
        """Get start of current hour in UTC."""
        return dt.replace(minute=0, second=0, microsecond=0)

    def _start_of_utc_day(self, dt: datetime) -> datetime:
        """Get start of current day in UTC."""
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)

    def _start_of_current_week(self, dt: datetime) -> datetime:
        """Get start of current week (Monday) in UTC."""
        start_of_day = self._start_of_utc_day(dt)
        days_since_monday = (start_of_day.weekday() + 6) % 7
        return start_of_day - timedelta(days=days_since_monday)

    def _start_of_month(self, dt: datetime) -> datetime:
        """Get start of current month in UTC."""
        return dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


# Global scheduler instance
scheduler = SummaryScheduler()

__all__ = ['scheduler', 'SummaryScheduler']
