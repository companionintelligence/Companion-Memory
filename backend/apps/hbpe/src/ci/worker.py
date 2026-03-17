"""
Temporal worker for HBPE nightly jobs.

Registers all HBPE activities and workflows with the Temporal task queue.
"""
from __future__ import annotations

import asyncio
import logging

import structlog
from temporalio.client import Client
from temporalio.worker import Worker

from ci.config import settings
from ci.pipeline.nightly_runner import (
    NightlyHBPEWorkflow,
    cache_invalidation,
    drift_detection,
    l1_stale_sweep,
    l2_stale_sweep,
    label_summary_tokens,
    label_unlabeled,
    lora_fine_tune,
)
from ci.pipeline.schedule import setup_hbpe_schedules

log = structlog.get_logger(__name__)


async def main() -> None:
    log.info("connecting_temporal", address=settings.temporal_address)
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    # Register nightly schedule (idempotent — safe to call on every restart)
    await setup_hbpe_schedules(client)

    worker = Worker(
        client,
        task_queue=settings.task_queue,
        workflows=[NightlyHBPEWorkflow],
        activities=[
            label_unlabeled,
            label_summary_tokens,
            l1_stale_sweep,
            l2_stale_sweep,
            lora_fine_tune,
            drift_detection,
            cache_invalidation,
        ],
    )

    log.info("hbpe_worker_started", task_queue=settings.task_queue)
    await worker.run()


if __name__ == "__main__":
    logging.basicConfig(level=settings.log_level)
    asyncio.run(main())
