"""
LLM-based summarization using PydanticAI for structured outputs.

Uses PydanticAI agents to guarantee valid responses from any OpenAI-compatible API.
No OpenAI dependency, no manual JSON parsing, just type-safe responses.
"""
import structlog
import httpx
from typing import Dict, List, Any, Optional
from datetime import datetime
from pydantic import BaseModel, Field
from pydantic_ai import Agent, NativeOutput, PromptedOutput, ToolOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .config import settings

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
    key_insights: List[str] = Field(default_factory=list, description="3-5 key insights or patterns")
    notable_events: List[str] = Field(default_factory=list, description="Notable activities or events")
    anomalies: List[str] = Field(default_factory=list, description="Unusual observations or anomalies")
    tags: List[str] = Field(default_factory=list, description="Tags describing activities and content")


class DailySummaryResponse(BaseModel):
    """Structured response for daily summaries."""
    summary_text: str = Field(description="Narrative summary of the day")
    daily_rhythm: List[str] = Field(default_factory=list, description="Patterns of activity across the day")
    productivity_patterns: List[str] = Field(default_factory=list, description="Productivity peaks and valleys")
    social_interactions: List[str] = Field(default_factory=list, description="Key social interactions")
    key_accomplishments: List[str] = Field(default_factory=list, description="What got done today")
    notable_events: List[str] = Field(default_factory=list, description="Significant events")
    mood_indicators: Optional[List[str]] = Field(default=None, description="Hints about emotional state")


class WeeklySummaryResponse(BaseModel):
    """Structured response for weekly summaries."""
    summary_text: str = Field(description="Narrative summary of the week")
    work_life_balance: Optional[str] = Field(default=None, description="Assessment of work-life balance this week")
    recurring_patterns: List[str] = Field(default_factory=list, description="Patterns that repeated throughout the week")
    project_progress: List[str] = Field(default_factory=list, description="Progress on ongoing projects or goals")
    social_dynamics: List[str] = Field(default_factory=list, description="Relationship interactions and dynamics")
    weekday_vs_weekend: Optional[str] = Field(default=None, description="Behavioral differences between weekdays and weekend")
    accomplishments: List[str] = Field(default_factory=list, description="Key accomplishments this week")
    challenges: List[str] = Field(default_factory=list, description="Obstacles or difficulties faced")


class MonthlySummaryResponse(BaseModel):
    """Structured response for monthly summaries."""
    summary_text: str = Field(description="Narrative arc of the month")
    major_milestones: List[str] = Field(default_factory=list, description="Significant achievements or events")
    evolving_priorities: List[str] = Field(default_factory=list, description="How focus areas shifted during the month")
    habit_changes: List[str] = Field(default_factory=list, description="New habits formed or old ones dropped")
    relationship_developments: List[str] = Field(default_factory=list, description="How relationships evolved")
    growth_areas: List[str] = Field(default_factory=list, description="Areas of personal or professional growth")
    challenges: List[str] = Field(default_factory=list, description="Major challenges or setbacks")


class SeasonalSummaryResponse(BaseModel):
    """Structured response for seasonal (quarterly) summaries."""
    summary_text: str = Field(description="Narrative arc of the quarter")
    life_transitions: List[str] = Field(default_factory=list, description="Major life phase changes or transitions")
    major_outcomes: List[str] = Field(default_factory=list, description="Completed projects or major results")
    behavioral_shifts: List[str] = Field(default_factory=list, description="Significant changes in behavior patterns")
    strategic_changes: List[str] = Field(default_factory=list, description="Pivots in direction or priorities")
    personal_evolution: List[str] = Field(default_factory=list, description="How personal or professional identity evolved")
    transformative_themes: List[str] = Field(default_factory=list, description="Major themes that defined this quarter")


class YearlySummaryResponse(BaseModel):
    """Structured response for yearly summaries."""
    summary_text: str = Field(description="Bird's-eye narrative of the year as a life chapter")
    annual_achievements: List[str] = Field(default_factory=list, description="Major accomplishments of the year")
    annual_challenges: List[str] = Field(default_factory=list, description="Significant setbacks or difficulties")
    identity_shifts: List[str] = Field(default_factory=list, description="How sense of self changed")
    trajectory_changes: List[str] = Field(default_factory=list, description="Changes in life direction or path")
    relationship_evolution: List[str] = Field(default_factory=list, description="How key relationships changed over the year")
    enduring_patterns: List[str] = Field(default_factory=list, description="Consistent behaviors or themes throughout the year")
    growth_themes: List[str] = Field(default_factory=list, description="Overarching themes of personal growth")


