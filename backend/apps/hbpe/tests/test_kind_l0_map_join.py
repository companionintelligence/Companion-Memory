"""
Tests for hbpe.kind_l0_map: the column its consumers join on, and whether the
patterns it is seeded with can match anything.

Context. 20260828120000_hbpe_life_forecast.sql seeded the table with the
importer's DOTTED capture-kind vocabulary ('media.listen', 'fitness.workout')
while all four consumers joined it against ci.events.event_type, which carries
the BARE-VERB classification ('listen', 'workout'). The vocabularies never
overlap, so the join matched 0 of 198,733 events on a real appliance: the
static fast path was dead, ~195k ambient events queued for the chat LLM one at
a time, and every event that did get labeled took tier 'anchor' / 5 min instead
of the map's ambient / 3-15 — which in turn made bucket_aggregator rank a
3-minute Spotify play above a 45-minute workout.

Two things had to be true for that to ship, and there is a test class here for
each:

  * the column contract — every consumer must key on metadata->>'kind'
  * pattern reachability — a pattern that matches nothing is dead weight, and
    four of the eight seeded ones did (media.play, view, visited,
    wearable.sleep), including a miss on the single largest stream

The pattern tests run the REAL patterns: they parse them out of the shipped
migration SQL rather than restating them, so a future migration that regresses
the seed fails here instead of silently going quiet again.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe import data_client as dc  # noqa: E402
from ci.hbpe.tokenizer import static_labeler as sl  # noqa: E402
from ci.hbpe.tokenizer import vocab_cleanup as vc  # noqa: E402
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES  # noqa: E402

BACKEND = Path(__file__).resolve().parents[3]
MIGRATIONS = BACKEND / "apps/api/db/postgres/migrations"
CANONICAL_TS = BACKEND / "apps/api/src/domains/import/push/canonical.ts"

USER = "01a0517c-0851-768e-b8ba-6754b7a9b7e3"

# Measured histogram of ci.events.metadata->>'kind' on the reference appliance
# (198,733 non-deleted events). Not a hand-written fixture: this is the corpus
# the bug was found on, so coverage computed against it is the real number.
LIVE_CORPUS: dict[str, int] = {
    "media.listen": 118286,
    "media.watch": 68638,
    "social.post": 2737,
    "fitness.workout": 2095,
    "calendar.event": 1841,
    "wearable.observation": 1652,
    "import.archive_item": 1267,
    "social.like": 1257,
    "commerce.order": 630,
    "capture.photo": 134,
    "capture.video": 107,
    "travel.trip": 79,
    "social.bookmark": 6,
    "commerce.transaction": 4,
}
CORPUS_TOTAL = sum(LIVE_CORPUS.values())


# ── SQL LIKE, in Python ───────────────────────────────────────────────────────


def like(value: str, pattern: str) -> bool:
    """Evaluate SQL ``value LIKE pattern`` ('%' = any run, '_' = one char)."""
    out = []
    for ch in pattern:
        if ch == "%":
            out.append(".*")
        elif ch == "_":
            out.append(".")
        else:
            out.append(re.escape(ch))
    return re.fullmatch("".join(out), value) is not None


def test_like_helper_matches_postgres_semantics():
    """The helper is load-bearing for every coverage assertion below."""
    assert like("media.listen", "media.listen")
    assert not like("media.listen", "media.play")
    assert like("social.post", "social.%")
    assert like("social.", "social.%")  # '%' matches the empty run
    assert not like("social", "social.%")
    # '.' is literal, not the regex any-char — 'mediaXlisten' must not match.
    assert not like("mediaXlisten", "media.listen")


# ── The shipped seed, parsed out of the migrations ────────────────────────────

_TUPLE = re.compile(
    r"\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*\)"
)
_DELETE_ONE = re.compile(
    r"DELETE\s+FROM\s+hbpe\.kind_l0_map\s+WHERE\s+kind_pattern\s*=\s*'([^']*)'",
    re.IGNORECASE,
)
_DELETE_IN = re.compile(
    r"DELETE\s+FROM\s+hbpe\.kind_l0_map\s+WHERE\s+kind_pattern\s+IN\s*\(([^)]*)\)",
    re.IGNORECASE,
)


def _up_section(sql: str) -> str:
    """The migrate:up half, with '--' comment lines removed.

    Splitting on migrate:down matters: this migration's down half re-inserts
    the very patterns the up half removes, so parsing the whole file would
    reconstruct the broken seed and quietly pass.
    """
    up = re.split(r"^--\s*migrate:down\s*$", sql, flags=re.MULTILINE)[0]
    return "\n".join(
        line for line in up.splitlines() if not line.lstrip().startswith("--")
    )


def seeded_kind_map() -> dict[str, dict]:
    """Replay every migration that touches hbpe.kind_l0_map, in applied order."""
    files = sorted(
        p for p in MIGRATIONS.glob("*.sql") if "kind_l0_map" in p.read_text()
    )
    assert files, f"no migration seeds hbpe.kind_l0_map under {MIGRATIONS}"

    table: dict[str, dict] = {}
    for path in files:
        up = _up_section(path.read_text())
        for statement in up.split(";"):
            if "kind_l0_map" not in statement:
                continue
            if re.search(r"INSERT\s+INTO\s+hbpe\.kind_l0_map", statement, re.I):
                for pattern, l0, label, tier, minutes in _TUPLE.findall(statement):
                    # ON CONFLICT DO NOTHING: first writer of a pattern wins.
                    table.setdefault(
                        pattern,
                        {
                            "l0_class": l0,
                            "l1_label": label,
                            "tier": tier,
                            "default_duration_min": int(minutes),
                        },
                    )
            for pattern in _DELETE_ONE.findall(statement):
                table.pop(pattern, None)
            for group in _DELETE_IN.findall(statement):
                for pattern in re.findall(r"'([^']*)'", group):
                    table.pop(pattern, None)
    return table


def capture_kind_vocabulary() -> set[str]:
    """The closed dotted kind set the importer can actually stamp.

    Parsed from KIND_BY_CLASSIFICATION in canonical.ts so this test tracks the
    producer instead of a copy of it that can drift.
    """
    src = CANONICAL_TS.read_text()
    block = re.search(r"const KIND_BY_CLASSIFICATION[^{]*\{(.*?)\n\};", src, re.DOTALL)
    assert block, f"KIND_BY_CLASSIFICATION not found in {CANONICAL_TS}"
    kinds = set(re.findall(r":\s*'([a-z_]+\.[a-z_]+)'", block.group(1)))
    # kindFor() decides these three from the MIME rather than from the
    # classification map, so they are not in the literal block above.
    kinds |= {"capture.photo", "capture.video", "capture.audio"}
    return kinds


def test_migration_parser_finds_the_expected_shape():
    """Guard the parser itself — a silently-empty parse would vacate the suite."""
    table = seeded_kind_map()
    assert len(table) == 8, table
    for row in table.values():
        assert row["l0_class"] in L0_CLASSES
        assert row["tier"] in ("anchor", "ambient")
        assert row["default_duration_min"] > 0


# ── The column contract ───────────────────────────────────────────────────────


class _Cursor:
    def __init__(self, calls: list):
        self._calls = calls

    def execute(self, sql, params=None):
        self._calls.append(" ".join(str(sql).split()))

    def fetchall(self):
        return []

    def fetchone(self):
        return None

    @property
    def rowcount(self):
        return 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Conn:
    def __init__(self, calls: list):
        self._calls = calls

    def cursor(self, **_kw):
        return _Cursor(self._calls)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


_MAP_ROW = {
    "kind_pattern": "media.listen",
    "l0_class": "LEISURE",
    "l1_label": "Listening",
    "tier": "ambient",
    "default_duration_min": 3,
}


def _consumer_sql(monkeypatch) -> dict[str, list[str]]:
    """Every statement the four kind_l0_map consumers emit, by consumer."""
    out: dict[str, list[str]] = {}

    def wire(module, calls):
        monkeypatch.setattr(module, "get_conn", lambda: _Conn(calls))

    monkeypatch.setattr(sl, "load_kind_map", lambda: [_MAP_ROW])
    monkeypatch.setattr(vc, "load_kind_map", lambda: [_MAP_ROW])
    monkeypatch.setattr(
        "ci.hbpe.tokenizer.static_labeler.get_or_create_l1",
        lambda *a, **k: ("00000000-0000-0000-0000-000000000001", False),
    )
    monkeypatch.setattr(
        "ci.hbpe.tokenizer.vocab_cleanup.get_or_create_l1",
        lambda *a, **k: ("00000000-0000-0000-0000-000000000001", False),
    )
    monkeypatch.setattr(dc, "_ensure_events_cti_schema", lambda conn: None)

    out["static_labeler"] = calls = []
    wire(sl, calls)
    sl.label_mapped_events(USER)

    out["vocab_cleanup"] = calls = []
    wire(vc, calls)
    vc._relabel_mapped_off_junk(USER)

    out["get_unlabeled_events"] = calls = []
    wire(dc, calls)
    dc.get_unlabeled_events(USER)

    out["get_token_events_for_day"] = calls = []
    wire(dc, calls)
    dc.get_token_events_for_day(USER, "2026-08-30")

    return out


def test_every_consumer_joins_the_map_on_metadata_kind(monkeypatch):
    """
    All four sites must agree, because they partition one corpus between them:
    the labeler claims mapped kinds, the drain excludes exactly what the
    labeler claimed, the token reader looks up the tier/duration for what was
    claimed, and the cleanup rehomes them. One site on a different column is
    the bug this file exists for.
    """
    captured = _consumer_sql(monkeypatch)
    assert set(captured) == {
        "static_labeler",
        "vocab_cleanup",
        "get_unlabeled_events",
        "get_token_events_for_day",
    }
    for name, statements in captured.items():
        joined = " ".join(statements)
        assert "(e.metadata->>'kind') LIKE" in joined, name
        assert "e.event_type LIKE" not in joined, name


def test_token_reader_takes_only_the_most_specific_matching_pattern(monkeypatch):
    """
    kind_l0_map may hold overlapping patterns — load_kind_map orders them
    longest-first precisely so the claim loop resolves 'social.post' before
    'social.%'. A plain LEFT JOIN in the token reader has no such tie-break and
    would emit the event once per matching pattern, doubling its bucket tokens.
    """
    sql = " ".join(_consumer_sql(monkeypatch)["get_token_events_for_day"])
    assert "LEFT JOIN LATERAL" in sql
    assert "ORDER BY length(km.kind_pattern) DESC LIMIT 1" in sql


# ── Pattern reachability and semantics ────────────────────────────────────────


def test_every_seeded_pattern_can_match_a_real_capture_kind():
    """
    A pattern outside the closed capture-kind vocabulary is permanently dead —
    no corpus can ever satisfy it. The original seed shipped two: 'view' and
    'visited' are bare verbs that no importer stamps.
    """
    vocabulary = capture_kind_vocabulary()
    for pattern in seeded_kind_map():
        assert any(like(kind, pattern) for kind in vocabulary), (
            f"{pattern!r} matches no member of the capture-kind vocabulary"
        )


def test_the_map_covers_the_ambient_bulk_of_a_real_corpus():
    """
    The whole point of the static path is that the chat LLM never sees the
    high-volume ambient streams. Pre-fix this was 0%.
    """
    patterns = list(seeded_kind_map())
    covered = sum(
        n for kind, n in LIVE_CORPUS.items() if any(like(kind, p) for p in patterns)
    )
    assert covered / CORPUS_TOTAL > 0.95, f"{covered}/{CORPUS_TOTAL}"


@pytest.mark.parametrize(
    ("kind", "expected_tier"),
    [
        # 118,286 events — 59.5% of the corpus and the miss that cost the most.
        ("media.listen", "ambient"),
        ("media.watch", "ambient"),
        ("social.post", "ambient"),
        ("social.like", "ambient"),
        ("fitness.workout", "anchor"),
        ("travel.trip", "anchor"),
    ],
)
def test_high_volume_kinds_get_the_tier_the_aggregator_needs(kind, expected_tier):
    """
    Tier is not cosmetic: bucket_aggregator._rank puts tier ahead of duration,
    so an ambient stream mis-tiered as 'anchor' outranks a real workout in its
    bucket. Matching a kind but tiering it wrong is worse than not matching it.
    """
    table = seeded_kind_map()
    matches = [p for p in table if like(kind, p)]
    assert matches, f"{kind} matches no seeded pattern"
    assert len(matches) == 1, f"{kind} matches {matches}; the join would fan out"
    assert table[matches[0]]["tier"] == expected_tier


def test_ambient_defaults_stay_shorter_than_anchor_defaults():
    """
    default_duration_min only fires for point events (no end_time), where it
    decides how many 15-minute buckets the event claims. An ambient default as
    long as an anchor's would let a single Instagram like blanket an hour.
    """
    table = seeded_kind_map()
    ambient = [
        r["default_duration_min"] for r in table.values() if r["tier"] == "ambient"
    ]
    anchor = [
        r["default_duration_min"] for r in table.values() if r["tier"] == "anchor"
    ]
    assert max(ambient) <= min(anchor)


def test_seeded_patterns_are_mutually_exclusive_on_a_real_corpus():
    """No corpus kind may match two patterns — see the LATERAL rationale."""
    patterns = list(seeded_kind_map())
    for kind in LIVE_CORPUS:
        hits = [p for p in patterns if like(kind, p)]
        assert len(hits) <= 1, f"{kind} matches {hits}"
