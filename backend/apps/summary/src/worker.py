"""
Temporal worker for summary service.

The worker connects to Temporal server, registers workflows and activities,
and polls for work to execute.
"""
import sys
import signal
import asyncio
import structlog
from temporalio.client import Client
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from .config import settings
from .llm_config import get_llm_config
from .database import db
from .agent_registration import agent_registration

# Import workflows
from .workflows import (
    HourlySummaryWorkflow,
    DailySummaryWorkflow,
    WeeklySummaryWorkflow,
    MonthlySummaryWorkflow,
    SeasonalSummaryWorkflow,
    YearlySummaryWorkflow,
    DossierRefreshWorkflow,
    InsightsGenerationWorkflow,
    ActionsGenerationWorkflow,
)

# Import system workflows
from .system_workflows import (
    SystemHourlySummariesWorkflow,
    SystemDailySummariesWorkflow,
    SystemWeeklySummariesWorkflow,
    SystemMonthlySummariesWorkflow,
    SystemDossierRefreshWorkflow,
    SystemInsightsWorkflow,
)

# Import activities
from .activities import (
    resolve_summary_window_activity,
    aggregate_data_activity,
    generate_hourly_summary_activity,
    generate_rollup_summary_activity,
    store_summary_activity,
    fetch_child_summaries_activity,
    get_entity_id_activity,
    fetch_previous_dossier_activity,
    fetch_summaries_for_dossier_activity,
    generate_dossier_activity,
    store_dossier_activity,
    # Insight activities
    check_new_data_for_insights_activity,
    get_last_insight_time_activity,
    aggregate_insights_context_activity,
    generate_insights_activity,
    store_insight_activity,
    # Action activities
    aggregate_action_context_activity,
    generate_actions_activity,
    store_action_activity,
)

# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


# Global worker instance for cleanup
_worker = None
_client = None


def signal_handler(sig, frame):
    """Handle shutdown signals gracefully."""
    logger.info("shutdown_signal_received", signal=sig)
    cleanup()
    sys.exit(0)


def cleanup():
    """Cleanup resources on shutdown."""
    logger.info("cleaning_up")
    agent_registration.deregister()
    db.close()


async def run_worker():
    """Run the Temporal worker with multiple priority queues."""
    global _worker, _client

    logger.info("temporal_worker_starting",
               version=settings.agent_version,
               model=settings.llm_model)

    try:
        # Create LLM config once at startup
        logger.info("creating_llm_config")
        llm_config = get_llm_config()
        logger.info("llm_config_created", model=settings.llm_model)

        # Connect to Temporal
        logger.info("connecting_to_temporal", address=settings.temporal_address)
        _client = await Client.connect(
            settings.temporal_address,
            namespace=settings.temporal_namespace,
        )
        logger.info("temporal_connected")

        # All workflows and activities
        all_workflows = [
            # Per-user workflows (can be triggered manually or by system workflows)
            HourlySummaryWorkflow,
            DailySummaryWorkflow,
            WeeklySummaryWorkflow,
            MonthlySummaryWorkflow,
            SeasonalSummaryWorkflow,
            YearlySummaryWorkflow,
            DossierRefreshWorkflow,
            InsightsGenerationWorkflow,
            ActionsGenerationWorkflow,
            # System workflows (process all users)
            SystemHourlySummariesWorkflow,
            SystemDailySummariesWorkflow,
            SystemWeeklySummariesWorkflow,
            SystemMonthlySummariesWorkflow,
            SystemDossierRefreshWorkflow,
            SystemInsightsWorkflow,
        ]

        all_activities = [
            resolve_summary_window_activity,
            aggregate_data_activity,
            generate_hourly_summary_activity,
            generate_rollup_summary_activity,
            store_summary_activity,
            fetch_child_summaries_activity,
            get_entity_id_activity,
            fetch_previous_dossier_activity,
            fetch_summaries_for_dossier_activity,
            generate_dossier_activity,
            store_dossier_activity,
            # Insight activities
            check_new_data_for_insights_activity,
            get_last_insight_time_activity,
            aggregate_insights_context_activity,
            generate_insights_activity,
            store_insight_activity,
            # Action activities
            aggregate_action_context_activity,
            generate_actions_activity,
            store_action_activity,
        ]

        # The workflow sandbox re-imports workflow modules in a restricted
        # environment. py-key-value-aio (a transitive pydantic-ai dependency)
        # installs beartype's `claw` import hook globally at import time, and
        # that hook hits a circular import when re-run inside the sandbox
        # (RuntimeError: Failed validating workflow ... -> ImportError:
        # cannot import name 'claw_state'). The in-module imports_passed_through()
        # in workflows.py is not enough because the hook is global; pass these
        # modules through the sandbox so it reuses the host's initialized copies.
        workflow_runner = SandboxedWorkflowRunner(
            restrictions=SandboxRestrictions.default.with_passthrough_modules(
                "beartype",
                "key_value",
            )
        )

        # Create workers for each priority level
        # High priority: More concurrent activities, processes critical user-facing work
        worker_high = Worker(
            _client,
            task_queue=settings.task_queue_high,
            workflows=all_workflows,
            activities=all_activities,
            max_concurrent_activities=settings.max_concurrent_activities_high,
            activity_executor=None,
            workflow_runner=workflow_runner,
        )

        # Medium priority: Standard concurrency for all automated summaries
        worker_medium = Worker(
            _client,
            task_queue=settings.task_queue_medium,
            workflows=all_workflows,
            activities=all_activities,
            max_concurrent_activities=settings.max_concurrent_activities_medium,
            activity_executor=None,
            workflow_runner=workflow_runner,
        )

        # Low priority: Limited concurrency for batch operations
        worker_low = Worker(
            _client,
            task_queue=settings.task_queue_low,
            workflows=all_workflows,
            activities=all_activities,
            max_concurrent_activities=settings.max_concurrent_activities_low,
            activity_executor=None,
            workflow_runner=workflow_runner,
        )

        logger.info("workers_configured",
                   workflows=len(all_workflows),
                   activities=len(all_activities),
                   high_queue=settings.task_queue_high,
                   medium_queue=settings.task_queue_medium,
                   low_queue=settings.task_queue_low,
                   high_concurrency=settings.max_concurrent_activities_high,
                   medium_concurrency=settings.max_concurrent_activities_medium,
                   low_concurrency=settings.max_concurrent_activities_low)

        # Register agent with control plane
        try:
            agent_id = agent_registration.register()
            logger.info("agent_registered_successfully", agent_id=str(agent_id))
        except Exception as e:
            logger.warning("agent_registration_failed", error=str(e))
            # Continue without registration - not critical for Temporal worker

        # Run all workers concurrently
        # Each worker polls its own task queue
        logger.info("workers_starting_polling")
        await asyncio.gather(
            worker_high.run(),
            worker_medium.run(),
            worker_low.run(),
        )

    except Exception as e:
        logger.error("worker_failed", error=str(e), exc_info=True)
        cleanup()
        sys.exit(1)


def main():
    """Main entry point for worker."""
    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Run worker
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
