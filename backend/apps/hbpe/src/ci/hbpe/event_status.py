"""
"This event did not happen", for HBPE's reads of ci.events.

The vocabulary of record is ``DEAD_EVENT_STATUSES`` in
backend/apps/api/src/domains/memory/services/CalendarEventService.ts, with
``LIVE_EVENT_SQL`` just below it. The calendar, the planner, Known places and
the location estimator all exclude these statuses through it. This package
cannot import TypeScript, so this is a copy, and
tests/test_event_status_parity.py parses the TypeScript and fails the day the
two differ.

Every HBPE read of ci.events that feeds training applies ``LIVE_EVENT_SQL``:
the serializer's token read, both labelers' unlabeled-event reads, and the two
day queries that predict what the serializer will publish. Before it, they
filtered ``is_deleted`` and nothing else. A meeting the source cancelled is
still a row (Google Calendar sync keeps it), so it was labeled, serialized into
hbpe.token_stream, trained on, and counted by recurrence as an occurrence.
"""

from __future__ import annotations

import re

DEAD_EVENT_STATUSES: tuple[str, ...] = ("cancelled", "no_show", "skipped")

# What a NULL status reads as, the same default the TypeScript COALESCEs to.
# ci.events.status is NOT NULL since 20260908000139, but its down migration
# drops that, and ``NULL NOT IN (...)`` is UNKNOWN rather than TRUE: a bare
# NOT IN would silently drop a null-status row.
NULL_EVENT_STATUS = "confirmed"


def _sql_literal(value: str) -> str:
    """
    ``value`` as a quoted SQL literal, refused unless it is a plain token.

    The statuses are interpolated into SQL that psycopg2 also scans for ``%s``
    placeholders. They are in-repo constants, so this is a tripwire: an edit
    that introduces a quote or a ``%`` fails at import instead of producing a
    query of a different shape.
    """
    if not re.fullmatch(r"[a-z_]+", value):
        raise ValueError(f"{value!r} is not a plain [a-z_] token")
    return f"'{value}'"


# SQL predicate: the ci.events row aliased ``e`` still counts. Every HBPE reader
# aliases the table ``e``, as static_labeler.KIND_EXPR already assumes.
LIVE_EVENT_SQL = (
    f"COALESCE(e.status, {_sql_literal(NULL_EVENT_STATUS)}) "
    f"NOT IN ({', '.join(_sql_literal(s) for s in DEAD_EVENT_STATUSES)})"
)
