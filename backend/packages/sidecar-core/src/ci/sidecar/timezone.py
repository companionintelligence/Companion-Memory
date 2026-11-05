"""
The user's timezone, as every sidecar reads it.

Source of truth: ``ci.users.timezone`` (TEXT, default ``'UTC'``), the column
HBPE's rhythm model, the Summary windows and the API's forecast context all
read. Each service reads it through its own driver (psycopg2 placeholders in
HBPE, SQLAlchemy's in Summary); what they share is what to make of the value.
"""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = ZoneInfo("UTC")


def zone_of(name: str | None) -> ZoneInfo:
    """A ``ZoneInfo`` for an IANA name, or UTC when the name is empty or unknown."""
    if not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def zone_name_or_utc(name: str | None) -> str:
    """``name`` when it is a zone ``zoneinfo`` knows, else ``'UTC'``.

    A stored value that no longer resolves (a renamed zone, a typo that got
    past the API) degrades to UTC rather than failing whatever reads it.
    """
    if not name:
        return "UTC"
    return name if (name == "UTC" or zone_of(name) is not UTC) else "UTC"
