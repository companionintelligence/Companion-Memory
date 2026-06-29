"""
Temporal workflows for summary generation.

Workflows are durable, fault-tolerant orchestrations that coordinate
activities and maintain state across failures and restarts.
"""
from typing import Dict, Any, Optional
from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy

# Import activity definitions (not implementations!)
with workflow.unsafe.imports_passed_through():
    from .activities import (
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
    from .llm_config import LLMConfig


# ============================================================================
# Workflow Configuration
# ============================================================================

# Activity retry policy: exponential backoff for transient failures
ACTIVITY_RETRY_POLICY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=60),
    backoff_coefficient=2.0,
    maximum_attempts=5,
)

# Activity options will be passed directly to execute_activity calls
# Kept here for reference and consistency
def get_data_activity_options():
    """Activity options for data operations (fast, low timeout)"""
    return {
        "start_to_close_timeout": timedelta(seconds=30),
        "retry_policy": ACTIVITY_RETRY_POLICY,
    }

def get_llm_activity_options():
    """Activity options for LLM operations (slow, single blocking call).

    No heartbeat_timeout: each LLM activity makes one synchronous run_sync()
    call that cannot heartbeat mid-flight, and on CPU that call routinely
    exceeds a short heartbeat window — so a heartbeat_timeout just cancels
    healthy work ("Final heartbeat task didn't trap error"). start_to_close
    bounds the call instead; it's generous because a local model on CPU can
    take minutes per generation (×output retries).
    """
    return {
        "start_to_close_timeout": timedelta(minutes=10),
        "retry_policy": ACTIVITY_RETRY_POLICY,
    }


# ============================================================================
# Hourly Summary Workflow
# ============================================================================

