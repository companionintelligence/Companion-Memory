"""
The ci.tasks status vocabulary crosses a language boundary, so it needs a test
that crosses it too.

#2558 added the 'delegated' status in TypeScript — the const tuple, the entity,
the GraphQL enum, the web client — and in nothing that FILTERS on status. The
TypeScript half of that gap is now held shut by a partition test in
domains/planning/__tests__/taskStatus.test.ts, but no jest suite can see this
package: recurrence.py's upcoming-task reconciliation asked for
``('open', 'in_progress')`` and a delegated task, which keeps its due date and
is exactly the kind of upcoming commitment that query exists to reconcile
against, stopped pinning its cluster's occurrence with nothing failing.

So the Python copy is pinned against the TypeScript source of truth by parsing
it, in the same spirit as test_kind_l0_map_join.py parsing the shipped migration
SQL rather than restating its patterns.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe.pipeline.recurrence import (  # noqa: E402
    ACTIVE_TASK_STATUSES,
    _load_upcoming_tasks,
)

BACKEND = Path(__file__).resolve().parents[3]
TASK_STATUS_TS = BACKEND / "apps/api/src/domains/planning/taskStatus.ts"


def _ts_string_array(source: str, name: str) -> list[str]:
    """The quoted members of a `const NAME ... = [ 'a', 'b' ]` declaration."""
    match = re.search(
        rf"export const {re.escape(name)}\b[^=]*=\s*\[(.*?)\]", source, re.DOTALL
    )
    assert match, f"{name} not found in {TASK_STATUS_TS}"

    return re.findall(r"'([a-z_]+)'", match.group(1))


@pytest.mark.skipif(
    not TASK_STATUS_TS.exists(),
    reason=(
        "TypeScript source not in this tree (the hbpe container ships without "
        "apps/api). The parity this test exists to hold is a repo-level fact, "
        "and every checkout that can drift can also read the file."
    ),
)
def test_active_statuses_match_the_typescript_source_of_truth() -> None:
    source = TASK_STATUS_TS.read_text()

    assert list(ACTIVE_TASK_STATUSES) == _ts_string_array(
        source, "ACTIVE_TASK_STATUSES"
    )


@pytest.mark.skipif(
    not TASK_STATUS_TS.exists(), reason="TypeScript source not in this tree"
)
def test_every_status_is_classified_on_the_typescript_side() -> None:
    # Guards the guard: if the TS file were restructured so the regex above
    # matched nothing useful, the parity assertion could pass vacuously on two
    # empty lists. This pins that the vocabulary really is being read, and that
    # the subset really is a strict, non-empty part of it.
    source = TASK_STATUS_TS.read_text()
    vocabulary = _ts_string_array(source, "TASK_STATUSES")

    assert "delegated" in vocabulary
    assert 0 < len(ACTIVE_TASK_STATUSES) < len(vocabulary)
    assert set(ACTIVE_TASK_STATUSES) <= set(vocabulary)


def test_delegated_work_reaches_the_upcoming_reconciliation() -> None:
    # The literal that shipped, asserted by name at the one call site that used
    # it. Parity with TypeScript above says the tuple is right; this says the
    # query actually asks for the tuple.
    assert "delegated" in ACTIVE_TASK_STATUSES

    captured: dict[str, object] = {}

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def execute(self, sql, params):
            captured["sql"] = sql
            captured["params"] = params

        def fetchall(self):
            return []

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def cursor(self, **_kwargs):
            return _Cursor()

    import ci.hbpe.pipeline.recurrence as recurrence

    original = recurrence.get_conn
    recurrence.get_conn = lambda: _Conn()
    try:
        assert _load_upcoming_tasks("00000000-0000-0000-0000-000000000000", 45) == []
    finally:
        recurrence.get_conn = original

    assert "t.status IN %s" in captured["sql"]
    # psycopg2 forbids mixing positional and named placeholders, so the tuple
    # has to arrive in the right POSITION, not just be present somewhere.
    assert captured["params"][1] == ACTIVE_TASK_STATUSES
