"""
System-level workflows that process all users.

These workflows run on a schedule and process all active users,
rather than having per-user schedules.
"""
from typing import List, Dict, Any
from datetime import datetime, timedelta, timezone
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from .database import db
    from .priority import Priority, get_task_queue
    from .workflows import (
        HourlySummaryWorkflow,
        DailySummaryWorkflow,
        WeeklySummaryWorkflow,
        MonthlySummaryWorkflow,
        DossierRefreshWorkflow,
        InsightsGenerationWorkflow,
    )


def get_activity_options():
    """Activity options for DB queries"""
    return {
        "start_to_close_timeout": timedelta(seconds=30),
        "retry_policy": RetryPolicy(
            initial_interval=timedelta(seconds=1),
            maximum_interval=timedelta(seconds=10),
            backoff_coefficient=2.0,
            maximum_attempts=3,
        ),
    }


@workflow.defn(name="system-hourly-summaries")
class SystemHourlySummariesWorkflow:
    """
    System workflow that generates hourly summaries for all active users.

    Runs every hour and spawns child workflows for each user.
    """

    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """Execute hourly summaries for all users."""
        workflow.logger.info("system_hourly_summaries_started")

        # Calculate time window (previous hour)
        now = workflow.now()
        end_time = now.replace(minute=0, second=0, microsecond=0)
        start_time = end_time - timedelta(hours=1)

        # Get all active users
        users = await self._get_active_users()
        workflow.logger.info(f"active_users_fetched count={len(users)}")

        if not users:
            return {"users_processed": 0, "message": "No active users"}

        # Spawn child workflow for each user
        results = []
        for user_id in users:
            try:
                result = await workflow.execute_child_workflow(
                    HourlySummaryWorkflow.run,
                    args=[
                        user_id,
                        start_time.isoformat(),
                        end_time.isoformat(),
                        "UTC",
                        None,  # LLM config created by worker
                    ],
                    id=f"hourly-{user_id}-{end_time.isoformat()}",
                    task_queue=get_task_queue(Priority.MEDIUM),
                )
                results.append({"user_id": user_id, "status": "success", "result": result})
            except Exception as e:
                workflow.logger.error(f"hourly_summary_failed user_id={user_id} error={str(e)}")
                results.append({"user_id": user_id, "status": "error", "error": str(e)})

        workflow.logger.info(f"system_hourly_summaries_completed total={len(users)}")

        return {
            "users_processed": len(users),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "results": results,
        }

    async def _get_active_users(self) -> List[str]:
        """Get all active users from database."""
        # Use workflow.execute_activity for database queries
        # For now, we'll use a simple approach - query users table
        try:
            # Try ci.users first (new schema)
            rows = db.execute_query(
                "SELECT id FROM ci.users WHERE onboarded = true",
                {}
            )
            if rows:
                return [str(row['id']) for row in rows]
        except Exception:
            pass

        try:
            # Fallback to entities table
            rows = db.execute_query(
                "SELECT DISTINCT owner_user_id FROM entities WHERE owner_user_id IS NOT NULL",
                {}
            )
            return [str(row['owner_user_id']) for row in rows]
        except Exception:
            workflow.logger.warning("failed_to_fetch_users")
            return []


@workflow.defn(name="system-daily-summaries")
class SystemDailySummariesWorkflow:
    """System workflow that generates daily summaries for all active users."""

    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """Execute daily summaries for all users."""
        workflow.logger.info("system_daily_summaries_started")

        # Calculate time window (previous day)
        now = workflow.now()
        end_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start_time = end_time - timedelta(days=1)

        users = await self._get_active_users()
        workflow.logger.info(f"active_users_fetched count={len(users)}")

        if not users:
            return {"users_processed": 0, "message": "No active users"}

        results = []
        for user_id in users:
            try:
                result = await workflow.execute_child_workflow(
                    DailySummaryWorkflow.run,
                    args=[user_id, start_time.isoformat(), end_time.isoformat(), "UTC", None],
                    id=f"daily-{user_id}-{end_time.isoformat()}",
                    task_queue=get_task_queue(Priority.MEDIUM),
                )
                results.append({"user_id": user_id, "status": "success", "result": result})
            except Exception as e:
                workflow.logger.error(f"daily_summary_failed user_id={user_id} error={str(e)}")
                results.append({"user_id": user_id, "status": "error", "error": str(e)})

        workflow.logger.info(f"system_daily_summaries_completed total={len(users)}")

        return {
            "users_processed": len(users),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "results": results,
        }

    async def _get_active_users(self) -> List[str]:
        """Get all active users from database."""
        try:
            rows = db.execute_query(
                "SELECT id FROM ci.users WHERE onboarded = true",
                {}
            )
            if rows:
                return [str(row['id']) for row in rows]
        except Exception:
            pass

        try:
            rows = db.execute_query(
                "SELECT DISTINCT owner_user_id FROM entities WHERE owner_user_id IS NOT NULL",
                {}
            )
            return [str(row['owner_user_id']) for row in rows]
        except Exception:
            workflow.logger.warning("failed_to_fetch_users")
            return []