class UserDossierResponse(BaseModel):
    """Structured response for user dossier."""
    summary: str = Field(description="Concise user summary")
    tone: Optional[str] = Field(default=None, description="User's communication tone")
    personalityTraits: Optional[List[str]] = Field(default=None, description="Observed personality traits")
    interactionGuidelines: Optional[List[str]] = Field(default=None, description="Best practices for interacting")
    preferences: Optional[List[str]] = Field(default=None, description="User preferences")
    challenges: Optional[List[str]] = Field(default=None, description="Challenges user is facing")
    interests: Optional[List[str]] = Field(default=None, description="Topics of interest")


class InsightItem(BaseModel):
    """A single proactive insight with actionable suggestions."""
    title: str = Field(description="Short, descriptive title for the insight (e.g., 'Anniversary Planning')")
    summary_text: str = Field(description="2-3 sentence explanation of the insight and why it's relevant")
    key_actions: List[str] = Field(description="3-5 specific, actionable suggestions the user can take")
    relevance_score: float = Field(ge=0.0, le=1.0, description="How relevant/timely this insight is (0.0-1.0)")
    tags: List[str] = Field(default_factory=list, description="Categories like 'Family', 'Work', 'Health', etc.")
    related_entity_ids: Optional[List[str]] = Field(default=None, description="UUIDs of people/events involved (extracted from the prompt context IDs)")


class InsightsResponse(BaseModel):
    """Structured response for proactive insights generation."""
    insights: List[InsightItem] = Field(description="3-5 actionable insights based on the user's data")
    data_sources_used: List[str] = Field(default_factory=list, description="Which data sources informed these insights")


class ActionItem(BaseModel):
    """A proactive action card suggestion.

    Two main types:
    - 'conversation_starter': A topic or question to spark interesting discussion
    - 'time_suggestion': A proactive suggestion for what the user should do next
    """
    title: str = Field(description="Short, engaging title (max 60 chars)")
    text: str = Field(description="The conversation prompt or suggestion details (1-2 sentences)")
    priority: int = Field(description="Priority/relevance level 1-10, where 10 is most relevant right now")
    tags: List[str] = Field(default_factory=list, description="Relevant topic tags")
    type: str = Field(description="Either 'conversation_starter' or 'time_suggestion'")
    context: Optional[str] = Field(default=None, description="Why this is relevant now (based on recent activity)")
    related_person: Optional[str] = Field(default=None, description="Name of a person this relates to, if any")


class ActionsResponse(BaseModel):
    """Structured response for action card generation."""
    actions: List[ActionItem] = Field(
        description="3-5 action cards: mix of conversation starters and time suggestions"
    )


# ============================================================================
# Summarizer
# ============================================================================

