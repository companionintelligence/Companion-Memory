"""
Structured-output schemas for every LLM path, plus the user-dossier generator.

The pydantic response models below are the shared contract: llm_config.py wires
them into the agents that summary_functions.py runs, and that -- not this file
-- is where hourly summaries, rollups, insights and actions are generated.

This module used to carry a second, self-contained implementation of all of
those. Nothing called it, so it rotted invisibly: its prompt builders still
enumerated data sources (`measurements`, `activities`, `api_logs`,
`screen_captures`) that summary_sources.py has never emitted, and read a
`from_entity_id` that the insight queries stopped selecting -- while reading,
to anyone who opened this file first, as the authoritative implementation.
Those duplicates are gone. New generation logic belongs in
summary_functions.py; what stays here is `generate_user_dossier`, which
dossier_builder.py calls through the module-level `summarizer` singleton.
"""

from datetime import datetime
from typing import Any

import structlog
from pydantic import BaseModel, Field
from pydantic_ai import Agent, NativeOutput, PromptedOutput, ToolOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .config import resolve_llm_model, settings

logger = structlog.get_logger()


def wrap_output(response_type):
    """Wrap a structured output type in the configured pydantic-ai output mode.

    Local models behind Ollama choke on the default tool-calling path (the
    tool-call assistant message has content=null, which Ollama's OpenAI endpoint
    rejects), and small models fumble strict schemas. 'native' uses Ollama's
    json_schema response_format (server-enforced); 'prompted' puts the schema in
    the prompt and parses the text reply. Both avoid tool calls. See
    settings.output_mode (SUMMARY_OUTPUT_MODE).
    """
    mode = (settings.output_mode or "native").lower()
    if mode == "tool":
        return ToolOutput(response_type)
    if mode == "prompted":
        return PromptedOutput(response_type)
    return NativeOutput(response_type)


# ============================================================================
# Pydantic response models
# ============================================================================


class HourlySummaryResponse(BaseModel):
    """Structured response for hourly summaries."""

    summary_text: str = Field(description="2-3 sentence narrative summary of the hour")
    key_insights: list[str] = Field(
        default_factory=list, description="3-5 key insights or patterns"
    )
    notable_events: list[str] = Field(
        default_factory=list, description="Notable activities or events"
    )
    anomalies: list[str] = Field(
        default_factory=list, description="Unusual observations or anomalies"
    )
    tags: list[str] = Field(
        default_factory=list, description="Tags describing activities and content"
    )


class DailySummaryResponse(BaseModel):
    """Structured response for daily summaries."""

    summary_text: str = Field(description="Narrative summary of the day")
    daily_rhythm: list[str] = Field(
        default_factory=list, description="Patterns of activity across the day"
    )
    productivity_patterns: list[str] = Field(
        default_factory=list, description="Productivity peaks and valleys"
    )
    social_interactions: list[str] = Field(
        default_factory=list, description="Key social interactions"
    )
    key_accomplishments: list[str] = Field(
        default_factory=list, description="What got done today"
    )
    notable_events: list[str] = Field(
        default_factory=list, description="Significant events"
    )
    mood_indicators: list[str] | None = Field(
        default=None, description="Hints about emotional state"
    )


class WeeklySummaryResponse(BaseModel):
    """Structured response for weekly summaries."""

    summary_text: str = Field(description="Narrative summary of the week")
    work_life_balance: str | None = Field(
        default=None, description="Assessment of work-life balance this week"
    )
    recurring_patterns: list[str] = Field(
        default_factory=list, description="Patterns that repeated throughout the week"
    )
    project_progress: list[str] = Field(
        default_factory=list, description="Progress on ongoing projects or goals"
    )
    social_dynamics: list[str] = Field(
        default_factory=list, description="Relationship interactions and dynamics"
    )
    weekday_vs_weekend: str | None = Field(
        default=None, description="Behavioral differences between weekdays and weekend"
    )
    accomplishments: list[str] = Field(
        default_factory=list, description="Key accomplishments this week"
    )
    challenges: list[str] = Field(
        default_factory=list, description="Obstacles or difficulties faced"
    )


class MonthlySummaryResponse(BaseModel):
    """Structured response for monthly summaries."""

    summary_text: str = Field(description="Narrative arc of the month")
    major_milestones: list[str] = Field(
        default_factory=list, description="Significant achievements or events"
    )
    evolving_priorities: list[str] = Field(
        default_factory=list, description="How focus areas shifted during the month"
    )
    habit_changes: list[str] = Field(
        default_factory=list, description="New habits formed or old ones dropped"
    )
    relationship_developments: list[str] = Field(
        default_factory=list, description="How relationships evolved"
    )
    growth_areas: list[str] = Field(
        default_factory=list, description="Areas of personal or professional growth"
    )
    challenges: list[str] = Field(
        default_factory=list, description="Major challenges or setbacks"
    )