@workflow.defn(name="system-weekly-summaries")
class SystemWeeklySummariesWorkflow:
    """System workflow that generates weekly summaries for all active users."""

    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """Execute weekly summaries for all users."""
        workflow.logger.info("system_weekly_summaries_started")

        now = workflow.now()
        # Get start of current week (Monday)
        days_since_monday = (now.weekday() + 6) % 7
        end_time = (now - timedelta(days=days_since_monday)).replace(hour=0, minute=0, second=0, microsecond=0)
        start_time = end_time - timedelta(days=7)

        users = await self._get_active_users()
        if not users:
            return {"users_processed": 0}

        results = []
        for user_id in users:
            try:
                result = await workflow.execute_child_workflow(
                    WeeklySummaryWorkflow.run,
                    args=[user_id, start_time.isoformat(), end_time.isoformat(), "UTC", None],
                    id=f"weekly-{user_id}-{end_time.isoformat()}",
                    task_queue=get_task_queue(Priority.MEDIUM),
                )
                results.append({"user_id": user_id, "status": "success"})
            except Exception as e:
                workflow.logger.error(f"weekly_summary_failed user_id={user_id} error={str(e)}")
                results.append({"user_id": user_id, "status": "error", "error": str(e)})

        return {"users_processed": len(users), "results": results}

    async def _get_active_users(self) -> List[str]:
        try:
            rows = db.execute_query("SELECT id FROM ci.users WHERE onboarded = true", {})
            if rows:
                return [str(row['id']) for row in rows]
        except Exception:
            pass
        try:
            rows = db.execute_query(
                "SELECT DISTINCT owner_user_id FROM entities WHERE owner_user_id IS NOT NULL", {}
            )
            return [str(row['owner_user_id']) for row in rows]
        except Exception:
            return []


@workflow.defn(name="system-monthly-summaries")
class SystemMonthlySummariesWorkflow:
    """System workflow that generates monthly summaries for all active users."""

    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """Execute monthly summaries for all users."""
        workflow.logger.info("system_monthly_summaries_started")

        now = workflow.now()
        end_time = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # Previous month
        start_time = (end_time - timedelta(days=1)).replace(day=1)

        users = await self._get_active_users()
        if not users:
            return {"users_processed": 0}

        results = []
        for user_id in users:
            try:
                result = await workflow.execute_child_workflow(
                    MonthlySummaryWorkflow.run,
                    args=[user_id, start_time.isoformat(), end_time.isoformat(), "UTC", None],
                    id=f"monthly-{user_id}-{end_time.isoformat()}",
                    task_queue=get_task_queue(Priority.MEDIUM),
                )
                results.append({"user_id": user_id, "status": "success"})
            except Exception as e:
                workflow.logger.error(f"monthly_summary_failed user_id={user_id} error={str(e)}")
                results.append({"user_id": user_id, "status": "error", "error": str(e)})

        return {"users_processed": len(users), "results": results}

    async def _get_active_users(self) -> List[str]:
        try:
            rows = db.execute_query("SELECT id FROM ci.users WHERE onboarded = true", {})
            if rows:
                return [str(row['id']) for row in rows]
        except Exception:
            pass
        try:
            rows = db.execute_query(
                "SELECT DISTINCT owner_user_id FROM entities WHERE owner_user_id IS NOT NULL", {}
            )
            return [str(row['owner_user_id']) for row in rows]
        except Exception:
            return []


