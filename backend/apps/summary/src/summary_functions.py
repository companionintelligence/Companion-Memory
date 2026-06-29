"""
Pure functions for summary generation.

These are stateless functions that can be called from Temporal activities.
All dependencies are passed as parameters.
"""
from typing import Dict, List, Any, Optional
import httpx
import json

from .config import settings
from .llm_config import LLMConfig


def count_activities(aggregated_data: Dict[str, Any]) -> Dict[str, int]:
    """
    Count activities in aggregated data.

    Pure function - no side effects, deterministic output.
    """
    counts = {
        "measurements": len(aggregated_data.get("measurements", [])),
        "position": len(aggregated_data.get("position", [])),
        "communications": len(aggregated_data.get("communications", [])),
        "activities": len(aggregated_data.get("activities", [])),
        "events": len(aggregated_data.get("events", [])),
        "messages": len(aggregated_data.get("messages", [])),
        "files": len(aggregated_data.get("files", [])),
        "browser_activity": len(aggregated_data.get("browser_activity", [])),
        "screen_captures": len(aggregated_data.get("screen_captures", [])),
    }
    counts["total"] = sum(v for k, v in counts.items() if k != "total")
    return counts


def build_data_prompt(aggregated_data: Dict[str, Any], activity_counts: Dict[str, int]) -> str:
    """
    Build prompt from aggregated data.

    Pure function - creates the LLM prompt from data.
    """
    parts = [f"Activity Summary ({activity_counts['total']} total items):"]

    for key, count in activity_counts.items():
        if key != "total" and count > 0:
            parts.append(f"\n{key.replace('_', ' ').title()}: {count} items")
            items = aggregated_data.get(key, [])
            if items:
                sample_size = min(10, len(items))
                parts.append(f"  Sample (first {sample_size}):")
                for item in items[:sample_size]:
                    item_str = json.dumps(item, default=str)
                    if len(item_str) > 200:
                        item_str = item_str[:200] + "..."
                    parts.append(f"    - {item_str}")

    return "\n".join(parts)


