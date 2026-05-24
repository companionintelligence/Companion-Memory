"""
Temporal schedule setup for summary service.

This script creates persistent Temporal schedules that trigger workflows
on a cron schedule. Schedules are stored in Temporal's database and survive
restarts and deployments.
"""
import asyncio
import structlog
from datetime import datetime, timezone, timedelta
from typing import List
from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, ScheduleSpec, ScheduleIntervalSpec

from .config import settings
from .database import db
from .workflows import (
    HourlySummaryWorkflow,
    DailySummaryWorkflow,
    WeeklySummaryWorkflow,
    MonthlySummaryWorkflow,
    DossierRefreshWorkflow,
)

logger = structlog.get_logger()


async def get_onboarded_users() -> List[str]:
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


async def create_hourly_schedule(client: Client, user_id: str):
    """Create hourly summary schedule for a user."""
    schedule_id = f"hourly-summary-{user_id}"

    try:
        await client.create_schedule(
            schedule_id,
            Schedule(
                action=ScheduleActionStartWorkflow(
                    HourlySummaryWorkflow.run,
                    args=[
                        user_id,
                        # start_time and end_time will be calculated in the workflow
                        # based on workflow start time
                        None,  # Will use current hour - 1
                        None,  # Will use current hour
                        "UTC",
                        None,  # LLM config created by worker
                    ],
                    id=f"hourly-{user_id}-{{action.scheduled_time}}",
                    task_queue="summary-tasks",
                ),
                spec=ScheduleSpec(
                    # Run at 5 minutes past every hour
                    cron_expressions=["5 * * * *"],
                ),
            ),
        )
        logger.info("hourly_schedule_created", user_id=user_id, schedule_id=schedule_id)
    except Exception as e:
        logger.error("failed_to_create_hourly_schedule", user_id=user_id, error=str(e))


async def create_daily_schedule(client: Client, user_id: str):
    """Create daily summary schedule for a user."""
    schedule_id = f"daily-summary-{user_id}"

    try:
        await client.create_schedule(
            schedule_id,
            Schedule(
                action=ScheduleActionStartWorkflow(
                    DailySummaryWorkflow.run,
                    args=[
                        user_id,
                        None,  # Will use yesterday
                        None,  # Will use today
                        "UTC",
                        None,  # LLM config created by worker
                    ],
                    id=f"daily-{user_id}-{{action.scheduled_time}}",
                    task_queue="summary-tasks",
                ),
                spec=ScheduleSpec(
                    # Run at 00:10 UTC every day
                    cron_expressions=["10 0 * * *"],
                ),
            ),
        )
        logger.info("daily_schedule_created", user_id=user_id, schedule_id=schedule_id)
    except Exception as e:
        logger.error("failed_to_create_daily_schedule", user_id=user_id, error=str(e))


async def create_weekly_schedule(client: Client, user_id: str):
    """Create weekly summary schedule for a user."""
    schedule_id = f"weekly-summary-{user_id}"

    try:
        await client.create_schedule(
            schedule_id,
            Schedule(
                action=ScheduleActionStartWorkflow(
                    WeeklySummaryWorkflow.run,
                    args=[
                        user_id,
                        None,  # Will use last week
                        None,  # Will use this week
                        "UTC",
                        None,  # LLM config created by worker
                    ],
                    id=f"weekly-{user_id}-{{action.scheduled_time}}",
                    task_queue="summary-tasks",
                ),
                spec=ScheduleSpec(
                    # Run at 00:15 UTC every Monday
                    cron_expressions=["15 0 * * MON"],
                ),
            ),
        )
        logger.info("weekly_schedule_created", user_id=user_id, schedule_id=schedule_id)
    except Exception as e:
        logger.error("failed_to_create_weekly_schedule", user_id=user_id, error=str(e))


async def create_monthly_schedule(client: Client, user_id: str):
    """Create monthly summary schedule for a user."""
    schedule_id = f"monthly-summary-{user_id}"

    try:
        await client.create_schedule(
            schedule_id,
            Schedule(
                action=ScheduleActionStartWorkflow(
                    MonthlySummaryWorkflow.run,
                    args=[
                        user_id,
                        None,  # Will use last month
                        None,  # Will use this month
                        "UTC",
                        None,  # LLM config created by worker
                    ],
                    id=f"monthly-{user_id}-{{action.scheduled_time}}",
                    task_queue="summary-tasks",
                ),
                spec=ScheduleSpec(
                    # Run at 00:20 UTC on the 1st of every month
                    cron_expressions=["20 0 1 * *"],
                ),
            ),
        )
        logger.info("monthly_schedule_created", user_id=user_id, schedule_id=schedule_id)
    except Exception as e:
        logger.error("failed_to_create_monthly_schedule", user_id=user_id, error=str(e))


