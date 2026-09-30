"""
LLM Configuration - creates agents as pure data structures.

This module provides factory functions to create LLM models and agents.
The configuration is immutable and can be safely shared across workers.
"""

from dataclasses import dataclass, field
from functools import lru_cache

import httpx
import structlog
from pydantic_ai import Agent, PromptedOutput
from pydantic_ai.exceptions import ModelHTTPError, UnexpectedModelBehavior
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIChatModelSettings
from pydantic_ai.providers.openai import OpenAIProvider

from .config import resolve_llm_model, resolve_output_mode, settings
from .summarizer import (
    ActionsResponse,
    DailySummaryResponse,
    HourlySummaryResponse,
    InsightsResponse,
    MonthlySummaryResponse,
    SeasonalSummaryResponse,
    SingleInsightResponse,
    UserDossierResponse,
    WeeklySummaryResponse,
    YearlySummaryResponse,
    wrap_output,
)

logger = structlog.get_logger()


@dataclass(frozen=True)
class LLMConfig:
    """
    Immutable LLM configuration containing model and agents.

    This is created once per worker and shared across all activities.

    `prompted_agents` mirrors `agents` but always uses PromptedOutput (schema in
    the prompt, parse the text reply). It is the fallback for backends that
    reject the configured output mode — e.g. vLLM deployments without
    structured-output/guided-decoding support choke on the `native` json_schema
    response_format that works on Ollama. Empty when the configured mode is
    already `prompted`.
    """

    model: OpenAIChatModel
    agents: dict[str, Agent]
    prompted_agents: dict[str, Agent] = field(default_factory=dict)


