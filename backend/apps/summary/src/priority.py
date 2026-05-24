"""
Priority management for Temporal workflows.

Generic priority system shared across all services (summary, agents, etc).
Provides utilities for setting workflow priority and helpers for
executing workflows on the appropriate task queue.
"""
from enum import Enum
from typing import Optional

from .config import settings


class Priority(str, Enum):
    """Workflow priority levels (shared across all systems)."""
    HIGH = "high"      # User-facing, immediate response needed
    MEDIUM = "medium"  # Automated background work
    LOW = "low"        # Long-running batch operations


def get_task_queue(priority: Priority = Priority.MEDIUM) -> str:
    """
    Get the task queue name for a given priority level.

    Args:
        priority: Priority level (HIGH, MEDIUM, or LOW)

    Returns:
        Task queue name for the priority level
    """
    if priority == Priority.HIGH:
        return settings.task_queue_high
    elif priority == Priority.LOW:
        return settings.task_queue_low
    else:
        return settings.task_queue_medium


def get_max_concurrent_activities(priority: Priority = Priority.MEDIUM) -> int:
    """
    Get the max concurrent activities for a given priority level.

    Args:
        priority: Priority level

    Returns:
        Maximum number of concurrent activities
    """
    if priority == Priority.HIGH:
        return settings.max_concurrent_activities_high
    elif priority == Priority.LOW:
        return settings.max_concurrent_activities_low
    else:
        return settings.max_concurrent_activities_medium


# Priority assignment rules for summary workflows
def get_workflow_priority(workflow_type: str, is_manual: bool = False) -> Priority:
    """
    Determine priority for a workflow based on type and trigger method.

    Priority Rules:
    - Manual triggers: HIGH (user is waiting)
    - All automated summaries: MEDIUM (background work)

    Args:
        workflow_type: Type of workflow (hourly, daily, weekly, etc.)
        is_manual: Whether this is a manual trigger (user-initiated)

    Returns:
        Priority level for the workflow
    """
    # Manual triggers are always high priority (user is waiting)
    if is_manual:
        return Priority.HIGH

    # All automated summary work uses MEDIUM priority
    return Priority.MEDIUM


__all__ = [
    "Priority",
    "get_task_queue",
    "get_max_concurrent_activities",
    "get_workflow_priority",
]
