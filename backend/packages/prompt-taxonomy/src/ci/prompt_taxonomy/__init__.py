"""
Life-domain taxonomy used as directional guidance in HBPE and summary prompts.

These categories and keywords steer classification and summarization toward
domains users care about. They are not output labels — HBPE still emits its
fixed L0/L1 vocabulary; summary agents still use their structured schemas.
"""

from __future__ import annotations

# domain name → directional keywords (exact phrasing from product taxonomy)
LIFE_DOMAIN_TAXONOMY: dict[str, tuple[str, ...]] = {
    "Health & Wellness": (
        "exercise",
        "sleep",
        "medical appointments",
        "mental health",
        "symptoms",
    ),
    "Relationships & Family": (
        "friendships",
        "dating",
        "family milestones",
        "social events",
        "important conversations",
    ),
    "Career & Education": (
        "jobs",
        "projects",
        "promotions",
        "skills",
        "courses",
        "certifications",
        "academic milestones",
    ),
    "Home & Daily Life": (
        "moves",
        "household tasks",
        "repairs",
        "routines",
        "pets",
        "possessions",
    ),
    "Personal Finances": (
        "income",
        "spending",
        "savings",
        "investments",
        "debt",
        "major purchases",
    ),
    "Personal Growth": (
        "goals",
        "habits",
        "journaling",
        "reading",
        "values",
        "achievements",
        "setbacks",
    ),
    "Travel & Experiences": (
        "trips",
        "events",
        "hobbies",
        "restaurants",
        "concerts",
        "adventures",
        "memorable moments",
    ),
    "Life Administration": (
        "legal documents",
        "insurance",
        "taxes",
        "subscriptions",
        "appointments",
        "renewals",
        "emergencies",
    ),
    "Eating": (
        "Meals",
        "Restaurants",
    ),
    "Sleep": (
        "major night sleep",
        "naps",
    ),
}

DIRECTIONAL_CONSIDERATIONS_HEADER = (
    "Directional considerations — use these life domains and keywords when "
    "interpreting activity (guidance only, not required output labels):"
)


def format_directional_considerations() -> str:
    """Format the taxonomy as a prompt block for LLM guidance."""
    lines = [DIRECTIONAL_CONSIDERATIONS_HEADER, ""]
    for domain, keywords in LIFE_DOMAIN_TAXONOMY.items():
        lines.append(f"- {domain}: {', '.join(keywords)}")
    return "\n".join(lines)


__all__ = [
    "DIRECTIONAL_CONSIDERATIONS_HEADER",
    "LIFE_DOMAIN_TAXONOMY",
    "format_directional_considerations",
]
