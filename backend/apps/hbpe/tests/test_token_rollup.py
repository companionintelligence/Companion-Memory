"""
Unit tests for the weekly rollup grouping (ci.hbpe.pipeline.token_rollup).

Covers the pure grouping logic in `_build_weekly` against a monkeypatched
`_load_tokens`, without a live Postgres.
"""

from __future__ import annotations

import datetime
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe.pipeline import token_rollup as tr  # noqa: E402


def test_build_weekly_weekday_and_weekend_rows_do_not_collide_on_pk(monkeypatch):
    """A week with both a weekday and a weekend token must not produce two
    rollup rows sharing (user_id, period_start, tier, seq_order) — that
    combination is hbpe.token_stream_rollup's primary key."""
    monkeypatch.setattr(
        tr,
        "_load_tokens",
        lambda u, s, e: [
            # Wednesday 2026-07-15 (weekday)
            {
                "date": datetime.date(2026, 7, 15),
                "bucket_idx": 40,
                "level": "L0",
                "token_id": "WORK",
            },
            # Saturday 2026-07-18, same week (weekend)
            {
                "date": datetime.date(2026, 7, 18),
                "bucket_idx": 60,
                "level": "L0",
                "token_id": "LEISURE",
            },
        ],
    )

    rows = tr._build_weekly("u1", datetime.date(2026, 9, 2))

    # (user_id, period_start, tier, seq_order) is the PK.
    keys = [(r[0], r[1], r[2], r[3]) for r in rows]
    assert len(keys) == len(set(keys)), keys

    # Both the weekday and weekend token still make it into the rollup.
    token_ids = {r[6] for r in rows}
    assert token_ids == {"WORK", "LEISURE"}
