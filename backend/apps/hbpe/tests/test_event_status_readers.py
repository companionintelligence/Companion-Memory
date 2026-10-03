"""
Every HBPE read of ci.events that feeds training leaves out events that did not
happen, and a new reader has to say whether it does.

get_token_events_for_day is the serializer's read. Through hbpe.token_stream it
is the input to HMT training, recurrence and seasonal, and it filtered
``is_deleted`` and nothing else, so a meeting the source cancelled was published
like any other. Both labelers and the two day queries had the same gap. Each
site is asserted on the SQL it actually emits, captured from a recording
connection, in the WHERE that reads ci.events:

  * get_token_events_for_day, label_mapped_events: here
  * get_unlabeled_events (the Qwen drain): test_label_drain.py
  * _TOKEN_SOURCE_DAYS_SQL, _TOKEN_DATE_BOUNDS_SQL: test_summary_label_range.py
    for the SQL, test_label_drain.py for what the tiers do with it
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import data_client as dc  # noqa: E402
from ci.hbpe.event_status import DEAD_EVENT_STATUSES, LIVE_EVENT_SQL  # noqa: E402
from ci.hbpe.pipeline import recurrence  # noqa: E402
from ci.hbpe.tokenizer import static_labeler as sl  # noqa: E402

USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"
CLUSTER = "00000000-0000-0000-0000-000000000001"
PACKAGE = SRC / "ci" / "hbpe"


class _Cursor:
    def __init__(self, calls: list) -> None:
        self._calls = calls

    def execute(self, sql, params=None):
        self._calls.append((" ".join(str(sql).split()), tuple(params or ())))

    def fetchall(self):
        return []

    @property
    def rowcount(self):
        return 0

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, calls: list) -> None:
        self._calls = calls

    def cursor(self, **_kwargs):
        return _Cursor(self._calls)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def test_the_serializer_read_leaves_out_events_that_did_not_happen(monkeypatch):
    """
    A label survives a cancellation: hbpe.l1_event_cluster keeps the row it was
    given while the meeting was live. So this WHERE is the only thing between a
    cancelled meeting and the token stream. The predicate must sit in
    ``day_events``, beside ``is_deleted``, where ci.events is read. It binds no
    parameters, so the positional ones keep their places.
    """
    calls: list = []
    monkeypatch.setattr(dc, "get_conn", lambda: _Conn(calls))

    dc.get_token_events_for_day(USER, "2026-08-30")

    (sql, params) = calls[0]
    assert (
        "WHERE e.user_id = %s AND e.is_deleted = FALSE "
        "AND e.event_type IS DISTINCT FROM 'planned_block' "
        f"AND {LIVE_EVENT_SQL} AND e.start_time >= %s::date" in sql
    )
    assert sql.count(LIVE_EVENT_SQL) == 1
    assert params == (USER, "2026-08-30", "2026-08-30", USER)


def test_the_static_labeler_does_not_claim_events_that_did_not_happen(monkeypatch):
    """
    The static labeler and the Qwen drain split one corpus on
    ``mapped_kind_sql()``. The drain skips events that did not happen, so the
    static labeler has to skip them as well, or the two disagree on which
    events are in the corpus at all.
    """
    calls: list = []
    monkeypatch.setattr(sl, "get_conn", lambda: _Conn(calls))
    monkeypatch.setattr(
        sl,
        "load_kind_map",
        lambda: [
            {
                "kind_pattern": "media.listen",
                "l0_class": "LEISURE",
                "l1_label": "Listening",
                "tier": "ambient",
                "default_duration_min": 3,
            }
        ],
    )
    monkeypatch.setattr(sl, "get_or_create_l1", lambda *_a, **_k: (CLUSTER, False))

    sl.label_mapped_events(USER)

    (sql, params) = next(call for call in calls if "WITH claimed AS" in call[0])
    assert (
        f"AND e.is_deleted = FALSE AND {LIVE_EVENT_SQL} "
        "AND (e.metadata->>'kind') LIKE %s" in sql
    )
    assert params == (USER, "media.listen", CLUSTER)


def test_schedule_reconciliation_keeps_its_own_narrower_allowlist():
    """
    ``_UPCOMING_EVENTS_SQL`` is the one ci.events read here that does not take
    LIVE_EVENT_SQL, because it already admits less: an upcoming booking pins a
    recurrence only while it is confirmed or tentative. That rules out every
    dead status, and also 'planned' (planning's own blocks) and 'completed'.
    It is reconciliation, read at forecast time, not training input. This pins
    that the allowlist still excludes everything that did not happen.
    """
    flat = " ".join(recurrence._UPCOMING_EVENTS_SQL.split())
    match = re.search(r"AND e\.status IN \(([^)]*)\)", flat)
    assert match, "_UPCOMING_EVENTS_SQL no longer filters on an explicit status list"

    allowed = re.findall(r"'([a-z_]+)'", match.group(1))
    assert allowed == ["confirmed", "tentative"]
    assert not set(allowed) & set(DEAD_EVENT_STATUSES)


# Every SQL site in ci.hbpe that reads ci.events, per file. The filtered ones are
# asserted on their emitted SQL (see the module docstring). Two are left alone on
# purpose:
#
#   * pipeline/recurrence.py, _UPCOMING_EVENTS_SQL: its own allowlist, pinned
#     above.
#   * tokenizer/vocab_cleanup.py, _relabel_mapped_off_junk: moves labels that
#     events already have onto the static clusters. It writes no token and
#     labels no new event, and the serializer's own predicate decides whether
#     a moved label is ever published.
_EVENT_READERS = {
    "data_client.py": 2,
    "pipeline/bootstrap.py": 2,
    "pipeline/recurrence.py": 1,
    "tokenizer/static_labeler.py": 1,
    "tokenizer/vocab_cleanup.py": 1,
}


def test_every_reader_of_ci_events_is_accounted_for():
    """
    The gap this file closes was a reader that never heard about status. A
    reader added later starts out the same way, so the census fails until
    someone decides: if it feeds training (labels, tokens, the day lists),
    apply event_status.LIVE_EVENT_SQL and assert it on the SQL it emits;
    either way, record it above.
    """
    found = Counter(
        path.relative_to(PACKAGE).as_posix()
        for path in sorted(PACKAGE.rglob("*.py"))
        for _ in re.finditer(r"\b(?:FROM|JOIN)\s+ci\.events\b", path.read_text())
    )

    assert dict(found) == _EVENT_READERS
