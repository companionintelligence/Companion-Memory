"""
HBPE schedule setup — registers the nightly Temporal schedule on worker startup.

Creates one Schedule per user that triggers NightlyHBPEWorkflow at 2:30 AM UTC
each night (after daily summaries complete at 00:10, dossier refresh at :12).

Idempotent: already-existing schedules are left unchanged, so calling this on
every container restart is safe.

Implements the scheduling half of T5.0 (CI-Server-1wz).
"""
from __future__ import annotations

import logging

import structlog
from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, ScheduleSpec

from ci.config import settings
from ci.pipeline.nightly_runner import NightlyHBPEWorkflow

log = structlog.get_logger(__name__)

# 2:30 AM UTC — after daily summaries (00:10) and dossier refresh (:12), before morning
_NIGHTLY_CRON = "30 2 * * *"


def _fetch_user_ids() -> list[str]:
    """Return all user IDs from the database."""
    from ci.data_client import get_all_user_ids
    return get_all_user_ids()


async def setup_hbpe_schedules(client: Client) -> None:
    """
    Create a nightly Temporal Schedule for each user in the database.

    One schedule per user, named ``hbpe-nightly-<user_id_prefix>``.
    Already-existing schedules are skipped (idempotent).
    """
    user_ids = _fetch_user_ids()
    if not user_ids:
        log.warning("hbpe_schedule_setup_skipped", reason="no_users_in_db")
        return

    created = skipped = failed = 0
    for user_id in user_ids:
        schedule_id = f"hbpe-nightly-{user_id[:8]}"
        try:
            await client.create_schedule(
                schedule_id,
                Schedule(
                    action=ScheduleActionStartWorkflow(
                        NightlyHBPEWorkflow.run,
                        user_id,
                        id=f"{schedule_id}-{{action.scheduled_time}}",
                        task_queue=settings.task_queue,
                    ),
                    spec=ScheduleSpec(
                        cron_expressions=[_NIGHTLY_CRON],
                    ),
                ),
            )
            log.info("hbpe_schedule_created",
                     schedule_id=schedule_id, cron=_NIGHTLY_CRON, user=user_id[:8])
            created += 1
        except Exception as exc:
            if "already exists" in str(exc).lower():
                log.debug("hbpe_schedule_exists", schedule_id=schedule_id)
                skipped += 1
            else:
                log.error("hbpe_schedule_failed",
                          schedule_id=schedule_id, error=str(exc))
                failed += 1

    log.info("hbpe_schedule_setup_done",
             created=created, skipped=skipped, failed=failed)


async def delete_hbpe_schedules(client: Client) -> None:
    """Delete all hbpe-nightly-* schedules. Useful for resetting timing."""
    user_ids = _fetch_user_ids()
    for user_id in user_ids:
        schedule_id = f"hbpe-nightly-{user_id[:8]}"
        try:
            handle = client.get_schedule_handle(schedule_id)
            await handle.delete()
            log.info("hbpe_schedule_deleted", schedule_id=schedule_id)
        except Exception as exc:
            log.warning("hbpe_schedule_delete_failed",
                        schedule_id=schedule_id, error=str(exc))
