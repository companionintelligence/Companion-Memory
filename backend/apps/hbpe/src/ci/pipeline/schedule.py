"""
HBPE schedule setup — registers the nightly Temporal schedule on worker startup.

Creates one Schedule per user that triggers NightlyHBPEWorkflow at 2:30 AM UTC
each night (after daily summaries complete at 00:10, dossier refresh at :12).

Idempotent: already-existing schedules are left unchanged, so calling this on
every container restart is safe.

Implements the scheduling half of T5.0 (CI-Server-1wz).
"""
from __future__ import annotations

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


def _checkpoint_exists() -> bool:
    """True once the base HMT model has been trained/exported at least once."""
    from pathlib import Path

    ckpt_dir = Path(settings.models_dir) / "hmt"
    return any(
        (ckpt_dir / name).exists()
        for name in ("hmt_int8.onnx", "hmt_fp32.onnx", "hmt_calibrated.pt", "hmt_checkpoint.pt")
    )


async def ensure_bootstrap_if_cold(client: Client) -> None:
    """
    Start ``BootstrapHBPEWorkflow`` for each user when no HMT checkpoint exists.

    The nightly schedule only runs *incremental* updates and never trains the
    base model, so without this a fresh appliance would sit in COLD_START until
    a human manually hit "Predict". Run on every worker startup; idempotent — a
    bootstrap already running for the user raises WorkflowAlreadyStartedError and
    is left alone, and a previous failed/aborted run (e.g. no data yet) is simply
    retried on the next worker start.
    """
    if _checkpoint_exists():
        log.info("hbpe_bootstrap_skipped", reason="checkpoint_exists")
        return

    user_ids = _fetch_user_ids()
    if not user_ids:
        log.info("hbpe_bootstrap_skipped", reason="no_users_in_db")
        return

    from temporalio.exceptions import WorkflowAlreadyStartedError
    from ci.pipeline.bootstrap import BootstrapHBPEWorkflow

    for user_id in user_ids:
        workflow_id = f"hbpe-bootstrap-{user_id[:8]}"
        try:
            await client.start_workflow(
                BootstrapHBPEWorkflow.run,
                user_id,
                id=workflow_id,
                task_queue=settings.task_queue,
            )
            log.info("hbpe_bootstrap_started", workflow_id=workflow_id, user=user_id[:8])
        except WorkflowAlreadyStartedError:
            log.info("hbpe_bootstrap_already_running", workflow_id=workflow_id)
        except Exception as exc:
            log.error("hbpe_bootstrap_start_failed", workflow_id=workflow_id, error=str(exc))


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