class SeasonalSummaryResponse(BaseModel):
    """Structured response for seasonal (quarterly) summaries."""

    summary_text: str = Field(description="Narrative arc of the quarter")
    life_transitions: list[str] = Field(
        default_factory=list, description="Major life phase changes or transitions"
    )
    major_outcomes: list[str] = Field(
        default_factory=list, description="Completed projects or major results"
    )
    behavioral_shifts: list[str] = Field(
        default_factory=list, description="Significant changes in behavior patterns"
    )
    strategic_changes: list[str] = Field(
        default_factory=list, description="Pivots in direction or priorities"
    )
    personal_evolution: list[str] = Field(
        default_factory=list,
        description="How personal or professional identity evolved",
    )
    transformative_themes: list[str] = Field(
        default_factory=list, description="Major themes that defined this quarter"
    )


class YearlySummaryResponse(BaseModel):
    """Structured response for yearly summaries."""

    summary_text: str = Field(
        description="Bird's-eye narrative of the year as a life chapter"
    )
    annual_achievements: list[str] = Field(
        default_factory=list, description="Major accomplishments of the year"
    )
    annual_challenges: list[str] = Field(
        default_factory=list, description="Significant setbacks or difficulties"
    )
    identity_shifts: list[str] = Field(
        default_factory=list, description="How sense of self changed"
    )
    trajectory_changes: list[str] = Field(
        default_factory=list, description="Changes in life direction or path"
    )
    relationship_evolution: list[str] = Field(
        default_factory=list, description="How key relationships changed over the year"
    )
    enduring_patterns: list[str] = Field(
        default_factory=list,
        description="Consistent behaviors or themes throughout the year",
    )
    growth_themes: list[str] = Field(
        default_factory=list, description="Overarching themes of personal growth"
    )


class UserDossierResponse(BaseModel):
    """Structured response for user dossier."""

    summary: str = Field(description="Concise user summary")
    tone: str | None = Field(default=None, description="User's communication tone")
    personalityTraits: list[str] | None = Field(
        default=None, description="Observed personality traits"
    )
    interactionGuidelines: list[str] | None = Field(
        default=None, description="Best practices for interacting"
    )
    preferences: list[str] | None = Field(default=None, description="User preferences")
    challenges: list[str] | None = Field(
        default=None, description="Challenges user is facing"
    )
    interests: list[str] | None = Field(default=None, description="Topics of interest")


class InsightItem(BaseModel):
    """A single proactive insight with actionable suggestions."""

    title: str = Field(
        description="Short, descriptive title for the insight (e.g., 'Anniversary Planning')"
    )
    summary_text: str = Field(
        description="2-3 sentence explanation of the insight and why it's relevant"
    )
    key_actions: list[str] = Field(
        description="3-5 specific, actionable suggestions the user can take"
    )
    relevance_score: float = Field(
        ge=0.0, le=1.0, description="How relevant/timely this insight is (0.0-1.0)"
    )
    tags: list[str] = Field(
        default_factory=list,
        description="Categories like 'Family', 'Work', 'Health', etc.",
    )
    related_entity_ids: list[str] | None = Field(
        default=None,
        description="UUIDs of people/events involved (extracted from the prompt context IDs)",
    )


class InsightsResponse(BaseModel):
    """Structured response for proactive insights generation."""

    insights: list[InsightItem] = Field(
        description="3-5 actionable insights based on the user's data"
    )
    data_sources_used: list[str] = Field(
        default_factory=list, description="Which data sources informed these insights"
    )


class SingleInsightResponse(BaseModel):
    """One insight per LLM call, so each can be stored (and shown) as it lands.

    `insight` is null when the model judges that no further distinct,
    high-quality insight exists — the generation loop's stop signal.
    """

    insight: InsightItem | None = Field(
        default=None,
        description="The single most valuable NEW insight not covered by previously generated ones, or null if none remains",
    )
    data_sources_used: list[str] = Field(
        default_factory=list, description="Which data sources informed this insight"
    )


class ActionItem(BaseModel):
    """A proactive action card suggestion.

    Two main types:
    - 'conversation_starter': A topic or question to spark interesting discussion
    - 'time_suggestion': A proactive suggestion for what the user should do next
    """

    title: str = Field(description="Short, engaging title (max 60 chars)")
    text: str = Field(
        description="The conversation prompt or suggestion details (1-2 sentences)"
    )
    priority: int = Field(
        description="Priority/relevance level 1-10, where 10 is most relevant right now"
    )
    tags: list[str] = Field(default_factory=list, description="Relevant topic tags")
    type: str = Field(description="Either 'conversation_starter' or 'time_suggestion'")
    context: str | None = Field(
        default=None, description="Why this is relevant now (based on recent activity)"
    )
    related_person: str | None = Field(
        default=None, description="Name of a person this relates to, if any"
    )


