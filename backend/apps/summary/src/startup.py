import asyncio
import structlog
import temporalio.api.workflowservice.v1
from temporalio.client import Client

from .config import settings
from .system_schedules import setup_system_schedules

logger = structlog.get_logger()

async def wait_for_temporal():
    """Wait for Temporal service and namespace to be available."""
    logger.info("waiting_for_temporal", address=settings.temporal_address)

    retries = 60
    delay = 2
    client = None

    # Phase 1: Wait for Temporal gRPC to be reachable
    for i in range(retries):
        try:
            client = await Client.connect(
                settings.temporal_address,
                namespace=settings.temporal_namespace,
            )
            logger.info("temporal_connection_successful")
            break
        except Exception as e:
            if i == retries - 1:
                logger.error("temporal_connection_failed", error=str(e))
                raise
            logger.debug("temporal_connection_retry", attempt=i + 1, error=str(e))
            await asyncio.sleep(delay)

    # Phase 2: Wait for the namespace to be registered
    # The orchestrator creates it asynchronously after boot.
    logger.info("waiting_for_namespace", namespace=settings.temporal_namespace)
    for i in range(retries):
        try:
            await client.workflow_service.describe_namespace(
                temporalio.api.workflowservice.v1.DescribeNamespaceRequest(
                    namespace=settings.temporal_namespace,
                )
            )
            logger.info("namespace_ready", namespace=settings.temporal_namespace)
            return True
        except Exception as e:
            if i == retries - 1:
                logger.error("namespace_not_found", namespace=settings.temporal_namespace, error=str(e))
                raise
            logger.debug("namespace_retry", attempt=i + 1, error=str(e))
            await asyncio.sleep(delay)

async def main():
    """Run startup tasks."""
    try:
        # 1. Wait for Temporal
        await wait_for_temporal()
        print("✅ Temporal service is ready!")

        # 2. Run System Schedule Setup
        print("Setting up system schedules...")
        await setup_system_schedules()

    except Exception as e:
        logger.error("startup_failed", error=str(e))
        print(f"❌ Startup failed: {e}")
        exit(1)

if __name__ == "__main__":
    asyncio.run(main())