class Summarizer:
    """Generates summaries using self-hosted LLM via PydanticAI."""

    def __init__(self):
        # Create model pointing to your self-hosted endpoint
        # Use httpx async client with longer timeout for LLM calls
        import httpx
        http_client = httpx.AsyncClient(timeout=180.0)  # 3 minutes

        self.model = OpenAIChatModel(
            settings.llm_model,
            provider=OpenAIProvider(
                base_url=settings.llm_api_base,
                api_key=settings.llm_api_key,
                http_client=http_client,
            ),
        )

        # Create agents for each summary type
        self.hourly_agent = Agent(
            self.model,
            output_type=wrap_output(HourlySummaryResponse), retries=settings.output_retries,
            system_prompt=(
                "You are an AI that creates concise hourly summaries of user activity. "
                "Analyze the data and provide insights, patterns, and notable events."
            ),
        )

        # Time-scale specific agents
        self.daily_agent = Agent(
            self.model,
            output_type=wrap_output(DailySummaryResponse), retries=settings.output_retries,
            system_prompt=(
                "You synthesize hourly summaries into a daily overview. "
                "Focus on: daily rhythms and routines, workflow patterns, "
                "productivity peaks and valleys, social interactions, "
                "and how the day's activities connected together. "
                "Identify what made this day distinct or typical."
            ),
        )

        self.weekly_agent = Agent(
            self.model,
            output_type=wrap_output(WeeklySummaryResponse), retries=settings.output_retries,
            system_prompt=(
                "You synthesize daily summaries into a weekly overview. "
                "Focus on: work-life balance, recurring weekly patterns, "
                "progress on projects or goals, social dynamics, "
                "behavioral trends across weekdays vs weekends. "
                "Identify how the week developed and key accomplishments or challenges."
            ),
        )

        self.monthly_agent = Agent(
            self.model,
            output_type=wrap_output(MonthlySummaryResponse), retries=settings.output_retries,
            system_prompt=(
                "You synthesize weekly summaries into a monthly overview. "
                "Focus on: major milestones and achievements, evolving priorities, "
                "habit formation or changes, relationship developments, "
                "month-over-month growth or shifts in focus areas. "
                "Identify the arc of the month and significant transitions."
            ),
        )

        self.seasonal_agent = Agent(
            self.model,
            output_type=wrap_output(SeasonalSummaryResponse), retries=settings.output_retries,
            system_prompt=(
                "You synthesize monthly summaries into a seasonal (3-month) overview. "
                "Focus on: life phase transitions, major project outcomes, "
                "seasonal behavioral patterns, strategic direction changes, "
                "personal or professional evolution. "
                "Identify the broader narrative arc and transformative themes of this quarter."
            ),
        )

        self.yearly_agent = Agent(
            self.model,
            output_type=wrap_output(YearlySummaryResponse), retries=settings.output_retries,
            system_prompt=(
                "You synthesize seasonal summaries into a yearly overview. "
                "Focus on: annual achievements and setbacks, identity shifts, "
                "life trajectory changes, enduring patterns vs. experiments, "
                "key relationships and their evolution, personal growth themes. "
                "Provide a bird's-eye view of the year as a chapter in their life story."
            ),
        )

        self.dossier_agent = Agent(
            self.model,
            output_type=wrap_output(UserDossierResponse), retries=settings.output_retries,
            system_prompt=(
                "Create a concise user dossier summarizing personality, preferences, "
                "challenges, and interests based on their activity. Keep summary under 500 characters."
            ),
        )

        self.insights_agent = Agent(
            self.model,
            output_type=wrap_output(InsightsResponse), retries=settings.output_retries,
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
        )

        self.action_agent = Agent(
            self.model,
            output_type=wrap_output(ActionsResponse), retries=settings.output_retries,
            system_prompt=(
                "You are an AI assistant that facilitates proactive engagement. "
                "Based on the user's recent context, suggest 3 Conversation Starters or Planning Cycles. "
                "Conversation Starters should be thought-provoking questions or topics based on recent events or interests. "
                "Planning Cycles should be review prompts for projects, goals, or weekly reflections.\n"
                "Ensure variety and relevance. Use a friendly and encouraging tone."
            ),
        )

        logger.info("pydantic_ai_initialized", model=settings.llm_model, base_url=settings.llm_api_base)

    def generate_hourly_summary(self, aggregated_data: Dict[str, Any]) -> Dict[str, Any]:
        """Generate hourly summary from aggregated data."""
        activity_counts = self._count_activities(aggregated_data)

        if activity_counts.get("total", 0) == 0:
            return {
                "summary_text": "No activity recorded during this window.",
                "summary_type": "hourly",
                "key_insights": [],
                "events": [],
                "anomalies": [],
                "embedding": self.generate_embedding("No activity"),
                "activity_counts": activity_counts,
                "tokens_used": 0,
            }

        # Build prompt
        prompt = self._build_data_prompt(aggregated_data, activity_counts)
        logger.info("calling_llm_for_summary",
                   model=settings.llm_model,
                   base_url=settings.llm_api_base,
                   prompt_length=len(prompt))

        # Run agent (automatically retries and validates)
        try:
            result = self.hourly_agent.run_sync(
                prompt,
                model_settings={
                    "temperature": settings.llm_temperature,
                    "max_tokens": settings.llm_max_tokens,
                },
            )
            logger.info("llm_response_received",
                       tokens=result.usage.total_tokens if result.usage else 0)
        except Exception as exc:
            logger.error("llm_call_failed", error=str(exc), error_type=type(exc).__name__)
            raise

        # Extract validated response
        response = result.output
        embedding = self.generate_embedding(response.summary_text)

        # Convert Pydantic response to dict to capture all structured fields
        response_dict = response.model_dump(exclude_none=True)

        return {
            "summary_text": response.summary_text,
            "summary_type": "hourly",
            "key_insights": response.key_insights,
            "events": response.notable_events,
            "anomalies": response.anomalies,
            "structured_data": response_dict,  # Store all structured fields
            "embedding": embedding,
            "activity_counts": activity_counts,
            "tokens_used": result.usage.total_tokens if result.usage else 0,
        }

    def generate_daily_summary(self, hourly_summaries: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Generate daily summary from hourly summaries."""
        return self._generate_rollup("daily", hourly_summaries, self.daily_agent)

    def generate_period_rollup(
        self,
        period_type: str,
        child_summaries: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Generate rollup summary (weekly/monthly/etc) from child summaries."""
        # Select the appropriate time-scale specific agent
        agent_map = {
            'weekly': self.weekly_agent,
            'monthly': self.monthly_agent,
            'seasonal': self.seasonal_agent,
            'yearly': self.yearly_agent,
        }
        agent = agent_map.get(period_type, self.daily_agent)
        return self._generate_rollup(period_type, child_summaries, agent)

    def generate_user_dossier(
        self,
        user_id: str,
        lookback_start: datetime,
        lookback_end: datetime,
        timezone: str,
        daily_summaries: List[Dict[str, Any]],
        hourly_summaries: List[Dict[str, Any]],
        max_chars: int,
        previous_dossier: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Generate user dossier from recent summaries."""
        if not daily_summaries and not hourly_summaries:
            return None

        prompt = self._build_dossier_prompt(daily_summaries, hourly_summaries, previous_dossier)

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

    def generate_insights(self, insights_context: Dict[str, Any]) -> Dict[str, Any]:
        """Generate proactive insights from aggregated context data.

        Args:
            insights_context: Dict containing:
                - graph_deltas: Recent changes to entities/relationships
                - upcoming_events: Events in the next 14 days
                - recent_summaries: Recent activity summaries
                - strongest_relationships: Top relationships by strength
                - recently_changed_relationships: Recently modified relationships
                - event_relevant_relationships: Relationships tied to upcoming events
                - recent_communications: Recent messages/emails
                - user_dossier: User's profile/preferences

        Returns:
            Dict with insights, embeddings, and metadata
        """
        prompt = self._build_insights_prompt(insights_context)

        logger.info(
            "calling_llm_for_insights",
            model=settings.llm_model,
            prompt_length=len(prompt),
        )

        try:
            result = self.insights_agent.run_sync(
                prompt,
                model_settings={
                    "temperature": 0.7,  # Slightly higher for creative suggestions
                    "max_tokens": settings.llm_max_tokens,
                },
            )
            logger.info(
                "insights_response_received",
                tokens=result.usage.total_tokens if result.usage else 0,
                num_insights=len(result.output.insights),
            )
        except Exception as exc:
            logger.error("insights_generation_failed", error=str(exc), error_type=type(exc).__name__)
            raise

        response = result.output

        # Generate embedding from combined insight text
        combined_text = " ".join([i.title + ": " + i.summary_text for i in response.insights])
        embedding = self.generate_embedding(combined_text)

        # Convert to serializable format
        insights_list = [item.model_dump() for item in response.insights]

        return {
            "insights": insights_list,
            "data_sources_used": response.data_sources_used,
            "embedding": embedding,
            "tokens_used": result.usage.total_tokens if result.usage else 0,
            "num_insights": len(response.insights),
        }

    def generate_actions(self, context: Dict[str, Any]) -> Dict[str, Any]:
        """Generate proactive actions from context."""
        # Reuse insights prompt builder for now as it contains similar context
        prompt = self._build_insights_prompt(context)
        prompt += "\nBased on this context, generate appropriate Action Cards (Conversation Starters or Planning Cycles)."

        logger.info(
            "calling_llm_for_actions",
            model=settings.llm_model,
            prompt_length=len(prompt),
        )

        try:
            result = self.action_agent.run_sync(
                prompt,
                model_settings={
                    "temperature": 0.8,
                    "max_tokens": settings.llm_max_tokens,
                },
            )
            logger.info(
                "actions_response_received",
                tokens=result.usage.total_tokens if result.usage else 0,
                num_actions=len(result.output.actions),
            )
        except Exception as exc:
            logger.error("actions_generation_failed", error=str(exc), error_type=type(exc).__name__)
            raise

        response = result.output
        actions_list = [item.model_dump() for item in response.actions]

        return {
            "actions": actions_list,
            "tokens_used": result.usage.total_tokens if result.usage else 0,
        }

    def _build_insights_prompt(self, context: Dict[str, Any]) -> str:
        """Build prompt for insights generation from aggregated context."""
        parts = ["Generate proactive insights based on the following user context:\n"]

        # User dossier (personality/preferences)
        dossier = context.get("user_dossier")
        if dossier:
            parts.append("## USER PROFILE")
            parts.append(f"Summary: {dossier.get('summary', 'N/A')}")
            if dossier.get("interests"):
                parts.append(f"Interests: {', '.join(dossier['interests'][:5])}")
            if dossier.get("preferences"):
                parts.append(f"Preferences: {', '.join(dossier['preferences'][:5])}")
            parts.append("")

        # Upcoming events
        events = context.get("upcoming_events", [])
        if events:
            parts.append("## UPCOMING EVENTS (next 14 days)")
            for event in events[:10]:
                start = event.get("start_time") or event.get("start_date", "")
                title = event.get("title") or event.get("name", "Untitled")
                eid = event.get("id") or ""
                parts.append(f"- {start}: {title} (ID: {eid})")
            parts.append("")

        # Graph deltas (recent changes)
        deltas = context.get("graph_deltas", [])
        if deltas:
            parts.append("## RECENT CHANGES TO KNOWLEDGE GRAPH")
            for delta in deltas[:15]:
                change_type = delta.get("change_type", "unknown")
                node_type = delta.get("node_type", "")
                entity_type = delta.get("entity_type") or delta.get("relationship_type", "")
                changed_fields = delta.get("changed_fields", {})
                eid = delta.get("entity_id") or delta.get("from_entity_id") or ""

                if node_type == "entity":
                    name = changed_fields.get("name", {}).get("new") or changed_fields.get("name", {}).get("old", "Unknown")
                    parts.append(f"- {change_type.upper()} {entity_type}: {name} (ID: {eid})")
                else:
                    parts.append(f"- {change_type.upper()} relationship: {entity_type} (ID: {eid})")
            parts.append("")

        # Strongest relationships
        strongest = context.get("strongest_relationships", [])
        if strongest:
            parts.append("## CLOSEST RELATIONSHIPS (by strength)")
            for rel in strongest[:3]:
                eid = rel.get("to_entity_id") or ""
                parts.append(f"- {rel.get('name', 'Unknown')} ({rel.get('relationship_type', 'related')}) (ID: {eid})")
            parts.append("")

        # Recently changed relationships
        recent_rels = context.get("recently_changed_relationships", [])
        if recent_rels:
            parts.append("## RECENTLY CHANGED RELATIONSHIPS")
            for rel in recent_rels[:5]:
                change = rel.get("change_type", "updated")
                name = rel.get("name", "Unknown")
                eid = rel.get("entity_id") or ""
                parts.append(f"- {change}: {name} (ID: {eid})")
            parts.append("")

        # Event-relevant relationships (people tied to upcoming events)
        event_rels = context.get("event_relevant_relationships", [])
        if event_rels:
            parts.append("## PEOPLE CONNECTED TO UPCOMING EVENTS")
            for rel in event_rels[:5]:
                name = rel.get("name", "Unknown")
                eid = rel.get("entity_id") or ""
                event = rel.get("event_title", "")
                parts.append(f"- {name} (ID: {eid}): {event}")
            parts.append("")

        # Recent summaries (patterns)
        summaries = context.get("recent_summaries", [])
        if summaries:
            parts.append("## RECENT ACTIVITY PATTERNS")
            for summary in summaries[:5]:
                text = summary.get("summary_text", "")[:200]
                if text:
                    parts.append(f"- {text}")
            parts.append("")

        # Recent communications
        comms = context.get("recent_communications", [])
        if comms:
            parts.append("## RECENT COMMUNICATIONS")
            for comm in comms[:5]:
                subject = comm.get("subject") or comm.get("title", "")[:50]
                from_id = comm.get("from_entity_id") or ""
                if subject:
                    parts.append(f"- {subject} (From ID: {from_id})")
            parts.append("")

        parts.append("\nBased on this context, generate 3-5 actionable insights that would be helpful to the user.")
        parts.append("Focus on upcoming opportunities, relationship maintenance, and timely suggestions.")

        return "\n".join(parts)

    def generate_embedding(self, text: str) -> List[float]:
        """Generate embedding using OpenAI-compatible embedding endpoint."""
        try:
            # Direct HTTP call to embedding endpoint (no openai dependency)
            with httpx.Client(timeout=30.0) as client:
                response = client.post(
                    f"{settings.llm_api_base}/embeddings",
                    headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                    json={
                        "model": settings.embedding_model,
                        "input": text,
                    },
                )
                response.raise_for_status()
                data = response.json()
                return data["data"][0]["embedding"]
        except Exception as exc:
            logger.error("embedding_generation_failed", error=str(exc))
            return [0.0] * settings.embedding_dimensions

    # ========================================================================
    # Internal helpers
    # ========================================================================

    def _generate_rollup(
        self, period_type: str, child_summaries: List[Dict[str, Any]], agent: Agent
    ) -> Dict[str, Any]:
        """Generic rollup for daily/weekly/monthly/etc using specified time-scale agent."""
        combined_text = "\n\n".join(
            [
                f"Summary {i + 1}: {s.get('summary_text', '')}"
                for i, s in enumerate(child_summaries)
            ]
        )

        prompt = f"Synthesize these summaries into a {period_type} overview:\n\n{combined_text}"

        result = agent.run_sync(
            prompt,
            model_settings={
                "temperature": settings.llm_temperature,
                "max_tokens": settings.llm_max_tokens,
            },
        )

        response = result.output
        embedding = self.generate_embedding(response.summary_text)

        # Aggregate counts
        total_counts = {}
        for summary in child_summaries:
            counts = summary.get("activity_counts", {})
            for key, value in counts.items():
                total_counts[key] = total_counts.get(key, 0) + value

        # Convert Pydantic response to dict to capture all structured fields
        response_dict = response.model_dump(exclude_none=True)

        return {
            "summary_text": response.summary_text,
            "summary_type": period_type,
            "structured_data": response_dict,  # Store all structured fields
            "embedding": embedding,
            "activity_counts": total_counts,
            "num_child_summaries": len(child_summaries),
            "tokens_used": result.usage.total_tokens if result.usage else 0,
        }

    def _build_data_prompt(self, data: Dict[str, Any], counts: Dict[str, int]) -> str:
        """Build prompt from aggregated data."""
        parts = [
            f"Time: {data['start_time']} to {data['end_time']}",
            f"User: {data['user_id']}",
            "",
            "Activity counts:",
        ]

        for key, count in counts.items():
            if key != "total" and count > 0:
                parts.append(f"- {key}: {count}")

        parts.append("")

        # Add sample data from each category
        for category in [
            "measurements",
            "events",
            "communications",
            "activities",
            "messages",
            "files",
            "browser_activity",
        ]:
            items = data.get(category, [])
            if items:
                parts.append(f"{category.upper()}:")
                for item in items[:5]:  # Top 5
                    parts.append(f"- {self._format_item(item)}")
                parts.append("")

        return "\n".join(parts)

    def _build_dossier_prompt(
        self,
        daily_summaries: List[Dict[str, Any]],
        hourly_summaries: List[Dict[str, Any]],
        previous_dossier: Optional[Dict[str, Any]],
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

    def _format_item(self, item: Dict[str, Any]) -> str:
        """Format a data item for prompt."""
        if "title" in item:
            return item["title"]
        if "activity_name" in item:
            return item["activity_name"]
        if "subject" in item:
            return item.get("subject", "")[:50]
        if "filename" in item:
            return item["filename"]
        if "url" in item:
            return item.get("url", "")[:50]
        return str(item)[:50]

    def _count_activities(self, data: Dict[str, Any]) -> Dict[str, int]:
        """Count activities by category."""
        counts = {
            key: len(data.get(key, []))
            for key in [
                "measurements",
                "positions",
                "communications",
                "activities",
                "events",
                "messages",
                "files",
                "api_logs",
                "browser_activity",
                "screen_captures",
            ]
        }
        counts["total"] = sum(counts.values())
        return counts


# Global summarizer instance
summarizer = Summarizer()

__all__ = ["summarizer", "Summarizer"]