def generate_hourly_summary(
    llm_config: LLMConfig,
    aggregated_data: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Generate hourly summary from aggregated data.

    Pure function that uses LLM config to generate summary.
    """
    activity_counts = count_activities(aggregated_data)

    if activity_counts.get("total", 0) == 0:
        return {
            "summary_text": "No activity recorded during this window.",
            "summary_type": "hourly",
            "key_insights": [],
            "events": [],
            "anomalies": [],
            "embedding": generate_embedding(llm_config, "No activity"),
            "activity_counts": activity_counts,
            "tokens_used": 0,
        }

    # Build prompt
    prompt = build_data_prompt(aggregated_data, activity_counts)

    # Call LLM
    result = llm_config.agents['hourly'].run_sync(
        prompt,
        model_settings={
            "temperature": settings.llm_temperature,
            "max_tokens": settings.llm_max_tokens,
        },
    )

    response = result.output
    embedding = generate_embedding(llm_config, response.summary_text)

    # Convert to dict with structured data
    response_dict = response.model_dump(exclude_none=True)

    return {
        "summary_text": response.summary_text,
        "summary_type": "hourly",
        "key_insights": response.key_insights,
        "events": response.notable_events,
        "anomalies": response.anomalies,
        "structured_data": response_dict,
        "embedding": embedding,
        "activity_counts": activity_counts,
        "tokens_used": result.usage.total_tokens if result.usage else 0,
    }


def generate_rollup_summary(
    llm_config: LLMConfig,
    period_type: str,
    child_summaries: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Generate rollup summary from child summaries.

    Pure function for daily/weekly/monthly/seasonal/yearly summaries.
    """
    # Get appropriate agent
    agent = llm_config.agents.get(period_type)
    if not agent:
        raise ValueError(f"No agent configured for period_type: {period_type}")

    # Build prompt from child summaries
    combined_text = "\n\n".join([
        f"Summary {i + 1}: {s.get('summary_text', '')}"
        for i, s in enumerate(child_summaries)
    ])

    prompt = f"Synthesize these summaries into a {period_type} overview:\n\n{combined_text}"

    # Call LLM
    result = agent.run_sync(
        prompt,
        model_settings={
            "temperature": settings.llm_temperature,
            "max_tokens": settings.llm_max_tokens,
        },
    )

    response = result.output
    embedding = generate_embedding(llm_config, response.summary_text)

    # Aggregate activity counts from children
    total_counts = {}
    for summary in child_summaries:
        counts = summary.get("activity_counts", {})
        for key, value in counts.items():
            total_counts[key] = total_counts.get(key, 0) + value

    # Convert response to dict
    response_dict = response.model_dump(exclude_none=True)

    return {
        "summary_text": response.summary_text,
        "summary_type": period_type,
        "structured_data": response_dict,
        "embedding": embedding,
        "activity_counts": total_counts,
        "num_child_summaries": len(child_summaries),
        "tokens_used": result.usage.total_tokens if result.usage else 0,
    }


def generate_user_dossier(
    llm_config: LLMConfig,
    user_id: str,
    daily_summaries: List[Dict[str, Any]],
    hourly_summaries: List[Dict[str, Any]],
    previous_dossier: Dict[str, Any] = None,
    lookback_start: Optional["datetime"] = None,
    lookback_end: Optional["datetime"] = None,
    timezone: str = "UTC",
    max_chars: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Generate user dossier from summaries.

    Pure function that creates a personality/preference dossier.
    """
    # Build context from summaries
    daily_text = "\n\n".join([
        f"Day {i + 1}: {s.get('summary_text', '')}"
        for i, s in enumerate(daily_summaries)
    ])

    hourly_text = "\n\n".join([
        f"Hour {i + 1}: {s.get('summary_text', '')}"
        for i, s in enumerate(hourly_summaries)
    ])

    prompt_parts = [
        "Based on the following activity summaries, create a concise user dossier:",
        "\n## Recent Daily Summaries:",
        daily_text,
        "\n## Recent Hourly Summaries:",
        hourly_text,
    ]

    if previous_dossier:
        prompt_parts.insert(1, f"\n## Previous Dossier:\n{previous_dossier.get('summary', '')}")

    prompt = "\n".join(prompt_parts)

    # Call LLM
    result = llm_config.agents['dossier'].run_sync(
        prompt,
        model_settings={
            "temperature": settings.llm_temperature,
            "max_tokens": settings.llm_max_tokens,
        },
    )

    response = result.output

    # Build dossier payload
    from datetime import datetime
    max_length = max_chars or settings.dossier_max_chars
    summary = response.summary
    if max_length and len(summary) > max_length:
        summary = summary[: max_length - 3] + "..."

    payload: Dict[str, Any] = {
        "summary": summary,
        "tone": response.tone,
        "personalityTraits": response.personalityTraits,
        "interactionGuidelines": response.interactionGuidelines,
        "preferences": response.preferences,
        "challenges": response.challenges,
        "interests": response.interests,
        "lastUpdatedAt": datetime.utcnow().isoformat(),
        "version": 1,
    }

    if lookback_start and lookback_end:
        payload["sourceWindow"] = {
            "start": lookback_start.isoformat(),
            "end": lookback_end.isoformat(),
            "timezone": timezone,
        }

    return payload


def generate_insights(
    llm_config: LLMConfig,
    insights_context: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Generate proactive insights from aggregated context.

    Pure function that uses LLM to generate actionable insights
    based on graph deltas, events, relationships, and summaries.
    """
    # Get insights agent
    agent = llm_config.agents.get('insights')
    if not agent:
        raise ValueError("No agent configured for insights generation")

    # Build prompt from context
    prompt = _build_insights_prompt(insights_context)

    # Call LLM with slightly higher temperature for creativity
    result = agent.run_sync(
        prompt,
        model_settings={
            "temperature": 0.7,
            "max_tokens": settings.llm_max_tokens,
        },
    )

    response = result.output

    # Generate embedding from combined insight text
    combined_text = " ".join([
        f"{i.title}: {i.summary_text}"
        for i in response.insights
    ])
    embedding = generate_embedding(llm_config, combined_text)

    # Convert insights to dicts
    insights_list = [item.model_dump() for item in response.insights]

    return {
        "insights": insights_list,
        "data_sources_used": response.data_sources_used,
        "embedding": embedding,
        "tokens_used": result.usage.total_tokens if result.usage else 0,
        "num_insights": len(response.insights),
    }


def generate_actions(
    llm_config: LLMConfig,
    context: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Generate action cards from aggregated context.

    Pure function that uses LLM to generate conversation starters
    and time management suggestions.
    """
    # Get action agent
    agent = llm_config.agents.get('actions')
    if not agent:
        raise ValueError("No agent configured for actions generation")

    # Build action-specific prompt
    prompt = _build_actions_prompt(context)

    # Call LLM with moderate temperature - not too creative to avoid mixing unrelated topics
    result = agent.run_sync(
        prompt,
        model_settings={
            "temperature": 0.6,
            "max_tokens": settings.llm_max_tokens,
        },
    )

    response = result.output

    # Convert actions to dicts
    actions_list = [item.model_dump() for item in response.actions]

    return {
        "actions": actions_list,
        "tokens_used": result.usage.total_tokens if result.usage else 0,
    }


def _build_actions_prompt(context: Dict[str, Any]) -> str:
    """Build prompt for action card generation from aggregated context."""
    parts = ["Based on the following context about the user, generate helpful action cards:\n"]

    # User dossier (personality/preferences)
    dossier = context.get("user_dossier")
    if dossier:
        parts.append("## USER PROFILE")
        parts.append(f"Summary: {dossier.get('summary', 'N/A')}")
        if dossier.get("interests"):
            interests = dossier["interests"]
            if isinstance(interests, list):
                parts.append(f"Interests: {', '.join(interests[:5])}")
        if dossier.get("communication_style"):
            parts.append(f"Communication style: {dossier['communication_style']}")
        parts.append("")

    # Recent summaries - what's been happening in their life
    summaries = context.get("recent_summaries", [])
    if summaries:
        parts.append("## RECENT ACTIVITY SUMMARIES")
        for s in summaries[:5]:  # Limit to most recent
            period = s.get("period_type", "unknown")
            text = s.get("summary_text", "")
            if text:
                parts.append(f"[{period.upper()}] {text[:300]}...")
        parts.append("")

    # Recent insights - already identified interesting observations
    insights = context.get("recent_insights", [])
    if insights:
        parts.append("## RECENT INSIGHTS (already surfaced to user)")
        for i in insights[:5]:
            title = i.get("title", "")
            text = i.get("insight_text", "")
            if title or text:
                parts.append(f"- {title}: {text[:150]}...")
        parts.append("")

    # Upcoming events - time-sensitive context
    events = context.get("upcoming_events", [])
    if events:
        parts.append("## UPCOMING EVENTS (next 7 days)")
        for e in events[:5]:
            title = e.get("title", "Untitled")
            start = e.get("start_time", "")
            location = e.get("location", "")
            event_info = f"- {title}"
            if start:
                event_info += f" ({start})"
            if location:
                event_info += f" at {location}"
            parts.append(event_info)
        parts.append("")

    # Key people - for conversation suggestions
    people = context.get("key_people", [])
    if people:
        parts.append("## KEY PEOPLE IN USER'S LIFE")
        for p in people[:5]:
            name = p.get("name", "Unknown")
            rel_type = p.get("relationship_type", "")
            desc = p.get("description", "")
            person_info = f"- {name}"
            if rel_type:
                person_info += f" ({rel_type})"
            if desc:
                person_info += f": {desc[:100]}"
            parts.append(person_info)
        parts.append("")

    # Instructions
    parts.append("## INSTRUCTIONS")
    parts.append("Generate 3-5 action cards that are:")
    parts.append("1. Specific to THIS user's context (not generic)")
    parts.append("2. Actionable RIGHT NOW")
    parts.append("3. A mix of conversation starters and time suggestions")
    parts.append("4. Reference specific people, events, or topics from above")
    parts.append("")
    parts.append("IMPORTANT: Each card must focus on ONE topic. Do NOT combine unrelated activities.")
    parts.append("BAD example: 'Warm up for your workout by reviewing GraphQL notes' - these are unrelated!")
    parts.append("GOOD example: 'Prepare for your workout' OR separately 'Review GraphQL documentation'")
    parts.append("")
    parts.append("For conversation starters: suggest specific topics or questions to discuss with specific people.")
    parts.append("For time suggestions: suggest what the user should do next based on their schedule and recent activity.")

    return "\n".join(parts)


def _build_insights_prompt(context: Dict[str, Any]) -> str:
    """Build prompt for insights generation from aggregated context."""
    parts = ["Generate proactive insights based on the following user context:\n"]

    # User dossier (personality/preferences)
    dossier = context.get("user_dossier")
    if dossier:
        parts.append("## USER PROFILE")
        parts.append(f"Summary: {dossier.get('summary', 'N/A')}")
        if dossier.get("interests"):
            interests = dossier["interests"]
            if isinstance(interests, list):
                parts.append(f"Interests: {', '.join(interests[:5])}")
        if dossier.get("preferences"):
            preferences = dossier["preferences"]
            if isinstance(preferences, list):
                parts.append(f"Preferences: {', '.join(preferences[:5])}")
        parts.append("")

    # Upcoming events
    events = context.get("upcoming_events", [])
    if events:
        parts.append("## UPCOMING EVENTS (next 14 days)")
        for event in events[:10]:
            start = event.get("start_time") or event.get("start_date", "")
            title = event.get("title") or event.get("name", "Untitled")
            parts.append(f"- {start}: {title}")
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

            if node_type == "entity":
                name_field = changed_fields.get("name", {})
                if isinstance(name_field, dict):
                    name = name_field.get("new") or name_field.get("old", "Unknown")
                else:
                    name = str(name_field) if name_field else "Unknown"
                parts.append(f"- {change_type.upper()} {entity_type}: {name}")
            else:
                parts.append(f"- {change_type.upper()} relationship: {entity_type}")
        parts.append("")

    # Strongest relationships
    strongest = context.get("strongest_relationships", [])
    if strongest:
        parts.append("## CLOSEST RELATIONSHIPS (by strength)")
        for rel in strongest[:3]:
            parts.append(f"- {rel.get('name', 'Unknown')} ({rel.get('relationship_type', 'related')})")
        parts.append("")

    # Recently changed relationships
    recent_rels = context.get("recently_changed_relationships", [])
    if recent_rels:
        parts.append("## RECENTLY CHANGED RELATIONSHIPS")
        for rel in recent_rels[:5]:
            change = rel.get("change_type", "updated")
            name = rel.get("name", "Unknown")
            parts.append(f"- {change}: {name}")
        parts.append("")

    # Event-relevant relationships
    event_rels = context.get("event_relevant_relationships", [])
    if event_rels:
        parts.append("## PEOPLE CONNECTED TO UPCOMING EVENTS")
        for rel in event_rels[:5]:
            name = rel.get("name", "Unknown")
            event = rel.get("event_title", "")
            parts.append(f"- {name}: {event}")
        parts.append("")

    # Recent summaries (patterns)
    summaries = context.get("recent_summaries", [])
    if summaries:
        parts.append("## RECENT ACTIVITY PATTERNS")
        for summary in summaries[:5]:
            text = summary.get("summary_text", "")
            if text:
                parts.append(f"- {text[:200]}")
        parts.append("")

    # Recent communications
    comms = context.get("recent_communications", [])
    if comms:
        parts.append("## RECENT COMMUNICATIONS")
        for comm in comms[:5]:
            subject = comm.get("subject") or comm.get("title", "")
            if subject:
                parts.append(f"- {subject[:50]}")
        parts.append("")

    parts.append("\nBased on this context, generate 3-5 actionable insights that would be helpful to the user.")
    parts.append("Focus on upcoming opportunities, relationship maintenance, and timely suggestions.")

    return "\n".join(parts)


def generate_embedding(llm_config: LLMConfig, text: str) -> List[float]:
    """
    Generate embedding for text.

    Pure function that calls embedding endpoint.
    """
    if not text:
        return []

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f"{settings.llm_api_base}/embeddings",
                json={
                    "model": settings.embedding_model,
                    "input": text[:8000],  # Limit input size
                },
                headers={"Authorization": f"Bearer {settings.llm_api_key}"}
            )
            response.raise_for_status()
            data = response.json()
            return data.get("data", [{}])[0].get("embedding", [])
    except Exception:
        # Return empty on error
        return []


__all__ = [
    "count_activities",
    "build_data_prompt",
    "generate_hourly_summary",
    "generate_rollup_summary",
    "generate_user_dossier",
    "generate_insights",
    "generate_actions",
    "generate_embedding",
]
