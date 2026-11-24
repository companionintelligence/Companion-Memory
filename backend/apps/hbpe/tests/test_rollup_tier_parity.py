"""
The hbpe.token_stream_rollup tier vocabulary crosses a language boundary, so it
needs a test that crosses it too.

``token_rollup.py`` decides what goes in the ``tier`` column and a CHECK in a SQL
migration decides what the column accepts. They drifted: #2553 changed the code
to write ``weekly_weekday`` and ``weekly_weekend`` and left the constraint at
('weekly', 'prior_year'), so the rollup INSERT raised CheckViolation as soon as
hbpe.token_stream held a day older than RAW_DAYS. That failed the whole
serialize step and, in a cold start, aborted the bootstrap. No test saw it: the
unit tests fake the database, no HBPE test has one, and a constraint that lives
only in a migration is invisible to them. So, as test_event_status_parity.py
does for the event statuses, the vocabulary is read out of the migrations here
and compared with what the code writes.

What the code writes is measured, not copied: the tiers are the ones in the rows
rebuild_token_rollups would insert. A second hand-kept list of tier names in
this file would be the same kind of copy that drifted.
"""

from __future__ import annotations

import datetime
import re
import sys
from collections.abc import Iterable
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe.pipeline import token_rollup as tr  # noqa: E402

BACKEND = Path(__file__).resolve().parents[3]
MIGRATIONS = BACKEND / "apps/api/db/postgres/migrations"
ORIGINAL_MIGRATION = MIGRATIONS / "20260828120000_hbpe_life_forecast.sql"

# Tiers the constraint accepts although nothing writes them now. 'weekly' is
# what token_rollup wrote before #2553 split it by weekday and weekend. It stays
# allowed so that widening the CHECK cannot fail on a row an earlier release left
# behind. Dropping it from the constraint later is a cleanup this set does not
# stand in the way of.
LEGACY_TIERS = {"weekly"}

_needs_migrations = pytest.mark.skipif(
    not MIGRATIONS.is_dir(),
    reason=(
        "the API's migrations are not in this tree (the hbpe container ships "
        "without apps/api). The parity this test exists to hold is a repo-level "
        "fact, and every checkout that can drift can also read the files."
    ),
)

# ``CHECK (tier IN ('a', 'b'))`` and the column's own CHECK, which Postgres
# names token_stream_rollup_tier_check, are the same constraint.
_TIER_CHECK = r"CHECK\s*\(\s*tier\s+IN\s*\((.*?)\)\s*\)"
# The column's inline CHECK in the CREATE TABLE that made the table. [^;] keeps
# the match inside that one statement, so another table's tier column, such as
# hbpe.kind_l0_map's, is never read.
_INLINE_CHECK = re.compile(
    r"CREATE TABLE\s+(?:IF NOT EXISTS\s+)?hbpe\.token_stream_rollup\s*\("
    r"[^;]*?\btier\s+TEXT\b[^,;]*?" + _TIER_CHECK,
    re.DOTALL,
)
# The named constraint a later migration puts in its place.
_ADDED_CHECK = re.compile(
    r"ADD CONSTRAINT\s+token_stream_rollup_tier_check\s+" + _TIER_CHECK,
    re.DOTALL,
)


def _tier_vocabulary(migrations: Iterable[str]) -> list[str]:
    """
    Every value the tier column may hold: the newest tier CHECK among the given
    migrations, which are read in the order given. Up sections only, because a
    down section re-adds the narrower constraint it replaced.
    """
    vocabulary: list[str] = []
    for sql in migrations:
        up = re.split(r"^-- migrate:down", sql, flags=re.MULTILINE)[0]
        # Both spellings, in the order they appear: one file may hold both.
        found = sorted(
            (match.start(), match.group(1))
            for pattern in (_INLINE_CHECK, _ADDED_CHECK)
            for match in pattern.finditer(up)
        )
        for _, values in found:
            vocabulary = re.findall(r"'([a-z_]+)'", values)

    return vocabulary


def _db_tier_vocabulary() -> list[str]:
    paths = sorted(MIGRATIONS.glob("*.sql"))
    vocabulary = _tier_vocabulary(path.read_text() for path in paths)
    assert vocabulary, f"no tier CHECK for hbpe.token_stream_rollup under {MIGRATIONS}"

    return vocabulary


def _a_token_on_every_day(
    user_id: str, start: datetime.date, end: datetime.date
) -> list[dict]:
    """
    What _load_tokens returns for a user with a token on every day.

    Whatever window a builder asks for, it gets a token for each day in it. That
    reaches every branch of rebuild_token_rollups without this file repeating
    their window arithmetic, and without a clock: the weekly window holds both
    weekdays and weekend days, so both weekly tiers are written, and the
    prior-year window gets its anchor.
    """
    return [
        {
            "date": start + datetime.timedelta(days=n),
            "bucket_idx": 32,
            "level": "L0",
            "token_id": "WORK",
        }
        for n in range((end - start).days)
    ]