async def create_dossier_schedule(client: Client, user_id: str):
    """Create dossier refresh schedule for a user."""
    schedule_id = f"dossier-refresh-{user_id}"

    try:
        await client.create_schedule(
            schedule_id,
            Schedule(
                action=ScheduleActionStartWorkflow(
                    DossierRefreshWorkflow.run,
                    args=[
                        user_id,
                        None,  # Will use current time
                        "UTC",
                        30,  # lookback_days
                        None,  # LLM config created by worker
                    ],
                    id=f"dossier-{user_id}-{{action.scheduled_time}}",
                    task_queue="summary-tasks",
                ),
                spec=ScheduleSpec(
                    # Run at 12 minutes past every hour
                    cron_expressions=["12 * * * *"],
                ),
            ),
        )
        logger.info("dossier_schedule_created", user_id=user_id, schedule_id=schedule_id)
    except Exception as e:
        logger.error("failed_to_create_dossier_schedule", user_id=user_id, error=str(e))


async def setup_all_schedules():
    """Set up all schedules for all onboarded users."""
    logger.info("schedule_setup_starting")

    # Connect to Temporal
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )
    logger.info("temporal_connected", address=settings.temporal_address)

    # Get all onboarded users
    users = await get_onboarded_users()
    logger.info("onboarded_users_fetched", count=len(users))

    if not users:
        logger.warning("no_onboarded_users_found")
        return

    # Create schedules for each user
    for user_id in users:
        logger.info("creating_schedules_for_user", user_id=user_id)

        # Create all schedule types
        await create_hourly_schedule(client, user_id)
        await create_daily_schedule(client, user_id)
        await create_weekly_schedule(client, user_id)
        await create_monthly_schedule(client, user_id)
        await create_dossier_schedule(client, user_id)

    logger.info("schedule_setup_completed", user_count=len(users))


async def delete_user_schedules(user_id: str):
    """Delete all schedules for a specific user."""
    logger.info("deleting_schedules_for_user", user_id=user_id)

    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    schedule_ids = [
        f"hourly-summary-{user_id}",
        f"daily-summary-{user_id}",
        f"weekly-summary-{user_id}",
        f"monthly-summary-{user_id}",
        f"dossier-refresh-{user_id}",
    ]

    for schedule_id in schedule_ids:
        try:
            schedule_handle = client.get_schedule_handle(schedule_id)
            await schedule_handle.delete()
            logger.info("schedule_deleted", schedule_id=schedule_id)
        except Exception as e:
            logger.warning("failed_to_delete_schedule", schedule_id=schedule_id, error=str(e))

    logger.info("user_schedules_deleted", user_id=user_id)


async def list_all_schedules():
    """List all existing schedules."""
    logger.info("listing_schedules")

    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    # List schedules
    schedules = []
    async for schedule in client.list_schedules():
        schedules.append(schedule.id)
        logger.info("schedule_found", schedule_id=schedule.id)

    logger.info("schedules_listed", count=len(schedules))
    return schedules


def main():
    """Main entry point for schedule setup."""
    import sys

    if len(sys.argv) < 2:
        print("Usage:")
        print("  python -m src.schedules setup              # Set up schedules for all users")
        print("  python -m src.schedules delete <user_id>   # Delete schedules for a user")
        print("  python -m src.schedules list               # List all schedules")
        sys.exit(1)

    command = sys.argv[1]

    if command == "setup":
        asyncio.run(setup_all_schedules())
    elif command == "delete" and len(sys.argv) >= 3:
        user_id = sys.argv[2]
        asyncio.run(delete_user_schedules(user_id))
    elif command == "list":
        asyncio.run(list_all_schedules())
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()


__all__ = [
    "setup_all_schedules",
    "delete_user_schedules",
    "list_all_schedules",
    "create_hourly_schedule",
    "create_daily_schedule",
    "create_weekly_schedule",
    "create_monthly_schedule",
    "create_dossier_schedule",
]
