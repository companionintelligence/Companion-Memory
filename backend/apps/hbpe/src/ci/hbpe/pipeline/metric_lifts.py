"""
daily_metrics as inference-time class priors — never training tokens.

Same 14-day / coverage≥0.5 floor as #63. Below the floor every lift is 1.0
(still-learning, not "usually").
"""

from __future__ import annotations

import datetime
from typing import Any

from ci.hbpe.buckets import BUCKET_MINUTES, BUCKETS_PER_DAY
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

COLD_START_MIN_DAYS = 14
COLD_START_MIN_COVERAGE = 0.5
SLEEP_MEDIAN_FALLBACK = 420.0  # 7h
HOME_MEDIAN_FALLBACK = 600.0  # 10h
LIFT_LO = 0.5
LIFT_HI = 2.0


def _hour_range(start_hour: int, end_hour: int) -> range:
    """Wall-clock hours → bucket indices at the current `BUCKET_MINUTES` grid."""
    start = (start_hour * 60) // BUCKET_MINUTES
    end = (end_hour * 60) // BUCKET_MINUTES
    return range(start, min(end, BUCKETS_PER_DAY))


# Temporary fallbacks until sleep/work windows are learned from token_stream.
# These must track BUCKET_MINUTES (currently 15): the old literals assumed 30-min
# buckets and applied "evening sleep" to 10:30–12:00.
SLEEP_MORNING = _hour_range(0, 8)
SLEEP_EVENING = _hour_range(21, 24)
WORK_HOURS = _hour_range(8, 18)


def _clip(value: float, lo: float = LIFT_LO, hi: float = LIFT_HI) -> float:
    return max(lo, min(hi, value))


def _metric_coverage(coverage: Any, key: str) -> float:
    if not isinstance(coverage, dict):
        return 0.0
    try:
        return float(coverage.get(key) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def coverage_ok(rows: list[dict]) -> bool:
    """True when ≥14 rows have sleep or home coverage ≥ 0.5 with a real value."""
    n = 0
    for row in rows:
        cov = row.get("coverage") or {}
        sleep = row.get("sleep_minutes")
        home = row.get("time_at_home")
        if (
            sleep is not None
            and _metric_coverage(cov, "sleep_minutes") >= COLD_START_MIN_COVERAGE
        ):
            n += 1
            continue
        if (
            home is not None
            and _metric_coverage(cov, "time_at_home") >= COLD_START_MIN_COVERAGE
        ):
            n += 1
    return n >= COLD_START_MIN_DAYS


def day_coverage_weight(row: dict | None, floor_cleared: bool) -> float:
    """Down-weight a history day with thin metric coverage. 1.0 below the floor."""
    if not floor_cleared or row is None:
        return 1.0
    cov = row.get("coverage") or {}
    parts = [
        _metric_coverage(cov, "sleep_minutes"),
        _metric_coverage(cov, "time_at_home"),
    ]
    mean = sum(parts) / len(parts)
    return _clip(mean if mean > 0 else 1.0, lo=0.25, hi=1.0)


def class_multipliers(
    bucket_index: int,
    sleep_minutes: float | None,
    time_at_home: float | None,
    sleep_median: float,
    home_median: float,
    floor_cleared: bool,
) -> dict[str, float]:
    lifts = {c: 1.0 for c in L0_CLASSES}
    if not floor_cleared:
        return lifts

    if sleep_minutes is not None and sleep_median > 0:
        ratio = _clip(sleep_minutes / sleep_median)
        if bucket_index in SLEEP_MORNING or bucket_index in SLEEP_EVENING:
            lifts["SLEEP"] = ratio

    if time_at_home is not None and home_median > 0:
        ratio = _clip(time_at_home / home_median)
        if bucket_index in WORK_HOURS:
            lifts["WORK"] = _clip(1.0 / max(ratio, 0.25))
            lifts["LEISURE"] = ratio

    return lifts


def priors_matrix(
    n_buckets: int,
    sleep_minutes: float | None,
    time_at_home: float | None,
    sleep_median: float,
    home_median: float,
    floor_cleared: bool,
) -> list[list[float]]:
    """``(n_buckets, 8)`` lift matrix in ``L0_CLASSES`` order."""
    rows: list[list[float]] = []
    for b in range(n_buckets):
        m = class_multipliers(
            b, sleep_minutes, time_at_home, sleep_median, home_median, floor_cleared
        )
        rows.append([m[c] for c in L0_CLASSES])
    return rows


def median(values: list[float], fallback: float) -> float:
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return fallback
    mid = len(xs) // 2
    if len(xs) % 2:
        return float(xs[mid])
    return (xs[mid - 1] + xs[mid]) / 2.0


def fetch_metric_rows(
    user_id: str, start: datetime.date, end: datetime.date
) -> list[dict]:
    """Read-only; missing table/columns → empty list."""
    from ci.hbpe.database import get_conn

    sql = """
        SELECT date, sleep_minutes, time_at_home, coverage
        FROM ci_derived.daily_metrics
        WHERE user_id = %s AND date >= %s AND date <= %s
        ORDER BY date
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (user_id, start, end))
                cols = [d[0] for d in cur.description]
                rows = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
        for row in rows:
            if isinstance(row.get("date"), datetime.datetime):
                row["date"] = row["date"].date()
            elif not isinstance(row.get("date"), datetime.date) and row.get("date"):
                row["date"] = datetime.date.fromisoformat(str(row["date"]))
        return rows
    except Exception:
        return []
