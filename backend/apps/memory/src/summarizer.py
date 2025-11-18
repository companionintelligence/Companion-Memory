"""LLM-based summarization using OpenAI-compatible API."""
import json
import re
from datetime import datetime
import structlog
from typing import Dict, List, Any, Optional, Tuple
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

        logger.info(
            "generating_hourly_summary",
            user_id=aggregated_data.get("user_id"),
            start=aggregated_data.get("start_time"),
        )

        activity_counts = self._count_activities(aggregated_data)
        logger.info("hourly_activity_counts", counts=activity_counts)

        if activity_counts.get("total", 0) == 0:
            logger.info(
                "skipping_hourly_summary_no_data",
                user_id=aggregated_data.get("user_id"),
                start=aggregated_data.get("start_time"),
                end=aggregated_data.get("end_time"),
            )
            structured = {
                "summary": {
                    "narrative": "No activity recorded during this window.",
                    "insights": [],
                    "notable_events": [],
                    "anomalies": [],
                    "tags": [],
                }
            }
            summary_text = json.dumps(structured, ensure_ascii=False)
            embedding = self.generate_embedding(summary_text)
            return {
                "summary_text": summary_text,
                "summary_type": "hourly",
                "key_insights": [],
                "notable_events": [],
                "anomalies": [],
                "embedding": embedding,
                "activity_counts": activity_counts,
                "tokens_used": 0,
                "structured_summary": structured,
            }

        # Build structured prompt
        prompt = self._build_hourly_prompt(aggregated_data, activity_counts)

        messages = [
            {
                "role": "system",
                "content": """You are an AI summarizer that creates concise, insightful hourly summaries of user activity.
You infer behavior and describe without opinion or bias. You will be given incomplete data and you must infer what the user is doing.
Analyze the provided data and generate:
1. A narrative summary (2-3 sentences) describing the hour
2. 3-5 key insights and/or patterns
3. Notable events and/or activities
4. Any anomalies or interesting observations
5. A list of tags that describe the events, content, and activities.

Be factual and concise. Focus on what's meaningful and actionable.
Response must be valid JSON (no markdown/code fences) with nested sections.
If there is no data to summarize, return an empty JSON object."""
            },
            {
                "role": "user",
                "content": prompt
            }
        ]

        if settings.debug_prompts:
            self._log_prompt("hourly", messages)

        chat_kwargs = {
            "model": settings.llm_model,
            "messages": messages,
            "temperature": settings.llm_temperature,
            "max_tokens": settings.llm_max_tokens,
        }

        try:
            self._log_llm_request("chat.completions.create", chat_kwargs)
            response = self.client.chat.completions.create(**chat_kwargs)

            raw_response = response.choices[0].message.content

            summary_text, structured = self._coerce_json_summary(raw_response)

            # Parse the response to extract structured information
            parsed = self._parse_structured_or_text(structured, raw_response)

            # Generate embedding for the summary
            embedding = self.generate_embedding(summary_text)

            return {
                "summary_text": summary_text,
                "summary_type": "hourly",
                "key_insights": parsed.get("insights", []),
                "events": parsed.get("events", parsed.get("notable_events", [])),
                "anomalies": parsed.get("anomalies", []),
                "embedding": embedding,
                "activity_counts": activity_counts,
                "tokens_used": response.usage.total_tokens if response.usage else 0,
                "structured_summary": structured,
            }

        except Exception as e:
            logger.error("summary_generation_failed", error=str(e))
            raise

    def _build_hourly_prompt(self, data: Dict[str, Any], activity_counts: Dict[str, int]) -> str:
        """Build the prompt for hourly summarization."""
        parts = [
            f"Time Period: {data['start_time']} to {data['end_time']}",
            f"User ID: {data['user_id']}",
            "",
        ]

        non_zero_counts = [
            f"- {key.replace('_', ' ')}: {count}"
            for key, count in activity_counts.items()
            if key != "total" and count
        ]
        if non_zero_counts:
            parts.append("DATA COUNTS:")
            parts.extend(non_zero_counts)
            parts.append("")

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

        # Add browser activity
        if data.get('browser_activity'):
            parts.append("BROWSER ACTIVITY:")
            for entry in data['browser_activity'][:10]:
                domain = entry.get('domain') or 'unknown'
                title = entry.get('title') or entry.get('url') or domain
                action = entry.get('action_type') or 'visit'
                duration = entry.get('duration_seconds')
                category = entry.get('category') or 'uncategorized'
                duration_text = f", {duration}s" if duration is not None else ""
                parts.append(
                    f"- {title} ({domain}) [{action}{duration_text}, category={category}]"
                )
                summary = (entry.get('page_summary') or '').strip()
                if summary:
                    parts.append(f"  ↳ {summary[:200]}")
            parts.append("")

        # Add screen captures
        if data.get('screen_captures'):
            parts.append("SCREEN CAPTURES:")
            for capture in data['screen_captures'][:5]:
                timestamp = capture.get('time')
                timestamp_text = timestamp.isoformat() if hasattr(timestamp, 'isoformat') else str(timestamp)
                primary_app = capture.get('primary_application') or 'unknown app'
                category = capture.get('activity_category') or 'uncategorized'
                flags = []
                if capture.get('contains_sensitive'):
                    flags.append('sensitive')
                if capture.get('contains_pii'):
                    flags.append('pii')
                if capture.get('redacted'):
                    flags.append('redacted')
                flag_text = f" ({', '.join(flags)})" if flags else ''
                parts.append(f"- {timestamp_text}: {primary_app} [{category}]{flag_text}")
                summary = (capture.get('activity_summary') or capture.get('ocr_text') or '').strip()
                if summary:
                    parts.append(f"  ↳ {summary[:200]}")
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

    def _parse_structured_or_text(
        self,
        structured_summary: Optional[Dict[str, Any]],
        fallback_text: str,
    ) -> Dict[str, Any]:
        if structured_summary:
            return self._parse_structured_summary(structured_summary)
        return self._parse_summary_response(fallback_text)

    def _parse_structured_summary(self, structured_summary: Dict[str, Any]) -> Dict[str, Any]:
        summary_block = structured_summary.get("summary", structured_summary)
        insights = summary_block.get("insights") or []
        anomalies = summary_block.get("anomalies") or summary_block.get("risks") or []

        events: List[str] = []
        for key in ("events", "notable_events", "activities"):
            events.extend(self._normalize_entries(summary_block.get(key)))

        return {
            "insights": insights if isinstance(insights, list) else [str(insights)],
            "events": events,
            "anomalies": anomalies if isinstance(anomalies, list) else [str(anomalies)],
        }

    def generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for text using the embedding model."""
        self._ensure_client()
        try:
            self._log_llm_request(
                "embeddings.create",
                {"model": settings.embedding_model, "input": text},
            )
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
            "browser_activity": len(data.get('browser_activity', [])),
            "screen_captures": len(data.get('screen_captures', [])),
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

        messages = [
            {
                "role": "system",
                "content": """You are a personal intelligence analyst. Given browser history data, infer what the user is likely working on, learning, or planning. Highlight intents, research threads, and context in 2-3 sentences.""",
            },
            {
                "role": "user",
                "content": prompt,
            },
        ]

        chat_kwargs = {
            "model": settings.llm_model,
            "messages": messages,
            "temperature": settings.llm_temperature,
            "max_tokens": min(settings.llm_max_tokens, 400),
        }

        try:
            if settings.debug_prompts:
                self._log_prompt(f"browser-history-{level}", messages)
            self._log_llm_request("chat.completions.create", chat_kwargs)
            response = self.client.chat.completions.create(**chat_kwargs)
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

        messages = [
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
        ]

        chat_kwargs = {
            "model": settings.llm_model,
            "messages": messages,
            "temperature": settings.llm_temperature,
            "max_tokens": settings.llm_max_tokens,
        }

        try:
            if settings.debug_prompts:
                self._log_prompt("daily", messages)
            self._log_llm_request("chat.completions.create", chat_kwargs)
            response = self.client.chat.completions.create(**chat_kwargs)

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
                "browser_activity": sum(s['activity_counts'].get('browser_activity', 0) for s in hourly_summaries),
                "screen_captures": sum(s['activity_counts'].get('screen_captures', 0) for s in hourly_summaries),
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

        if settings.debug_prompts:
            self._log_prompt(
                f"{period_label}-from-{child_label}",
                [{"role": "user", "content": all_text}],
            )

        messages = [
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
        ]

        chat_kwargs = {
            "model": settings.llm_model,
            "messages": messages,
            "temperature": settings.llm_temperature,
            "max_tokens": settings.llm_max_tokens,
        }

        try:
            self._log_llm_request("chat.completions.create", chat_kwargs)
            response = self.client.chat.completions.create(**chat_kwargs)

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
            "browser_activity",
            "screen_captures",
        ]
        totals = {key: 0 for key in keys}
        for summary in summaries:
            counts = summary.get('activity_counts', {})
            for key in keys:
                totals[key] += counts.get(key, 0)
        totals['total'] = sum(totals.values())
        return totals

    def _coerce_json_summary(self, response_text: str) -> Tuple[str, Dict[str, Any]]:
        """Ensure the LLM response is valid JSON, stripping markdown fences."""
        cleaned = response_text.strip()
        cleaned = self._strip_code_fences(cleaned)

        parsed = self._try_parse_json(cleaned)
        if not parsed:
            blob = self._extract_json_blob(cleaned)
            parsed = self._try_parse_json(blob) if blob else None

        if not parsed:
            logger.warning("llm_response_not_json", preview=cleaned[:200])
            parsed = {
                "summary": {
                    "narrative": cleaned,
                    "insights": [],
                    "notable_events": [],
                    "anomalies": [],
                }
            }

        normalized = json.dumps(parsed, ensure_ascii=False, indent=2)
        return normalized, parsed

    def _strip_code_fences(self, text: str) -> str:
        fence = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
        if text.startswith("```"):
            text = fence.sub("", text)
        return text.strip()

    def _extract_json_blob(self, text: str) -> Optional[str]:
        start = text.find('{')
        end = text.rfind('}')
        if start != -1 and end != -1 and end > start:
            return text[start:end + 1]
        return None

    def _try_parse_json(self, text: Optional[str]) -> Optional[Dict[str, Any]]:
        if not text:
            return None
        try:
            value = json.loads(text)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            return None
        return None

    def _log_llm_request(self, operation: str, payload: Dict[str, Any]) -> None:
        """Emit the exact payload heading to the LLM for debugging."""
        try:
            logger.info(
                "llm_request",
                operation=operation,
                payload=self._serialize_payload(payload),
            )
        except Exception as exc:
            logger.warning("llm_request_logging_failed", error=str(exc), operation=operation)

    def _serialize_payload(self, value: Any):
        if isinstance(value, dict):
            return {k: self._serialize_payload(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._serialize_payload(v) for v in value]
        if isinstance(value, datetime):
            return value.isoformat()
        return value

    def _log_prompt(self, summary_type: str, messages: List[Dict[str, Any]]) -> None:
        try:
            formatted = json.dumps(messages, ensure_ascii=False, indent=2)
        except Exception:
            formatted = str(messages)
        print(f"[llm_prompt][{summary_type}]\n{formatted}\n", flush=True)

    def _normalize_entries(self, entries: Any) -> List[str]:
        normalized: List[str] = []
        if not isinstance(entries, list):
            return normalized
        for item in entries:
            if isinstance(item, str):
                text = item.strip()
                if text:
                    normalized.append(text)
            elif isinstance(item, dict):
                descriptor = item.get('event') or item.get('description') or item.get('title')
                if isinstance(descriptor, str) and descriptor.strip():
                    text = descriptor.strip()
                    timestamp = item.get('time')
                    if isinstance(timestamp, str) and timestamp.strip():
                        text = f"{text} ({timestamp.strip()})"
                    normalized.append(text)
        return normalized


# Global summarizer instance
summarizer = Summarizer()