def _tiers_written_by_rebuild(monkeypatch: pytest.MonkeyPatch) -> set[str]:
    """The tier of every row rebuild_token_rollups would insert."""
    rows: list[tuple] = []
    monkeypatch.setattr(tr, "_load_tokens", _a_token_on_every_day)
    monkeypatch.setattr(
        tr, "_replace_rows", lambda user_id, new_rows: rows.extend(new_rows)
    )

    tr.rebuild_token_rollups("u1")

    # Rows are (user_id, period_start, tier, seq_order, ...).
    tiers = {row[2] for row in rows}
    # Guards the guard. If the corpus stopped reaching a branch, the checks below
    # would pass over a shorter list. The three are the weekday and weekend
    # groups of the weekly archetypes and the prior-year anchor; a new group
    # means this corpus and the migration's CHECK both need to learn it.
    assert len(tiers) == 3, f"expected three tiers from the corpus, got {sorted(tiers)}"

    return tiers


@_needs_migrations
def test_every_tier_the_rollup_writes_is_one_the_column_accepts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    written = _tiers_written_by_rebuild(monkeypatch)
    vocabulary = set(_db_tier_vocabulary())

    assert written <= vocabulary, (
        f"token_rollup writes {sorted(written - vocabulary)}, which "
        "token_stream_rollup_tier_check rejects: widen the constraint in a "
        "migration, or the rollup INSERT raises CheckViolation"
    )


@_needs_migrations
def test_the_constraint_allows_no_tier_the_rollup_cannot_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The other direction. A tier the code stopped writing, left in the
    # constraint, is the same drift read backwards, and the next person to
    # trust the constraint as documentation is misled by it.
    written = _tiers_written_by_rebuild(monkeypatch)
    vocabulary = set(_db_tier_vocabulary())

    assert vocabulary - written <= LEGACY_TIERS, (
        f"token_stream_rollup_tier_check allows {sorted(vocabulary - written - LEGACY_TIERS)}, "
        "which token_rollup never writes: drop it from the constraint, or add it to "
        "LEGACY_TIERS if rows may still hold it"
    )


@_needs_migrations
def test_the_original_migrations_inline_check_is_readable() -> None:
    # Guards the guard for the other spelling. The newest CHECK is an ADD
    # CONSTRAINT, so the inline one in the CREATE TABLE is only ever read here.
    # If its pattern stopped matching the real file the checks above would still
    # pass, and a later change that dropped the ADD would find an empty list.
    assert _tier_vocabulary([ORIGINAL_MIGRATION.read_text()]) == [
        "weekly",
        "prior_year",
    ]


def test_the_vocabulary_is_the_newest_up_section_check() -> None:
    created = """
-- migrate:up
CREATE TABLE IF NOT EXISTS hbpe.kind_l0_map (
    tier TEXT NOT NULL CHECK (tier IN ('anchor', 'ambient'))
);
CREATE TABLE IF NOT EXISTS hbpe.token_stream_rollup (
    user_id UUID NOT NULL,
    tier    TEXT NOT NULL CHECK (tier IN ('weekly', 'prior_year')),
    PRIMARY KEY (user_id, tier)
);
-- migrate:down
DROP TABLE IF EXISTS hbpe.token_stream_rollup;
"""
    widened = """
-- migrate:up
ALTER TABLE hbpe.token_stream_rollup
    DROP CONSTRAINT IF EXISTS token_stream_rollup_tier_check;
ALTER TABLE hbpe.token_stream_rollup
    ADD CONSTRAINT token_stream_rollup_tier_check
    CHECK (tier IN ('weekly', 'weekly_weekday', 'prior_year'));
-- migrate:down
ALTER TABLE hbpe.token_stream_rollup
    ADD CONSTRAINT token_stream_rollup_tier_check
    CHECK (tier IN ('weekly', 'prior_year'));
"""
    unrelated = """
-- migrate:up
ALTER TABLE hbpe.l1_clusters
    ADD CONSTRAINT l1_clusters_tier_check CHECK (tier IN ('anchor', 'ambient'));
-- migrate:down
"""

    # Another table's tier column is not this table's, in either spelling.
    assert _tier_vocabulary([created]) == ["weekly", "prior_year"]
    # The newest up section wins, and a later down section, which re-adds the
    # older constraint, is not read.
    assert _tier_vocabulary([created, widened]) == [
        "weekly",
        "weekly_weekday",
        "prior_year",
    ]
    # A migration that says nothing about this table leaves the vocabulary alone.
    assert _tier_vocabulary([created, widened, unrelated]) == [
        "weekly",
        "weekly_weekday",
        "prior_year",
    ]