# name -> (structured output type, system prompt). Single source for both the
# configured-mode agents and their prompted-mode fallbacks.
AGENT_SPECS = {
    "hourly": (
        HourlySummaryResponse,
        (
            "You are an AI that creates concise hourly summaries of user activity. "
            "Analyze the data and provide insights, patterns, and notable events."
        ),
    ),
    "daily": (
        DailySummaryResponse,
        (
            "You synthesize hourly summaries into a daily overview. "
            "Focus on: daily rhythms and routines, workflow patterns, "
            "productivity peaks and valleys, social interactions, "
            "and how the day's activities connected together. "
            "Identify what made this day distinct or typical."
        ),
    ),
    "weekly": (
        WeeklySummaryResponse,
        (
            "You synthesize daily summaries into a weekly overview. "
            "Focus on: work-life balance, recurring weekly patterns, "
            "progress on projects or goals, social dynamics, "
            "behavioral trends across weekdays vs weekends. "
            "Identify how the week developed and key accomplishments or challenges."
        ),
    ),
    "monthly": (
        MonthlySummaryResponse,
        (
            "You synthesize weekly summaries into a monthly overview. "
            "Focus on: major milestones and achievements, evolving priorities, "
            "habit formation or changes, relationship developments, "
            "month-over-month growth or shifts in focus areas. "
            "Identify the arc of the month and significant transitions."
        ),
    ),
    "seasonal": (
        SeasonalSummaryResponse,
        (
            "You synthesize monthly summaries into a seasonal (3-month) overview. "
            "Focus on: life phase transitions, major project outcomes, "
            "seasonal behavioral patterns, strategic direction changes, "
            "personal or professional evolution. "
            "Identify the broader narrative arc and transformative themes of this quarter."
        ),
    ),
    "yearly": (
        YearlySummaryResponse,
        (
            "You synthesize seasonal summaries into a yearly overview. "
            "Focus on: annual achievements and setbacks, identity shifts, "
            "life trajectory changes, enduring patterns vs. experiments, "
            "key relationships and their evolution, personal growth themes. "
            "Provide a bird's-eye view of the year as a chapter in their life story."
        ),
    ),
    "dossier": (
        UserDossierResponse,
        (
            "Create a concise user dossier summarizing personality, preferences, "
            "challenges, and interests based on their activity. Keep summary under 500 characters."
        ),
    ),
    "insights": (
        InsightsResponse,
        (
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
    # Incremental variant of 'insights': one insight per call so each can be
    # stored (and surface on the feed) as soon as it is generated.
    "insight_single": (
        SingleInsightResponse,
        (
            "You are a proactive personal assistant that generates actionable insights. "
            "Analyze the user's recent activity, relationships, upcoming events, and changes "
            "to their knowledge graph to surface helpful suggestions they might not think of themselves.\n\n"
            "Focus on:\n"
            "- Upcoming dates (anniversaries, birthdays, deadlines) and relevant people\n"
            "- Recently added or changed relationships that might need attention\n"
            "- Patterns in behavior that suggest opportunities or needs\n"
            "- Connections between people, places, and events the user might not see\n"
            "- Timely reminders based on recurring activities or maintenance cycles\n\n"
            "The insight should be:\n"
            "- Actionable: Include specific next steps the user can take\n"
            "- Timely: Relevant to upcoming events or recent changes\n"
            "- Personal: Use knowledge about the user's relationships and preferences\n"
            "- Non-obvious: Connect dots the user might not see themselves\n\n"
            "Generate exactly ONE high-quality insight per response — the single most "
            "valuable one you have not already generated. The prompt lists any "
            "previously generated insights; your new insight must cover a clearly "
            "different topic. If no further distinct, high-quality insight exists, "
            "return a null insight instead of forcing a weak or duplicate one."
        ),
    ),
    "actions": (
        ActionsResponse,
        (
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


def create_llm_config() -> LLMConfig:
    """
    Create LLM configuration with all agents.

    This is a pure factory function that creates the configuration
    based on settings. It's called once when the worker starts.
    """
    # Create HTTP client with long timeout for LLM calls
    http_client = httpx.AsyncClient(timeout=180.0)

    # Create model pointing to self-hosted endpoint. The model name is the
    # configured (Hub-injected) one, else discovered from the endpoint.
    # Qwen3.x thinks by default. A dossier/insights call with thinking on
    # occupies vLLM's tiny `--max-num-seqs` budget for minutes and starves
    # interactive chat. Accoutrements do not need a reasoning trace.
    model = OpenAIChatModel(
        resolve_llm_model(),
        provider=OpenAIProvider(
            base_url=settings.llm_api_base,
            api_key=settings.llm_api_key,
            http_client=http_client,
        ),
        settings=OpenAIChatModelSettings(
            thinking=False,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        ),
    )

    agents = {
        name: Agent(
            model,
            output_type=wrap_output(response_type),
            retries=settings.output_retries,
            system_prompt=system_prompt,
        )
        for name, (response_type, system_prompt) in AGENT_SPECS.items()
    }

    # Prompted-mode fallbacks (see LLMConfig docstring). Skipped when prompted
    # is already the configured mode — there is nothing left to fall back to.
    prompted_agents = {}
    if resolve_output_mode() != "prompted":
        prompted_agents = {
            name: Agent(
                model,
                output_type=PromptedOutput(response_type),
                retries=settings.output_retries,
                system_prompt=system_prompt,
            )
            for name, (response_type, system_prompt) in AGENT_SPECS.items()
        }

    return LLMConfig(model=model, agents=agents, prompted_agents=prompted_agents)


def _is_structured_output_failure(exc: Exception) -> bool:
    """Does this look like the backend rejecting/fumbling the output mode?

    Two shapes matter in practice:
    - HTTP 4xx from backends without json_schema support (vLLM launched without
      structured-output/guided-decoding flags rejects `response_format`).
    - UnexpectedModelBehavior after pydantic-ai exhausted its schema-validation
      retries — the model kept producing output the enforced schema didn't
      accept, which prompted mode's laxer parse often survives.
    """
    if isinstance(exc, UnexpectedModelBehavior):
        return True

    if isinstance(exc, ModelHTTPError):
        if 400 <= exc.status_code < 500:
            return True
        text = str(exc).lower()
        return any(
            marker in text
            for marker in (
                "response_format",
                "json_schema",
                "structured output",
                "guided decoding",
            )
        )

    return False


NO_THINKING_EXTRA_BODY = {"chat_template_kwargs": {"enable_thinking": False}}


def _with_no_thinking(model_settings: dict) -> dict:
    extra = dict(model_settings.get("extra_body") or {})
    kwargs = dict(extra.get("chat_template_kwargs") or {})
    kwargs.setdefault("enable_thinking", False)
    extra["chat_template_kwargs"] = kwargs
    return {**model_settings, "thinking": False, "extra_body": extra}


def run_agent_sync(
    llm_config: LLMConfig, agent_name: str, prompt: str, model_settings: dict
):
    """Run the named agent, falling back to prompted output mode if the
    configured mode fails against this backend.

    The fallback is logged at error level on purpose: silent degradation is how
    "insights never show up" went undiagnosed. A persistent stream of these
    errors means SUMMARY_OUTPUT_MODE should be set to `prompted` for this
    deployment.
    """
    agent = llm_config.agents.get(agent_name)
    if not agent:
        raise ValueError(f"No agent configured for '{agent_name}'")

    settings_with_thinking_off = _with_no_thinking(model_settings)

    try:
        return agent.run_sync(prompt, model_settings=settings_with_thinking_off)
    except Exception as exc:
        fallback = llm_config.prompted_agents.get(agent_name)
        if fallback is None or not _is_structured_output_failure(exc):
            raise

        logger.error(
            "structured_output_failed_falling_back_to_prompted",
            agent=agent_name,
            output_mode=resolve_output_mode(),
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return fallback.run_sync(prompt, model_settings=settings_with_thinking_off)


@lru_cache(maxsize=1)
def get_llm_config() -> LLMConfig:
    """Return a cached LLM config to reuse clients across activities."""
    return create_llm_config()


__all__ = [
    "AGENT_SPECS",
    "LLMConfig",
    "create_llm_config",
    "get_llm_config",
    "run_agent_sync",
]