@workflow.defn(name="system-dossier-refresh")
class SystemDossierRefreshWorkflow:
    """System workflow that refreshes dossiers for all active users."""

    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """Execute dossier refresh for all users."""
        workflow.logger.info("system_dossier_refresh_started")

        now = workflow.now()
        users = await self._get_active_users()

        if not users:
            return {"users_processed": 0}

        results = []
        for user_id in users:
            try:
                result = await workflow.execute_child_workflow(
                    DossierRefreshWorkflow.run,
                    args=[user_id, now.isoformat(), "UTC", 30, None],
                    id=f"dossier-{user_id}-{now.isoformat()}",
                    task_queue=get_task_queue(Priority.MEDIUM),
                )
                results.append({"user_id": user_id, "status": "success"})
            except Exception as e:
                workflow.logger.error(f"dossier_refresh_failed user_id={user_id} error={str(e)}")
                results.append({"user_id": user_id, "status": "error", "error": str(e)})

        return {"users_processed": len(users), "results": results}

    async def _get_active_users(self) -> List[str]:
        try:
            rows = db.execute_query("SELECT id FROM ci.users WHERE onboarded = true", {})
            if rows:
                return [str(row['id']) for row in rows]
        except Exception:
            pass
        try:
            rows = db.execute_query(
                "SELECT DISTINCT owner_user_id FROM entities WHERE owner_user_id IS NOT NULL", {}
            )
            return [str(row['owner_user_id']) for row in rows]
        except Exception:
            return []


@workflow.defn(name="system-insights")
class SystemInsightsWorkflow:
    """
    System workflow that generates proactive insights for all active users.

    Runs every 3 hours and spawns child workflows for each user.
    Each child workflow checks if there's new data before generating insights.
    """

    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """Execute insights generation for all users."""
        workflow.logger.info("system_insights_started")

        now = workflow.now()
        users = await self._get_active_users()
        workflow.logger.info(f"active_users_fetched count={len(users)}")

        if not users:
            return {"users_processed": 0, "message": "No active users"}

        results = []
        skipped_count = 0
        generated_count = 0

        for user_id in users:
            try:
                result = await workflow.execute_child_workflow(
                    InsightsGenerationWorkflow.run,
                    args=[
                        user_id,
                        "UTC",
                        72,  # 3 days lookback
                        None,  # LLM config created by worker
                    ],
                    id=f"insights-{user_id}-{now.isoformat()}",
                    task_queue=get_task_queue(Priority.MEDIUM),
                )

                if result.get("skipped"):
                    skipped_count += 1
                    results.append({
                        "user_id": user_id,
                        "status": "skipped",
                        "reason": result.get("reason"),
                    })
                else:
                    generated_count += 1
                    results.append({
                        "user_id": user_id,
                        "status": "success",
                        "summary_ids": result.get("summary_ids"),
                        "num_insights": result.get("num_insights"),
                    })
            except Exception as e:
                workflow.logger.error(f"insights_generation_failed user_id={user_id} error={str(e)}")
                results.append({"user_id": user_id, "status": "error", "error": str(e)})

        workflow.logger.info(
            f"system_insights_completed total={len(users)} generated={generated_count} skipped={skipped_count}"
        )

        return {
            "users_processed": len(users),
            "insights_generated": generated_count,
            "insights_skipped": skipped_count,
            "timestamp": now.isoformat(),
            "results": results,
        }

    async def _get_active_users(self) -> List[str]:
        """Get all active users from database."""
        try:
            rows = db.execute_query("SELECT id FROM ci.users WHERE onboarded = true", {})
            if rows:
                return [str(row['id']) for row in rows]
        except Exception:
            pass
        try:
            rows = db.execute_query(
                "SELECT DISTINCT owner_user_id FROM entities WHERE owner_user_id IS NOT NULL", {}
            )
            return [str(row['owner_user_id']) for row in rows]
        except Exception:
            workflow.logger.warning("failed_to_fetch_users")
            return []


__all__ = [
    "SystemHourlySummariesWorkflow",
    "SystemDailySummariesWorkflow",
    "SystemWeeklySummariesWorkflow",
    "SystemMonthlySummariesWorkflow",
    "SystemDossierRefreshWorkflow",
    "SystemInsightsWorkflow",
]
