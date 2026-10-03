"""
The ci.events "did not happen" vocabulary crosses a language boundary, so it
needs a test that crosses it too.

``DEAD_EVENT_STATUSES`` lives in CalendarEventService.ts, and the calendar, the
planner, Known places and the location estimator all read it from there. HBPE
filters on it in SQL that cannot import TypeScript, through the copy in
ci.hbpe.event_status. Copies of this list have drifted before: findInRange
excluded ('cancelled', 'no_show') while the planner excluded ('cancelled',
'no_show', 'skipped'), so a skipped block held a slot that nothing drew. No
jest suite can see this package, so the Python copy is pinned to the TypeScript
by parsing it, the way test_task_status_parity.py pins the task statuses.
"""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import event_status  # noqa: E402
from ci.hbpe.event_status import (  # noqa: E402
    DEAD_EVENT_STATUSES,
    LIVE_EVENT_SQL,
    NULL_EVENT_STATUS,
)

BACKEND = Path(__file__).resolve().parents[3]
CALENDAR_TS = BACKEND / "apps/api/src/domains/memory/services/CalendarEventService.ts"
MIGRATIONS = BACKEND / "apps/api/db/postgres/migrations"

_needs_ts = pytest.mark.skipif(
    not CALENDAR_TS.exists(),
    reason=(
        "TypeScript source not in this tree (the hbpe container ships without "
        "apps/api). The parity this test exists to hold is a repo-level fact, "
        "and every checkout that can drift can also read the file."
    ),
)


def _ts_string_array(source: str, name: str) -> list[str]:
    """The quoted members of a `const NAME ... = [ 'a', 'b' ]` declaration."""
    match = re.search(
        rf"export const {re.escape(name)}\b[^=]*=\s*\[(.*?)\]", source, re.DOTALL
    )
    assert match, f"{name} not found in {CALENDAR_TS}"

    return re.findall(r"'([a-z_]+)'", match.group(1))


def _ts_null_status(source: str) -> str:
    """
    The value TypeScript's LIVE_EVENT_SQL COALESCEs a NULL status to.

    The pattern also requires the NOT IN list to be interpolated from
    DEAD_EVENT_STATUSES, so the TypeScript SQL is the array this file pins, not
    a second hand-written list beside it.
    """
    match = re.search(
        r"export const LIVE_EVENT_SQL = `COALESCE\(event\.status, '([a-z_]+)'\) "
        r"NOT IN \(\$\{DEAD_EVENT_STATUSES\.",
        source,
    )
    assert match, f"LIVE_EVENT_SQL not in its expected shape in {CALENDAR_TS}"

    return match.group(1)


def _db_status_vocabulary() -> list[str]:
    """
    Every value ci.events.status may hold: the newest ``events_status_check``
    a migration adds. Up sections only, because a down section re-adds the
    narrower constraint it replaced.
    """
    vocabulary: list[str] = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        up = re.split(r"^-- migrate:down", path.read_text(), flags=re.MULTILINE)[0]
        for match in re.finditer(
            r"ADD CONSTRAINT events_status_check\s+CHECK\s*\(\s*status\s+IN\s*\((.*?)\)\s*\)",
            up,
            re.DOTALL,
        ):
            vocabulary = re.findall(r"'([a-z_]+)'", match.group(1))
    assert vocabulary, f"no events_status_check found under {MIGRATIONS}"

    return vocabulary


@_needs_ts
def test_dead_statuses_match_the_typescript_source_of_truth() -> None:
    source = CALENDAR_TS.read_text()

    assert list(DEAD_EVENT_STATUSES) == _ts_string_array(source, "DEAD_EVENT_STATUSES")


@_needs_ts
def test_a_null_status_reads_as_the_same_status_on_both_sides() -> None:
    # The second half of LIVE_EVENT_SQL. If the two sides COALESCEd NULL to
    # different statuses, a null-status row could count on the calendar and not
    # here, or the other way round.
    assert NULL_EVENT_STATUS == _ts_null_status(CALENDAR_TS.read_text())


@_needs_ts
def test_every_dead_status_is_a_status_the_column_can_hold() -> None:
    # Guards the guard. If CalendarEventService.ts were restructured so the
    # parse above matched nothing useful, parity could pass on two empty lists.
    # This pins that the list really is being read, that each member is a value
    # ci.events.status accepts, and that the NULL default is a status that still
    # counts. A dead default would drop every null-status row.
    vocabulary = _db_status_vocabulary()
    dead = _ts_string_array(CALENDAR_TS.read_text(), "DEAD_EVENT_STATUSES")

    assert "cancelled" in dead
    assert set(dead) < set(vocabulary)
    assert NULL_EVENT_STATUS in vocabulary
    assert NULL_EVENT_STATUS not in dead


def test_live_event_sql_keeps_live_and_null_statuses_and_drops_the_dead_ones() -> None:
    # The predicate run, not just read. The two clauses it uses, COALESCE and
    # NOT IN over string literals, behave the same in SQLite as in Postgres,
    # NULL handling included. That is enough to show the COALESCE is what keeps
    # a NULL status: drop it and that row goes, because ``NULL NOT IN (...)``
    # is UNKNOWN.
    statuses = [*_db_status_vocabulary(), None]
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE events (status TEXT)")
    db.executemany("INSERT INTO events VALUES (?)", [(s,) for s in statuses])

    kept = {
        row[0]
        for row in db.execute(f"SELECT status FROM events e WHERE {LIVE_EVENT_SQL}")
    }

    assert kept == {s for s in statuses if s not in DEAD_EVENT_STATUSES}
    assert None in kept


def test_only_plain_tokens_are_inlined_into_sql() -> None:
    # The statuses are interpolated into SQL that psycopg2 also scans for %s.
    # A quote would change the query's shape and a % would be read as a
    # placeholder, so the module refuses either at import.
    assert event_status._sql_literal("no_show") == "'no_show'"
    for bad in ("x'); DROP TABLE ci.events; --", "50%", "Cancelled", ""):
        with pytest.raises(ValueError):
            event_status._sql_literal(bad)