@workflow.defn(name="hourly-summary")
class HourlySummaryWorkflow:
    """
    Workflow to generate hourly summary from raw activity data.

    Steps:
    1. Aggregate data from all sources
    2. Generate summary using LLM
    3. Store summary in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        start_time: str,  # ISO format
        end_time: str,    # ISO format
        timezone: str = "UTC",
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute hourly summary workflow."""
        workflow.logger.info(f"hourly_summary_workflow_started user_id={user_id}")

        # Step 1: Aggregate data
        aggregated_data = await workflow.execute_activity(
            aggregate_data_activity,
            args=[user_id, start_time, end_time],
            **get_data_activity_options(),
        )

        # Check if there's any activity
        total_activity = sum(
            len(v) for v in aggregated_data.values()
            if isinstance(v, list)
        )
        workflow.logger.info(f"data_aggregated total_items={total_activity}")

        # Step 2: Generate summary (LLM call)
        summary_data = await workflow.execute_activity(
            generate_hourly_summary_activity,
            args=[aggregated_data],
            **get_llm_activity_options(),
        )

        # Step 3: Store summary
        summary_id = await workflow.execute_activity(
            store_summary_activity,
            args=[user_id, summary_data, start_time, end_time, timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"hourly_summary_workflow_completed summary_id={summary_id}")

        return {
            "summary_id": summary_id,
            "summary_type": "hourly",
            "summary_text": summary_data.get("summary_text", ""),
            "key_insights": summary_data.get("key_insights", []),
            "activity_counts": summary_data.get("activity_counts", {}),
            "tokens_used": summary_data.get("tokens_used", 0),
        }


# ============================================================================
# Daily Summary Workflow
# ============================================================================

@workflow.defn(name="daily-summary")
class DailySummaryWorkflow:
    """
    Workflow to generate daily summary from hourly summaries.

    Steps:
    1. Fetch hourly summaries for the day
    2. Generate daily summary using LLM
    3. Store summary in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        start_time: str,
        end_time: str,
        timezone: str = "UTC",
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute daily summary workflow."""
        workflow.logger.info(f"daily_summary_workflow_started user_id={user_id}")

        # Step 1: Fetch hourly summaries
        hourly_summaries = await workflow.execute_activity(
            fetch_child_summaries_activity,
            args=[user_id, start_time, end_time, "hourly"],
            **get_data_activity_options(),
        )

        if not hourly_summaries:
            raise ValueError(f"No hourly summaries found for daily aggregation: {start_time} to {end_time}")

        workflow.logger.info(f"hourly_summaries_fetched count={len(hourly_summaries)}")

        # Step 2: Generate daily summary (LLM call)
        summary_data = await workflow.execute_activity(
            generate_rollup_summary_activity,
            args=["daily", hourly_summaries],
            **get_llm_activity_options(),
        )

        # Step 3: Store summary
        summary_id = await workflow.execute_activity(
            store_summary_activity,
            args=[user_id, summary_data, start_time, end_time, timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"daily_summary_workflow_completed summary_id={summary_id}")

        return {
            "summary_id": summary_id,
            "summary_type": "daily",
            "summary_text": summary_data.get("summary_text", ""),
            "activity_counts": summary_data.get("activity_counts", {}),
            "num_hourly_summaries": len(hourly_summaries),
            "tokens_used": summary_data.get("tokens_used", 0),
        }


# ============================================================================
# Weekly Summary Workflow
# ============================================================================

@workflow.defn(name="weekly-summary")
class WeeklySummaryWorkflow:
    """
    Workflow to generate weekly summary from daily summaries.

    Steps:
    1. Fetch daily summaries for the week
    2. Generate weekly summary using LLM
    3. Store summary in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        start_time: str,
        end_time: str,
        timezone: str = "UTC",
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute weekly summary workflow."""
        workflow.logger.info(f"weekly_summary_workflow_started user_id={user_id}")

        # Step 1: Fetch daily summaries
        daily_summaries = await workflow.execute_activity(
            fetch_child_summaries_activity,
            args=[user_id, start_time, end_time, "daily"],
            **get_data_activity_options(),
        )

        if not daily_summaries:
            raise ValueError(f"No daily summaries found for weekly aggregation: {start_time} to {end_time}")

        workflow.logger.info(f"daily_summaries_fetched count={len(daily_summaries)}")

        # Step 2: Generate weekly summary (LLM call)
        summary_data = await workflow.execute_activity(
            generate_rollup_summary_activity,
            args=["weekly", daily_summaries],
            **get_llm_activity_options(),
        )

        # Step 3: Store summary
        summary_id = await workflow.execute_activity(
            store_summary_activity,
            args=[user_id, summary_data, start_time, end_time, timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"weekly_summary_workflow_completed summary_id={summary_id}")

        return {
            "summary_id": summary_id,
            "summary_type": "weekly",
            "summary_text": summary_data.get("summary_text", ""),
            "activity_counts": summary_data.get("activity_counts", {}),
            "num_daily_summaries": len(daily_summaries),
            "tokens_used": summary_data.get("tokens_used", 0),
        }


# ============================================================================
# Monthly Summary Workflow
# ============================================================================

@workflow.defn(name="monthly-summary")
class MonthlySummaryWorkflow:
    """
    Workflow to generate monthly summary from daily summaries.

    Steps:
    1. Fetch daily summaries for the month
    2. Generate monthly summary using LLM
    3. Store summary in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        start_time: str,
        end_time: str,
        timezone: str = "UTC",
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute monthly summary workflow."""
        workflow.logger.info(f"monthly_summary_workflow_started user_id={user_id}")

        # Step 1: Fetch daily summaries
        daily_summaries = await workflow.execute_activity(
            fetch_child_summaries_activity,
            args=[user_id, start_time, end_time, "daily"],
            **get_data_activity_options(),
        )

        if not daily_summaries:
            raise ValueError(f"No daily summaries found for monthly aggregation: {start_time} to {end_time}")

        workflow.logger.info(f"daily_summaries_fetched count={len(daily_summaries)}")

        # Step 2: Generate monthly summary (LLM call)
        summary_data = await workflow.execute_activity(
            generate_rollup_summary_activity,
            args=["monthly", daily_summaries],
            **get_llm_activity_options(),
        )

        # Step 3: Store summary
        summary_id = await workflow.execute_activity(
            store_summary_activity,
            args=[user_id, summary_data, start_time, end_time, timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"monthly_summary_workflow_completed summary_id={summary_id}")

        return {
            "summary_id": summary_id,
            "summary_type": "monthly",
            "summary_text": summary_data.get("summary_text", ""),
            "activity_counts": summary_data.get("activity_counts", {}),
            "num_daily_summaries": len(daily_summaries),
            "tokens_used": summary_data.get("tokens_used", 0),
        }


# ============================================================================
# Seasonal Summary Workflow
# ============================================================================

@workflow.defn(name="seasonal-summary")
class SeasonalSummaryWorkflow:
    """
    Workflow to generate seasonal summary from daily summaries.

    Steps:
    1. Fetch daily summaries for the season (3 months)
    2. Generate seasonal summary using LLM
    3. Store summary in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        start_time: str,
        end_time: str,
        timezone: str = "UTC",
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute seasonal summary workflow."""
        workflow.logger.info(f"seasonal_summary_workflow_started user_id={user_id}")

        # Step 1: Fetch daily summaries
        daily_summaries = await workflow.execute_activity(
            fetch_child_summaries_activity,
            args=[user_id, start_time, end_time, "daily"],
            **get_data_activity_options(),
        )

        if not daily_summaries:
            raise ValueError(f"No daily summaries found for seasonal aggregation: {start_time} to {end_time}")

        workflow.logger.info(f"daily_summaries_fetched count={len(daily_summaries)}")

        # Step 2: Generate seasonal summary (LLM call)
        summary_data = await workflow.execute_activity(
            generate_rollup_summary_activity,
            args=["seasonal", daily_summaries],
            **get_llm_activity_options(),
        )

        # Step 3: Store summary
        summary_id = await workflow.execute_activity(
            store_summary_activity,
            args=[user_id, summary_data, start_time, end_time, timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"seasonal_summary_workflow_completed summary_id={summary_id}")

        return {
            "summary_id": summary_id,
            "summary_type": "seasonal",
            "summary_text": summary_data.get("summary_text", ""),
            "activity_counts": summary_data.get("activity_counts", {}),
            "num_daily_summaries": len(daily_summaries),
            "tokens_used": summary_data.get("tokens_used", 0),
        }


# ============================================================================
# Yearly Summary Workflow
# ============================================================================

@workflow.defn(name="yearly-summary")
class YearlySummaryWorkflow:
    """
    Workflow to generate yearly summary from daily summaries.

    Steps:
    1. Fetch daily summaries for the year
    2. Generate yearly summary using LLM
    3. Store summary in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        start_time: str,
        end_time: str,
        timezone: str = "UTC",
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute yearly summary workflow."""
        workflow.logger.info(f"yearly_summary_workflow_started user_id={user_id}")

        # Step 1: Fetch daily summaries
        daily_summaries = await workflow.execute_activity(
            fetch_child_summaries_activity,
            args=[user_id, start_time, end_time, "daily"],
            **get_data_activity_options(),
        )

        if not daily_summaries:
            raise ValueError(f"No daily summaries found for yearly aggregation: {start_time} to {end_time}")

        workflow.logger.info(f"daily_summaries_fetched count={len(daily_summaries)}")

        # Step 2: Generate yearly summary (LLM call)
        summary_data = await workflow.execute_activity(
            generate_rollup_summary_activity,
            args=["yearly", daily_summaries],
            **get_llm_activity_options(),
        )

        # Step 3: Store summary
        summary_id = await workflow.execute_activity(
            store_summary_activity,
            args=[user_id, summary_data, start_time, end_time, timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"yearly_summary_workflow_completed summary_id={summary_id}")

        return {
            "summary_id": summary_id,
            "summary_type": "yearly",
            "summary_text": summary_data.get("summary_text", ""),
            "activity_counts": summary_data.get("activity_counts", {}),
            "num_daily_summaries": len(daily_summaries),
            "tokens_used": summary_data.get("tokens_used", 0),
        }


# ============================================================================
# Dossier Refresh Workflow
# ============================================================================

@workflow.defn(name="dossier-refresh")
class DossierRefreshWorkflow:
    """
    Workflow to refresh user dossier from recent summaries.

    Steps:
    1. Get entity ID for user
    2. Fetch previous dossier
    3. Fetch recent summaries (daily + hourly)
    4. Generate new dossier using LLM
    5. Store dossier in entities table
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        end_time: str,
        timezone: str = "UTC",
        lookback_days: int = 30,
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute dossier refresh workflow."""
        workflow.logger.info(f"dossier_refresh_workflow_started user_id={user_id}")

        # Step 1: Get entity ID
        entity_id = await workflow.execute_activity(
            get_entity_id_activity,
            args=[user_id],
            **get_data_activity_options(),
        )

        if not entity_id:
            raise ValueError(f"No entity found for user {user_id}")

        workflow.logger.info(f"entity_id_retrieved entity_id={entity_id}")

        # Step 2: Fetch previous dossier
        previous_dossier = await workflow.execute_activity(
            fetch_previous_dossier_activity,
            args=[entity_id],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"previous_dossier_fetched has_dossier={bool(previous_dossier)}")

        # Step 3: Fetch summaries
        summaries = await workflow.execute_activity(
            fetch_summaries_for_dossier_activity,
            args=[user_id, lookback_days, end_time],
            **get_data_activity_options(),
        )

        daily_summaries = summaries.get("daily", [])
        hourly_summaries = summaries.get("hourly", [])

        if not daily_summaries and not hourly_summaries:
            raise ValueError(f"No summaries found for dossier generation")

        workflow.logger.info(
            f"summaries_fetched daily_count={len(daily_summaries)} hourly_count={len(hourly_summaries)}"
        )

        # Step 4: Generate dossier (LLM call)
        dossier = await workflow.execute_activity(
            generate_dossier_activity,
            args=[user_id, daily_summaries, hourly_summaries, end_time, timezone, lookback_days, previous_dossier],
            **get_llm_activity_options(),
        )

        # Step 5: Store dossier
        await workflow.execute_activity(
            store_dossier_activity,
            args=[entity_id, dossier],
            **get_data_activity_options(),
        )

        workflow.logger.info(f"dossier_refresh_workflow_completed entity_id={entity_id}")

        return {
            "entity_id": entity_id,
            "dossier": dossier,
        }


# ============================================================================
# Insights Generation Workflow
# ============================================================================

@workflow.defn(name="insights-generation")
class InsightsGenerationWorkflow:
    """
    Workflow to generate proactive insights from user context.

    Steps:
    1. Check if there's new data since last insight
    2. Aggregate context (graph deltas, events, relationships, summaries)
    3. Generate insights using LLM
    4. Store insights as summary with period_type='insight'
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        timezone: str = "UTC",
        lookback_hours: int = 72,  # 3 days default lookback
        llm_config: Optional[LLMConfig] = None,
        force: bool = False,  # Skip new data check if True
    ) -> Dict[str, Any]:
        """Execute insights generation workflow."""
        workflow.logger.info(f"insights_generation_workflow_started user_id={user_id} force={force}")

        from datetime import datetime, timedelta

        # Use workflow.now() for deterministic time in workflows
        now = workflow.now()

        # Step 1: Get last insight time to determine lookback
        last_insight_time = await workflow.execute_activity(
            get_last_insight_time_activity,
            args=[user_id],
            **get_data_activity_options(),
        )

        # Determine 'since' time: use last insight time or default lookback
        if last_insight_time:
            since = datetime.fromisoformat(last_insight_time)
        else:
            since = now - timedelta(hours=lookback_hours)

        workflow.logger.info(
            f"lookback_window_determined since={since.isoformat()} until={now.isoformat()}"
        )

        # Step 2: Check if there's new data worth processing (skip if force=True)
        if not force:
            has_new_data = await workflow.execute_activity(
                check_new_data_for_insights_activity,
                args=[user_id, since.isoformat()],
                **get_data_activity_options(),
            )

            if not has_new_data:
                workflow.logger.info("no_new_data_skipping_insights")
                return {
                    "skipped": True,
                    "reason": "no_new_data",
                    "user_id": user_id,
                }
        else:
            workflow.logger.info("force_mode_skipping_new_data_check")

        # Step 3: Aggregate context for insight generation
        insights_context = await workflow.execute_activity(
            aggregate_insights_context_activity,
            args=[user_id, since.isoformat(), now.isoformat()],
            **get_data_activity_options(),
        )

        # Check if we have enough context (count all sources)
        context_counts = {
            "graph_deltas": len(insights_context.get("graph_deltas", [])),
            "upcoming_events": len(insights_context.get("upcoming_events", [])),
            "recent_summaries": len(insights_context.get("recent_summaries", [])),
            "strongest_relationships": len(insights_context.get("strongest_relationships", [])),
            "recently_changed_relationships": len(insights_context.get("recently_changed_relationships", [])),
            "event_relevant_relationships": len(insights_context.get("event_relevant_relationships", [])),
            "recent_communications": len(insights_context.get("recent_communications", [])),
        }
        total_context_items = sum(context_counts.values())
        has_dossier = insights_context.get("user_dossier") is not None

        if total_context_items < 2:
            workflow.logger.info(
                f"insufficient_context_skipping total_items={total_context_items} has_dossier={has_dossier}"
            )
            return {
                "skipped": True,
                "reason": "insufficient_context",
                "user_id": user_id,
                "context_items": total_context_items,
            }

        workflow.logger.info(
            f"context_aggregated total_items={total_context_items} has_dossier={has_dossier}"
        )

        # Step 4: Generate insights (LLM call)
        insights_data = await workflow.execute_activity(
            generate_insights_activity,
            args=[insights_context],
            **get_llm_activity_options(),
        )

        # Check if any insights were generated
        num_insights = insights_data.get("num_insights", 0)
        if num_insights == 0:
            workflow.logger.info("no_insights_generated")
            return {
                "skipped": True,
                "reason": "no_insights_generated",
                "user_id": user_id,
            }

        # Step 5: Store insights (one row per insight)
        summary_ids = await workflow.execute_activity(
            store_insight_activity,
            args=[user_id, insights_data, since.isoformat(), now.isoformat(), timezone],
            **get_data_activity_options(),
        )

        workflow.logger.info(
            f"insights_generation_workflow_completed num_insights={num_insights} summary_ids={summary_ids}"
        )

        return {
            "skipped": False,
            "summary_ids": summary_ids,
            "user_id": user_id,
            "num_insights": num_insights,
            "tokens_used": insights_data.get("tokens_used", 0),
            "data_sources_used": insights_data.get("data_sources_used", []),
        }


# ============================================================================
# Actions Generation Workflow
# ============================================================================

@workflow.defn(name="actions-generation")
class ActionsGenerationWorkflow:
    """
    Workflow to generate proactive action cards from user context.

    Steps:
    1. Aggregate action context (summaries, insights, events, key people)
    2. Generate action cards using LLM (conversation starters + time suggestions)
    3. Store actions in database
    """

    @workflow.run
    async def run(
        self,
        user_id: str,
        timezone: str = "UTC",
        lookback_days: int = 7,
        llm_config: Optional[LLMConfig] = None,
    ) -> Dict[str, Any]:
        """Execute actions generation workflow."""
        workflow.logger.info(f"actions_generation_workflow_started user_id={user_id}")

        # Step 1: Aggregate action-specific context
        # This collects summaries, insights, events, and key people
        # rather than raw data like graph deltas
        action_context = await workflow.execute_activity(
            aggregate_action_context_activity,
            args=[user_id, lookback_days],
            **get_data_activity_options(),
        )

        # Check if we have enough context to generate meaningful actions
        total_context = (
            len(action_context.get("recent_summaries", [])) +
            len(action_context.get("recent_insights", [])) +
            len(action_context.get("upcoming_events", [])) +
            len(action_context.get("key_people", []))
        )

        if total_context < 2:
            workflow.logger.info(f"insufficient_context_for_actions total_items={total_context}")
            return {
                "skipped": True,
                "reason": "insufficient_context",
                "user_id": user_id,
                "context_items": total_context,
            }

        # Step 2: Generate action cards (LLM call)
        actions_data = await workflow.execute_activity(
            generate_actions_activity,
            args=[action_context],
            **get_llm_activity_options(),
        )

        num_actions = len(actions_data.get("actions", []))

        if num_actions == 0:
            workflow.logger.info("no_actions_generated")
            return {
                "skipped": True,
                "reason": "no_actions_generated",
                "user_id": user_id,
            }

        # Step 3: Store actions in database
        action_ids = await workflow.execute_activity(
            store_action_activity,
            args=[user_id, actions_data],
            **get_data_activity_options(),
        )

        workflow.logger.info(
            f"actions_generation_workflow_completed num_actions={num_actions} action_ids={action_ids}"
        )

        return {
            "skipped": False,
            "action_ids": action_ids,
            "user_id": user_id,
            "num_actions": num_actions,
            "tokens_used": actions_data.get("tokens_used", 0),
            "actions": actions_data.get("actions", []),
        }


__all__ = [
    "HourlySummaryWorkflow",
    "DailySummaryWorkflow",
    "WeeklySummaryWorkflow",
    "MonthlySummaryWorkflow",
    "SeasonalSummaryWorkflow",
    "YearlySummaryWorkflow",
    "DossierRefreshWorkflow",
    "DossierRefreshWorkflow",
    "InsightsGenerationWorkflow",
    "ActionsGenerationWorkflow",
]
