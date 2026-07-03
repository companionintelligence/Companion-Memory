"""
User-timezone helpers for the summary / insights service.

Daily/weekly/monthly summary windows are inherently local-time concepts:
"yesterday" and "this week" only mean something in the user's own calendar.
Computing them from UTC midnight groups a GMT-5 user's activity into the wrong
day (their evening leaks into the next UTC day), so summaries appear shifted by
the user's UTC offset.

Source of truth: ``ci.users.timezone`` (TEXT, default ``'UTC'``) — the same
column HBPE and the API's ForecastContextService read.  These helpers run inside
Temporal *activities* (never the workflow sandbox), so ``zoneinfo`` disk access
and DB reads are safe here.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .database import db

UTC = ZoneInfo("UTC")


def zone_of(name: str | None) -> ZoneInfo:
    """Return a ``ZoneInfo`` for an IANA name, falling back to UTC if invalid."""
    if not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def get_user_timezone(user_id: str) -> str:
    """
    Return the user's validated IANA timezone from ``ci.users.timezone``.

    Defaults to ``'UTC'`` for a missing user, NULL column, unknown zone, or any
    DB error — a summary must never fail because a timezone can't be resolved.
    """
    try:
        rows = db.execute_query(
            "SELECT timezone FROM ci.users WHERE id = :uid", {"uid": str(user_id)}
        )
    except Exception:
        return "UTC"
    name = rows[0].get("timezone") if rows else None
    if not name:
        return "UTC"
    # Degrade an unknown stored value to UTC rather than crash downstream.
    return name if (name == "UTC" or zone_of(name) is not UTC) else "UTC"


def local_period_window(reference: datetime, tz: str, period: str) -> tuple[datetime, datetime]:
    """
    Return ``(start, end)`` as UTC-aware instants bounding the last *complete*
    local period before ``reference``, computed in ``tz``.

    - ``daily``   → the previous local calendar day.
    - ``weekly``  → the previous local Mon–Sun week.
    - ``monthly`` → the previous local calendar month.

    ``reference`` should be an aware datetime (e.g. ``workflow.now()``).  The
    returned instants are what event queries (UTC ``timestamptz``) compare against.
    """
    zone = zone_of(tz)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=UTC)
    local = reference.astimezone(zone)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)

    if period == "daily":
        end_local = midnight
        start_local = end_local - timedelta(days=1)
    elif period == "weekly":
        end_local = midnight - timedelta(days=midnight.weekday())  # this local Monday
        start_local = end_local - timedelta(days=7)
    elif period == "monthly":
        end_local = midnight.replace(day=1)                        # 1st of this local month
        start_local = (end_local - timedelta(days=1)).replace(day=1)
    else:
        raise ValueError(f"unknown period '{period}'")

    return start_local.astimezone(UTC), end_local.astimezone(UTC)
