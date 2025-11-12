"""LLM-based summarization using OpenAI-compatible API."""
import json
from datetime import datetime
import structlog
from typing import Dict, List, Any, Optional
from openai import OpenAI

from .config import settings

logger = structlog.get_logger()


class Summarizer:
    """Generates summaries using local LLM and embeddings."""
    
    def __init__(self):
        self.client = None
        self._init_error: Optional[Exception] = None
        try:
            self.client = OpenAI(
                base_url=settings.llm_api_base,
                api_key=settings.llm_api_key,
            )
            logger.info(
                "llm_client_initialized",
                base_url=settings.llm_api_base,
                model=settings.llm_model,
            )
        except Exception as exc:
            self._init_error = exc
            logger.error("llm_client_initialization_failed", error=str(exc))
    
    def generate_hourly_summary(self, aggregated_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Generate an hourly summary from aggregated data.
        
        Args:
            aggregated_data: Dictionary with all data sources for the hour
        
        Returns:
            Dictionary with summary text, insights, and statistics
        """
        self._ensure_client()

        logger.info("generating_hourly_summary",
                   user_id=aggregated_data.get("user_id"),
                   start=aggregated_data.get("start_time"))
        
        # Build structured prompt
        prompt = self._build_hourly_prompt(aggregated_data)
        
        try:
            response = self.client.chat.completions.create(
                model=settings.llm_model,
                messages=[
                    {
                        "role": "system",
                        "content": """You are an AI assistant that creates concise, insightful hourly summaries of user activity. 
Analyze the provided data and generate:
1. A narrative summary (2-3 sentences) describing the hour
2. 3-5 key insights or patterns
3. Notable events or activities
4. Any anomalies or interesting observations

Be factual and concise. Focus on what's meaningful and actionable."""
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=settings.llm_temperature,
                max_tokens=settings.llm_max_tokens,
            )
            
            summary_text = response.choices[0].message.content
            
            # Parse the response to extract structured information
            parsed = self._parse_summary_response(summary_text)
            
            # Generate embedding for the summary
            embedding = self.generate_embedding(summary_text)
            
            return {
                "summary_text": summary_text,
                "summary_type": "hourly",
                "key_insights": parsed.get("insights", []),
                "notable_events": parsed.get("events", []),
                "anomalies": parsed.get("anomalies", []),
                "embedding": embedding,
                "activity_counts": self._count_activities(aggregated_data),
                "tokens_used": response.usage.total_tokens if response.usage else 0,
            }
            
        except Exception as e:
            logger.error("summary_generation_failed", error=str(e))
            raise
    
    def _build_hourly_prompt(self, data: Dict[str, Any]) -> str:
        """Build the prompt for hourly summarization."""
        parts = [
            f"Time Period: {data['start_time']} to {data['end_time']}",
            f"User ID: {data['user_id']}",
            "",
        ]
        
        # Add measurements summary
        if data.get('measurements'):
            parts.append("SENSOR MEASUREMENTS:")
            for m in data['measurements'][:10]:  # Top 10
                parts.append(f"- {m['measurement_type']}: avg={m['avg_value']:.2f} {m['units']} (count={m['count']})")
            parts.append("")
        
        # Add location data
        if data.get('positions'):
            parts.append("LOCATIONS:")
            for p in data['positions'][:5]:  # Top 5
                activity = p['activity_type'] or 'unknown'
                parts.append(f"- {activity} activity (count={p['count']})")
            parts.append("")
        
        # Add communications
        if data.get('communications'):
            parts.append("COMMUNICATIONS:")
            for c in data['communications'][:10]:
                comm_type = c['communication_type']
                direction = c['direction']
                subject = c.get('subject', 'No subject')[:50]
                parts.append(f"- {comm_type} ({direction}): {subject}")
            parts.append("")
        
        # Add activities
        if data.get('activities'):
            parts.append("ACTIVITIES:")
            for a in data['activities'][:10]:
                name = a['activity_name']
                duration = a.get('duration_minutes', 'unknown')
                parts.append(f"- {name} ({duration} min)")
            parts.append("")
        
        # Add events
        if data.get('events'):
            parts.append("CALENDAR EVENTS:")
            for e in data['events'][:10]:
                title = e['title']
                event_type = e.get('event_type', 'event')
                parts.append(f"- {title} ({event_type})")
            parts.append("")
        
        # Add messages
        if data.get('messages'):
            parts.append("CHAT MESSAGES:")
            msg_count = len(data['messages'])
            parts.append(f"- {msg_count} messages exchanged")
            parts.append("")
        
        # Add file activity
        if data.get('files'):
            parts.append("FILE ACTIVITY:")
            for f in data['files'][:10]:
                filename = f['filename']
                parts.append(f"- {filename}")
            parts.append("")
        
        return "\n".join(parts)
    
    def _parse_summary_response(self, summary_text: str) -> Dict[str, Any]:
        """
        Parse the LLM response to extract structured information.
        This is a simple parser - could be enhanced with structured output.
        """
        # Simple extraction based on common patterns
        lines = summary_text.split('\n')
        
        insights = []
        events = []
        anomalies = []
        
        current_section = None
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            # Detect sections
            if 'insight' in line.lower() or 'key point' in line.lower():
                current_section = 'insights'
            elif 'event' in line.lower() or 'notable' in line.lower():
                current_section = 'events'
            elif 'anomal' in line.lower() or 'unusual' in line.lower():
                current_section = 'anomalies'
            elif line.startswith('-') or line.startswith('•'):
                # Bullet point
                item = line.lstrip('-•').strip()
                if current_section == 'insights':
                    insights.append(item)
                elif current_section == 'events':
                    events.append(item)
                elif current_section == 'anomalies':
                    anomalies.append(item)
        
        return {
            "insights": insights,
            "events": events,
            "anomalies": anomalies,
        }
    
    def generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for text using the embedding model."""
        self._ensure_client()
        try:
            response = self.client.embeddings.create(
                model=settings.embedding_model,
                input=text
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error("embedding_generation_failed", error=str(e))
            # Return zero vector on failure
            return [0.0] * settings.embedding_dimensions
    
    def _count_activities(self, data: Dict[str, Any]) -> Dict[str, int]:
        """Count activities by type."""
        counts = {
            "measurements": len(data.get('measurements', [])),
            "positions": len(data.get('positions', [])),
            "communications": len(data.get('communications', [])),
            "activities": len(data.get('activities', [])),
            "events": len(data.get('events', [])),
            "messages": len(data.get('messages', [])),
            "files": len(data.get('files', [])),
            "api_logs": len(data.get('api_logs', [])),
        }
        counts["total"] = sum(counts.values())
        return counts

    def _ensure_client(self):
        if self.client is None:
            error_msg = "LLM client is not initialized"
            if self._init_error:
                error_msg += f": {self._init_error}"
            raise RuntimeError(error_msg)

    def generate_history_summary(
        self,
        level: str,
        start_time: datetime,
        end_time: datetime,
        stats: Dict[str, Any],
        sample_entries: List[Dict[str, Any]],
    ) -> str:
        """Generate a browser-history specific inference."""
        logger.info(
            "generating_history_summary",
            level=level,
            start=start_time.isoformat(),
            end=end_time.isoformat(),
        )

        self._ensure_client()

        prompt = self._build_history_prompt(level, start_time, end_time, stats, sample_entries)

        try:
            response = self.client.chat.completions.create(
                model=settings.llm_model,
                messages=[
                    {
                        "role": "system",
                        "content": """You are a personal intelligence analyst. Given browser history data, infer what the user is likely working on, learning, or planning. Highlight intents, research threads, and context in 2-3 sentences.""",
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    },
                ],
                temperature=settings.llm_temperature,
                max_tokens=min(settings.llm_max_tokens, 400),
            )
            return response.choices[0].message.content.strip()
        except Exception as exc:
            logger.error("history_summary_generation_failed", error=str(exc))
            return ""

    def _build_history_prompt(
        self,
        level: str,
        start_time: datetime,
        end_time: datetime,
        stats: Dict[str, Any],
        sample_entries: List[Dict[str, Any]],
    ) -> str:
        lines = [
            f"Level: {level}",
            f"Window: {start_time.isoformat()} → {end_time.isoformat()}",
            f"Total Entries: {stats['total_entries']}",
            f"Unique Domains: {stats['unique_domains']}",
            f"Top Domains: {stats['top_domains'] or 'n/a'}",
            f"Top Titles: {stats['top_titles'] or 'n/a'}",
            f"Top Transitions: {stats['top_transitions'] or 'n/a'}",
            f"Typed Visits: {stats['typed_visits']}",
            "Sample Activity:",
        ]

        for entry in sample_entries[:5]:
            title = entry.get("title") or entry.get("url")
            domain = entry.get("domain", "unknown")
            timestamp = entry.get("timestamp")
            timestamp_str = timestamp.isoformat() if isinstance(timestamp, datetime) else str(timestamp)
            lines.append(f"- {timestamp_str} :: {title} ({domain})")

        lines.append("\nProvide a concise narrative of what the user is likely doing.")
        return "\n".join(lines)
    
    def generate_daily_summary(self, hourly_summaries: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Generate a daily summary from hourly summaries.
        
        Args:
            hourly_summaries: List of hourly summary dictionaries
        
        Returns:
            Dictionary with daily summary
        """
        logger.info("generating_daily_summary", num_hours=len(hourly_summaries))
        
        # Aggregate all hourly summaries
        all_text = "\n\n".join([
            f"Hour {i+1}: {s['summary_text']}" 
            for i, s in enumerate(hourly_summaries)
        ])
        
        try:
            response = self.client.chat.completions.create(
                model=settings.llm_model,
                messages=[
                    {
                        "role": "system",
                        "content": """You are an AI assistant that synthesizes multiple hourly summaries into a coherent daily summary.
Create a concise daily narrative that:
1. Highlights the main themes and patterns of the day
2. Identifies the most significant activities and events
3. Notes any trends or changes throughout the day
4. Provides actionable insights

Be factual and insightful. Focus on what's most meaningful."""
                    },
                    {
                        "role": "user",
                        "content": f"Synthesize these hourly summaries into a daily summary:\n\n{all_text}"
                    }
                ],
                temperature=settings.llm_temperature,
                max_tokens=settings.llm_max_tokens,
            )
            
            summary_text = response.choices[0].message.content
            embedding = self.generate_embedding(summary_text)
            
            # Aggregate activity counts
            total_counts = {
                "measurements": sum(s['activity_counts'].get('measurements', 0) for s in hourly_summaries),
                "positions": sum(s['activity_counts'].get('positions', 0) for s in hourly_summaries),
                "communications": sum(s['activity_counts'].get('communications', 0) for s in hourly_summaries),
                "activities": sum(s['activity_counts'].get('activities', 0) for s in hourly_summaries),
                "events": sum(s['activity_counts'].get('events', 0) for s in hourly_summaries),
                "messages": sum(s['activity_counts'].get('messages', 0) for s in hourly_summaries),
                "files": sum(s['activity_counts'].get('files', 0) for s in hourly_summaries),
                "api_logs": sum(s['activity_counts'].get('api_logs', 0) for s in hourly_summaries),
            }
            total_counts["total"] = sum(total_counts.values())
            
            return {
                "summary_text": summary_text,
                "summary_type": "daily",
                "embedding": embedding,
                "activity_counts": total_counts,
                "num_hourly_summaries": len(hourly_summaries),
                "tokens_used": response.usage.total_tokens if response.usage else 0,
            }
            
        except Exception as e:
            logger.error("daily_summary_generation_failed", error=str(e))
            raise
    
    def generate_weekly_summary(self, daily_summaries: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self.generate_period_rollup('weekly', 'daily', daily_summaries)

    def generate_period_rollup(
        self,
        period_label: str,
        child_label: str,
        child_summaries: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Generic rollup summary for weekly/monthly/seasonal/yearly."""
        logger.info(
            "generating_period_summary",
            period=period_label,
            child_count=len(child_summaries),
        )

        all_text = "\n\n".join([
            f"{child_label.title()} {i+1}: {s['summary_text']}"
            for i, s in enumerate(child_summaries)
        ])

        try:
            response = self.client.chat.completions.create(
                model=settings.llm_model,
                messages=[
                    {
                        "role": "system",
                        "content": f"""You are an AI assistant that synthesizes {child_label} summaries into a coherent {period_label} overview. Provide:
1. Dominant themes and highlights for the {period_label}
2. Key accomplishments or risks
3. Trends or shifts observed across the {child_label}s
4. Actionable insights or next steps

Deliver a concise, reflective narrative.""",
                    },
                    {
                        "role": "user",
                        "content": f"Synthesize these {child_label} summaries into a {period_label} summary:\n\n{all_text}",
                    },
                ],
                temperature=settings.llm_temperature,
                max_tokens=settings.llm_max_tokens,
            )

            summary_text = response.choices[0].message.content
            embedding = self.generate_embedding(summary_text)
            total_counts = self._aggregate_counts(child_summaries)

            return {
                "summary_text": summary_text,
                "summary_type": period_label,
                "embedding": embedding,
                "activity_counts": total_counts,
                "num_child_summaries": len(child_summaries),
                "tokens_used": response.usage.total_tokens if response.usage else 0,
            }
        except Exception as exc:
            logger.error("period_summary_generation_failed", period=period_label, error=str(exc))
            raise

    def _aggregate_counts(self, summaries: List[Dict[str, Any]]) -> Dict[str, int]:
        keys = [
            "measurements",
            "positions",
            "communications",
            "activities",
            "events",
            "messages",
            "files",
            "api_logs",
        ]
        totals = {key: 0 for key in keys}
        for summary in summaries:
            counts = summary.get('activity_counts', {})
            for key in keys:
                totals[key] += counts.get(key, 0)
        totals['total'] = sum(totals.values())
        return totals


# Global summarizer instance
summarizer = Summarizer()
