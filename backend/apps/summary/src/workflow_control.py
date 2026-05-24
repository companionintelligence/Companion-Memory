"""
Workflow control utilities for managing running workflows.

Provides functions to cancel background summarization workflows when
high-priority LLM work needs to be executed.
"""
import structlog
from typing import List, Optional
from temporalio.client import Client, WorkflowHandle
from temporalio.service import RPCError

from .config import settings

logger = structlog.get_logger()


async def cancel_system_workflows(
    workflow_types: Optional[List[str]] = None
) -> dict:
    """
    Cancel running system workflows to free up LLM resources.

    Args:
        workflow_types: List of workflow types to cancel. If None, cancels all system workflows.
                       Options: ["hourly", "daily", "weekly", "monthly", "dossier"]

    Returns:
        Dict with cancellation results
    """
    logger.info("cancelling_system_workflows", types=workflow_types)

    # Connect to Temporal
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    # Default to all system workflows if not specified
    if workflow_types is None:
        workflow_types = ["hourly", "daily", "weekly", "monthly", "dossier"]

    results = {
        "cancelled": [],
        "not_found": [],
        "errors": [],
    }

    # Cancel each workflow type
    for wf_type in workflow_types:
        try:
            # System workflows have predictable IDs based on schedule
            workflow_id = f"system-{wf_type}-summaries"
            if wf_type == "dossier":
                workflow_id = "system-dossier-refresh"

            # Get handle to workflow
            handle = client.get_workflow_handle(workflow_id)

            # Request cancellation
            await handle.cancel()

            results["cancelled"].append(workflow_id)
            logger.info("workflow_cancelled", workflow_id=workflow_id)

        except RPCError as e:
            # Workflow not found or already completed
            if "not found" in str(e).lower() or "NotFound" in str(e):
                results["not_found"].append(workflow_id)
                logger.debug("workflow_not_running", workflow_id=workflow_id)
            else:
                results["errors"].append({
                    "workflow_id": workflow_id,
                    "error": str(e)
                })
                logger.error("workflow_cancel_failed", workflow_id=workflow_id, error=str(e))

        except Exception as e:
            results["errors"].append({
                "workflow_id": workflow_id,
                "error": str(e)
            })
            logger.error("workflow_cancel_failed", workflow_id=workflow_id, error=str(e))

    logger.info("system_workflow_cancellation_complete",
                cancelled=len(results["cancelled"]),
                not_found=len(results["not_found"]),
                errors=len(results["errors"]))

    return results


async def cancel_user_workflows(
    user_id: str,
    workflow_types: Optional[List[str]] = None
) -> dict:
    """
    Cancel running workflows for a specific user.

    Args:
        user_id: User ID whose workflows should be cancelled
        workflow_types: List of workflow types to cancel. If None, cancels all types.
                       Options: ["hourly", "daily", "weekly", "monthly", "seasonal",
                                "yearly", "dossier"]

    Returns:
        Dict with cancellation results
    """
    logger.info("cancelling_user_workflows", user_id=user_id, types=workflow_types)

    # Connect to Temporal
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    # Default to all workflow types if not specified
    if workflow_types is None:
        workflow_types = ["hourly", "daily", "weekly", "monthly", "seasonal", "yearly", "dossier"]

    results = {
        "cancelled": [],
        "not_found": [],
        "errors": [],
    }

    # List all running workflows and filter by user
    async for workflow in client.list_workflows(f'WorkflowType STARTS_WITH "{workflow_types[0]}-"'):
        workflow_id = workflow.id

        # Check if this workflow is for the specified user
        # Workflow IDs are like: "hourly-{user_id}-{timestamp}"
        if user_id in workflow_id:
            try:
                handle = client.get_workflow_handle(workflow_id)
                await handle.cancel()

                results["cancelled"].append(workflow_id)
                logger.info("user_workflow_cancelled", workflow_id=workflow_id, user_id=user_id)

            except Exception as e:
                results["errors"].append({
                    "workflow_id": workflow_id,
                    "error": str(e)
                })
                logger.error("user_workflow_cancel_failed",
                           workflow_id=workflow_id,
                           user_id=user_id,
                           error=str(e))

    logger.info("user_workflow_cancellation_complete",
                user_id=user_id,
                cancelled=len(results["cancelled"]),
                errors=len(results["errors"]))

    return results


async def get_running_workflows() -> dict:
    """
    Get information about currently running workflows.

    Returns:
        Dict with counts of running workflows by type
    """
    logger.info("fetching_running_workflows")

    # Connect to Temporal
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )

    workflow_counts = {
        "system": {
            "hourly": 0,
            "daily": 0,
            "weekly": 0,
            "monthly": 0,
            "dossier": 0,
        },
        "user": {
            "hourly": 0,
            "daily": 0,
            "weekly": 0,
            "monthly": 0,
            "seasonal": 0,
            "yearly": 0,
            "dossier": 0,
        },
        "total": 0,
    }

    # List all running workflows
    async for workflow in client.list_workflows('ExecutionStatus = "Running"'):
        workflow_counts["total"] += 1

        workflow_id = workflow.id

        # Categorize workflow
        if workflow_id.startswith("system-"):
            # System workflow
            for wf_type in workflow_counts["system"].keys():
                if wf_type in workflow_id:
                    workflow_counts["system"][wf_type] += 1
                    break
        else:
            # User workflow
            for wf_type in workflow_counts["user"].keys():
                if workflow_id.startswith(f"{wf_type}-"):
                    workflow_counts["user"][wf_type] += 1
                    break

    logger.info("running_workflows_fetched", total=workflow_counts["total"])

    return workflow_counts


__all__ = [
    "cancel_system_workflows",
    "cancel_user_workflows",
    "get_running_workflows",
]