class ActionsResponse(BaseModel):
    """Structured response for action card generation."""

    actions: list[ActionItem] = Field(
        description="3-5 action cards: mix of conversation starters and time suggestions"
    )


# ============================================================================
# Summarizer
# ============================================================================


class Summarizer:
    """Generates the user dossier using the self-hosted LLM via PydanticAI.

    Only the dossier agent is built here. `summarizer = Summarizer()` runs at
    import time, and llm_config.py imports this module purely for the response
    models above, so every agent declared in __init__ is constructed on that
    import too -- agents for paths nobody calls are startup cost for nothing.
    """

    def __init__(self):
        # Create model pointing to your self-hosted endpoint
        # Use httpx async client with longer timeout for LLM calls
        import httpx

        http_client = httpx.AsyncClient(timeout=180.0)  # 3 minutes

        # Configured (Hub-injected) model, else discovered from the endpoint.
        self.model_name = resolve_llm_model()
        self.model = OpenAIChatModel(
            self.model_name,
            provider=OpenAIProvider(
                base_url=settings.llm_api_base,
                api_key=settings.llm_api_key,
                http_client=http_client,
            ),
        )

        self.dossier_agent = Agent(
            self.model,
            output_type=wrap_output(UserDossierResponse),
            retries=settings.output_retries,
            system_prompt=(
                "Create a concise user dossier summarizing personality, preferences, "
                "challenges, and interests based on their activity. Keep summary under 500 characters."
            ),
        )

        logger.info(
            "pydantic_ai_initialized",
            model=self.model_name,
            base_url=settings.llm_api_base,
        )

    def generate_user_dossier(
        self,
        user_id: str,
        lookback_start: datetime,
        lookback_end: datetime,
        timezone: str,
        daily_summaries: list[dict[str, Any]],
        hourly_summaries: list[dict[str, Any]],
        max_chars: int,
        previous_dossier: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Generate user dossier from recent summaries."""
        if not daily_summaries and not hourly_summaries:
            return None

        prompt = self._build_dossier_prompt(
            daily_summaries, hourly_summaries, previous_dossier
        )

        result = self.dossier_agent.run_sync(
            prompt,
            model_settings={
                "temperature": 0.2,
                "max_tokens": 1200,
            },
        )

        response = result.output

        # Truncate if needed
        summary = response.summary
        if len(summary) > max_chars:
            summary = summary[: max_chars - 3] + "..."

        return {
            "summary": summary,
            "tone": response.tone,
            "personalityTraits": response.personalityTraits,
            "interactionGuidelines": response.interactionGuidelines,
            "preferences": response.preferences,
            "challenges": response.challenges,
            "interests": response.interests,
            "lastUpdatedAt": datetime.utcnow().isoformat(),
            "version": 1,
            "sourceWindow": {
                "start": lookback_start.isoformat(),
                "end": lookback_end.isoformat(),
                "timezone": timezone,
            },
        }

    def _build_dossier_prompt(
        self,
        daily_summaries: list[dict[str, Any]],
        hourly_summaries: list[dict[str, Any]],
        previous_dossier: dict[str, Any] | None,
    ) -> str:
        """Build dossier prompt."""
        parts = ["Recent daily summaries:"]

        for summary in daily_summaries[-7:]:  # Last 7 days
            text = summary.get("summary_text", "")
            if text:
                parts.append(f"- {text[:200]}")

        if previous_dossier:
            parts.append("\nPrevious dossier (use as baseline):")
            parts.append(f"Summary: {previous_dossier.get('summary', '')[:300]}")

        parts.append(
            "\nCreate an updated user dossier with personality, preferences, challenges, interests."
        )
        return "\n".join(parts)


# Global summarizer instance
summarizer = Summarizer()

# Exported deliberately, and pinned by tests/test_summarizer_surface.py: the
# response models are llm_config.py's agent contract and `summarizer` is
# dossier_builder.py's entry point. Nothing else in here has a caller.
__all__ = [
    "ActionItem",
    "ActionsResponse",
    "DailySummaryResponse",
    "HourlySummaryResponse",
    "InsightItem",
    "InsightsResponse",
    "MonthlySummaryResponse",
    "SeasonalSummaryResponse",
    "SingleInsightResponse",
    "Summarizer",
    "UserDossierResponse",
    "WeeklySummaryResponse",
    "YearlySummaryResponse",
    "summarizer",
    "wrap_output",
]
