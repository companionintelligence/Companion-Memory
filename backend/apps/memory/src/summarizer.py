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
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .config import settings

logger = structlog.get_logger()


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


class RollupSummaryResponse(BaseModel):
    """Structured response for daily/weekly/monthly rollups."""
    summary_text: str = Field(description="Concise narrative synthesizing the period")
    key_themes: List[str] = Field(default_factory=list, description="Main themes of the period")
    notable_events: List[str] = Field(default_factory=list, description="Significant events")


class UserDossierResponse(BaseModel):
    """Structured response for user dossier."""
    summary: str = Field(description="Concise user summary")
    tone: Optional[str] = Field(default=None, description="User's communication tone")
    personalityTraits: Optional[List[str]] = Field(default=None, description="Observed personality traits")
    interactionGuidelines: Optional[List[str]] = Field(default=None, description="Best practices for interacting")
    preferences: Optional[List[str]] = Field(default=None, description="User preferences")
    challenges: Optional[List[str]] = Field(default=None, description="Challenges user is facing")
    interests: Optional[List[str]] = Field(default=None, description="Topics of interest")


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
            output_type=HourlySummaryResponse,
            system_prompt=(
                "You are an AI that creates concise hourly summaries of user activity. "
                "Analyze the data and provide insights, patterns, and notable events."
            ),
        )

        self.rollup_agent = Agent(
            self.model,
            output_type=RollupSummaryResponse,
            system_prompt=(
                "Synthesize summaries into a cohesive overview. "
                "Focus on themes, patterns, and significant events."
            ),
        )

        self.dossier_agent = Agent(
            self.model,
            output_type=UserDossierResponse,
            system_prompt=(
                "Create a concise user dossier summarizing personality, preferences, "
                "challenges, and interests based on their activity. Keep summary under 500 characters."
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
                       tokens=result.usage().total_tokens if result.usage() else 0)
        except Exception as exc:
            logger.error("llm_call_failed", error=str(exc), error_type=type(exc).__name__)
            raise

        # Extract validated response
        response = result.output
        embedding = self.generate_embedding(response.summary_text)

        return {
            "summary_text": response.summary_text,
            "summary_type": "hourly",
            "key_insights": response.key_insights,
            "events": response.notable_events,
            "anomalies": response.anomalies,
            "embedding": embedding,
            "activity_counts": activity_counts,
            "tokens_used": result.usage().total_tokens if result.usage() else 0,
        }

    def generate_daily_summary(self, hourly_summaries: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Generate daily summary from hourly summaries."""
        return self._generate_rollup("daily", hourly_summaries)

    def generate_period_rollup(
        self,
        period_type: str,
        child_summaries: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Generate rollup summary (weekly/monthly/etc) from child summaries."""
        return self._generate_rollup(period_type, child_summaries)

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

    def generate_history_summary(
        self,
        level: str,
        start_time: datetime,
        end_time: datetime,
        stats: Dict[str, Any],
        sample_entries: List[Dict[str, Any]],
    ) -> str:
        """Generate browser history summary (plain text, no structure)."""
        prompt = f"""
Browser activity: {start_time} to {end_time}
Total entries: {stats['total_entries']}
Unique domains: {stats['unique_domains']}
Top domains: {stats.get('top_domains', 'n/a')}

Sample activity:
{chr(10).join([f"- {e.get('title', e.get('url'))}" for e in sample_entries[:5]])}

What was the user likely doing? (2-3 sentences)
"""

        # Simple agent for unstructured text
        simple_agent = Agent(
            self.model,
            system_prompt="Infer user intent from browser history. Be concise.",
        )

        result = simple_agent.run_sync(
            prompt,
            model_settings={
                "temperature": settings.llm_temperature,
                "max_tokens": 400,
            },
        )

        return result.output if isinstance(result.output, str) else str(result.output)

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
        self, period_type: str, child_summaries: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Generic rollup for daily/weekly/monthly/etc."""
        combined_text = "\n\n".join(
            [
                f"Summary {i + 1}: {s.get('summary_text', '')}"
                for i, s in enumerate(child_summaries)
            ]
        )

        prompt = f"Synthesize these summaries into a {period_type} overview:\n\n{combined_text}"

        result = self.rollup_agent.run_sync(
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

        return {
            "summary_text": response.summary_text,
            "summary_type": period_type,
            "embedding": embedding,
            "activity_counts": total_counts,
            "num_child_summaries": len(child_summaries),
            "tokens_used": result.usage().total_tokens if result.usage() else 0,
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
