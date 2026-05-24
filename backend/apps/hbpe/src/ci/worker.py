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
from ci.pipeline.bootstrap import (
    BootstrapHBPEWorkflow,
    calibrate_and_export_onnx,
    serialize_token_stream,
    train_hmt_model,
)
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
    # Init database connection pool early to fail fast
    from ci.database import init_db
    init_db()
    
    log.info("connecting_temporal", address=settings.temporal_address)

    # Temporal registers the default namespace asynchronously after startup.
    # Retry until it's available.
    while True:
        try:
            client = await Client.connect(
                settings.temporal_address,
                namespace=settings.temporal_namespace,
            )

            # Register nightly schedule (idempotent — safe to call on every restart)
            await setup_hbpe_schedules(client)

            worker = Worker(
                client,
                task_queue=settings.task_queue,
                workflows=[NightlyHBPEWorkflow, BootstrapHBPEWorkflow],
                activities=[
                    label_unlabeled,
                    label_summary_tokens,
                    l1_stale_sweep,
                    l2_stale_sweep,
                    lora_fine_tune,
                    drift_detection,
                    cache_invalidation,
                    serialize_token_stream,
                    train_hmt_model,
                    calibrate_and_export_onnx,
                ],
            )

            log.info("hbpe_worker_started", task_queue=settings.task_queue)
            await worker.run()
            break

        except RuntimeError as e:
            if "namespace" in str(e).lower() and "not found" in str(e).lower():
                log.warning("temporal_namespace_not_ready", retry_in=5)
                await asyncio.sleep(5)
            else:
                raise


if __name__ == "__main__":
    logging.basicConfig(level=settings.log_level)
    asyncio.run(main())
