"""
LLM Configuration - creates agents as pure data structures.

This module provides factory functions to create LLM models and agents.
The configuration is immutable and can be safely shared across workers.
"""
from typing import Dict
from dataclasses import dataclass
from functools import lru_cache
import httpx
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .config import settings
from .summarizer import (
    HourlySummaryResponse,
    DailySummaryResponse,
    WeeklySummaryResponse,
    MonthlySummaryResponse,
    SeasonalSummaryResponse,
    YearlySummaryResponse,
    UserDossierResponse,
    UserDossierResponse,
    InsightsResponse,
    ActionsResponse,
)


@dataclass(frozen=True)
class LLMConfig:
    """
    Immutable LLM configuration containing model and agents.

    This is created once per worker and shared across all activities.
    """
    model: OpenAIChatModel
    agents: Dict[str, Agent]


def create_llm_config() -> LLMConfig:
    """
    Create LLM configuration with all agents.

    This is a pure factory function that creates the configuration
    based on settings. It's called once when the worker starts.
    """
    # Create HTTP client with long timeout for LLM calls
    http_client = httpx.AsyncClient(timeout=180.0)

    # Create model pointing to self-hosted endpoint
    model = OpenAIChatModel(
        settings.llm_model,
        provider=OpenAIProvider(
            base_url=settings.llm_api_base,
            api_key=settings.llm_api_key,
            http_client=http_client,
        ),
    )

    # Create all time-scale specific agents
    agents = {
        'hourly': Agent(
            model,
            output_type=HourlySummaryResponse,
            system_prompt=(
                "You are an AI that creates concise hourly summaries of user activity. "
                "Analyze the data and provide insights, patterns, and notable events."
            ),
        ),
        'daily': Agent(
            model,
            output_type=DailySummaryResponse,
            system_prompt=(
                "You synthesize hourly summaries into a daily overview. "
                "Focus on: daily rhythms and routines, workflow patterns, "
                "productivity peaks and valleys, social interactions, "
                "and how the day's activities connected together. "
                "Identify what made this day distinct or typical."
            ),
        ),
        'weekly': Agent(
            model,
            output_type=WeeklySummaryResponse,
            system_prompt=(
                "You synthesize daily summaries into a weekly overview. "
                "Focus on: work-life balance, recurring weekly patterns, "
                "progress on projects or goals, social dynamics, "
                "behavioral trends across weekdays vs weekends. "
                "Identify how the week developed and key accomplishments or challenges."
            ),
        ),
        'monthly': Agent(
            model,
            output_type=MonthlySummaryResponse,
            system_prompt=(
                "You synthesize weekly summaries into a monthly overview. "
                "Focus on: major milestones and achievements, evolving priorities, "
                "habit formation or changes, relationship developments, "
                "month-over-month growth or shifts in focus areas. "
                "Identify the arc of the month and significant transitions."
            ),
        ),
        'seasonal': Agent(
            model,
            output_type=SeasonalSummaryResponse,
            system_prompt=(
                "You synthesize monthly summaries into a seasonal (3-month) overview. "
                "Focus on: life phase transitions, major project outcomes, "
                "seasonal behavioral patterns, strategic direction changes, "
                "personal or professional evolution. "
                "Identify the broader narrative arc and transformative themes of this quarter."
            ),
        ),
        'yearly': Agent(
            model,
            output_type=YearlySummaryResponse,
            system_prompt=(
                "You synthesize seasonal summaries into a yearly overview. "
                "Focus on: annual achievements and setbacks, identity shifts, "
                "life trajectory changes, enduring patterns vs. experiments, "
                "key relationships and their evolution, personal growth themes. "
                "Provide a bird's-eye view of the year as a chapter in their life story."
            ),
        ),
        'dossier': Agent(
            model,
            output_type=UserDossierResponse,
            system_prompt=(
                "Create a concise user dossier summarizing personality, preferences, "
                "challenges, and interests based on their activity. Keep summary under 500 characters."
            ),
        ),
        'insights': Agent(
            model,
            output_type=InsightsResponse,
            system_prompt=(
                "You are a proactive personal assistant that generates actionable insights. "
                "Analyze the user's recent activity, relationships, upcoming events, and changes "
                "to their knowledge graph to surface helpful suggestions they might not think of themselves.\n\n"
                "Focus on:\n"
                "- Upcoming dates (anniversaries, birthdays, deadlines) and relevant people\n"
                "- Recently added or changed relationships that might need attention\n"
                "- Patterns in behavior that suggest opportunities or needs\n"
                "- Connections between people, places, and events the user might not see\n"
                "- Timely reminders based on recurring activities or maintenance cycles\n\n"
                "Each insight should be:\n"
                "- Actionable: Include specific next steps the user can take\n"
                "- Timely: Relevant to upcoming events or recent changes\n"
                "- Personal: Use knowledge about the user's relationships and preferences\n"
                "- Non-obvious: Connect dots the user might not see themselves\n\n"
                "Generate 3-5 high-quality insights. Prioritize quality over quantity."
            ),
        ),
        'actions': Agent(
            model,
            output_type=ActionsResponse,
            system_prompt=(
                "You are a proactive personal assistant that suggests action cards to help the user "
                "make the most of their time and have meaningful conversations.\n\n"
                "Generate two types of cards:\n\n"
                "1. CONVERSATION STARTERS (type='conversation_starter')\n"
                "   - Topics the user is likely interested in based on recent activity\n"
                "   - Questions to ask specific people they know\n"
                "   - Discussion prompts related to their interests or recent events\n"
                "   - Example: 'Ask Sarah about her trip to Japan' or 'Discuss the new project deadline with the team'\n\n"
                "2. TIME SUGGESTIONS (type='time_suggestion')\n"
                "   - What the user should consider doing next with their time\n"
                "   - Follow-ups on recent activities or meetings\n"
                "   - Preparation for upcoming events\n"
                "   - Example: 'Review notes from yesterday's brainstorm session' or 'Prepare talking points for Friday's meeting'\n\n"
                "CRITICAL RULES:\n"
                "- NEVER combine unrelated topics into one suggestion (e.g., don't mix workout advice with work tasks)\n"
                "- Each action card should focus on ONE coherent topic or activity\n"
                "- If the context mentions multiple unrelated activities, create SEPARATE cards for each\n"
                "- Keep suggestions practical and grounded - don't invent creative connections between unrelated things\n\n"
                "Guidelines:\n"
                "- Be specific and actionable, not generic\n"
                "- Reference real people, events, or topics from their context\n"
                "- Prioritize time-sensitive items higher\n"
                "- Include context for why each suggestion is relevant NOW\n"
                "- Aim for 3-5 high-quality suggestions with a mix of both types\n"
                "- Use a friendly, encouraging tone"
            ),
        ),
    }

    return LLMConfig(model=model, agents=agents)


@lru_cache(maxsize=1)
def get_llm_config() -> LLMConfig:
    """Return a cached LLM config to reuse clients across activities."""
    return create_llm_config()


__all__ = ["LLMConfig", "create_llm_config", "get_llm_config"]
