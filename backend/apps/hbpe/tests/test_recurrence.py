"""
Unit tests for the recurrence profiler (ci.hbpe.pipeline.recurrence).

Covers the pure math — profile statistics, smoothed hazard, renewal DP — and
the forecast/due formatting against monkeypatched profiles, without a live
Postgres. Forecast *calibration* is asserted as well as shape: a forecast that
puts the peak on the right day but expects 40 occurrences where 60 belong is
still wrong, and magnitude is where this engine's failure modes show up.
The rebuild's prune control flow runs against a recording fake connection;
DB-backed integration of the upsert/backfill SQL itself is exercised in the
staging compose environment.
"""

from __future__ import annotations

import datetime
import sys
from pathlib import Path

import numpy as np

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ci.hbpe.pipeline import recurrence as rec  # noqa: E402


def _dates(start: str, step_days: list[int]) -> list[datetime.date]:
    """Build a date sequence from a start date and successive gaps."""
    d = datetime.date.fromisoformat(start)
    out = [d]
    for g in step_days:
        d = d + datetime.timedelta(days=g)
        out.append(d)
    return out


# ── _profile_stats ─────────────────────────────────────────────────────────────


def test_profile_stats_weekly_habit_is_high_confidence():
    today = datetime.datetime.utcnow().date()
    last_monday = today - datetime.timedelta(days=today.weekday())
    dates = [last_monday - datetime.timedelta(weeks=10 - i) for i in range(11)]
    s = rec._profile_stats(dates, [[1]] * len(dates))

    assert s["n_days"] == 11
    assert s["gaps"] == [7] * 10
    assert s["median"] == 7.0
    assert s["std"] == 0.0
    assert s["conf"] == 1.0  # metronomic + enough samples
    assert s["dow"][0] > 0
    assert s["dow"][0] == max(s["dow"])
    assert all(v == 0 for v in s["dow"][1:])
    assert s["daypart"] == [0, 11, 0, 0]  # all morning


def test_profile_stats_irregular_is_low_confidence():
    dates = _dates("2026-01-01", [1, 9, 2, 15, 1, 20])
    s = rec._profile_stats(dates, [[0]] * len(dates))
    assert 0.0 <= s["conf"] < 0.3  # CV near/above 1


def test_profile_stats_too_few_intervals_gets_zero_confidence():
    dates = _dates("2026-01-01", [7, 7, 7])  # 3 intervals < MIN_INTERVALS_CONF
    s = rec._profile_stats(dates, [[2]] * len(dates))
    assert s["conf"] == 0.0
    assert s["median"] == 7.0  # stats still computed


def test_profile_stats_single_day_has_no_intervals():
    s = rec._profile_stats([datetime.date(2026, 1, 1)], [[3]])
    assert s["gaps"] == []
    assert s["median"] is None
    assert s["conf"] == 0.0


# ── build_recurrence_profiles (pruning) ────────────────────────────────────────


class _FakeCursor:
    """Records executed SQL; returns canned rows. Enough for the prune logic."""

    def __init__(self, rows: list, calls: list):
        self._rows, self._calls = rows, calls

    def execute(self, sql, params=None):
        self._calls.append((" ".join(str(sql).split()), params))

    def fetchall(self):
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, rows: list, calls: list):
        self._rows, self._calls = rows, calls

    def cursor(self, **_kw):
        return _FakeCursor(self._rows, self._calls)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_build_profiles_empty_read_leaves_profiles_alone(monkeypatch):
    """
    A transient empty read (serialization gap, deactivated clusters, a
    half-finished nightly) used to issue an unqualified DELETE for the whole
    user and report it as success — wiping every forecast until history
    reappeared.
    """
    calls: list = []
    monkeypatch.setattr(rec, "get_conn", lambda: _FakeConn([], calls))

    result = rec.build_recurrence_profiles("user-1234-abcd")

    assert result["profiles"] == 0
    assert result["skipped"] is True
    assert not any("DELETE" in sql.upper() for sql, _ in calls)


def test_build_profiles_prunes_only_vanished_clusters(monkeypatch):
    calls: list = []
    rows = [
        ("c1", datetime.date(2026, 3, 2), [1]),
        ("c1", datetime.date(2026, 3, 9), [1]),
        ("c1", datetime.date(2026, 3, 16), [1]),
    ]
    monkeypatch.setattr(rec, "get_conn", lambda: _FakeConn(rows, calls))

    result = rec.build_recurrence_profiles("user-1234-abcd")

    assert result["profiles"] == 1
    deletes = [
        (sql, params) for sql, params in calls if sql.upper().startswith("DELETE")
    ]
    assert len(deletes) == 1
    assert "NOT (l1_cluster_id = ANY" in deletes[0][0]
    assert deletes[0][1] == ("user-1234-abcd", ["c1"])


# ── _hazard / _renewal_probs ───────────────────────────────────────────────────


def test_hazard_peaks_at_observed_gap():
    h = rec._hazard([7] * 20)
    assert h[7] > h[6] and h[7] > h[8]
    assert h[7] > 0.5
    assert np.all((h >= 0) & (h <= 1))


def test_hazard_prior_does_not_scale_with_largest_gap():
    """
    Each h(g) carries its own Beta prior. A prior spread over the whole array —
    whose length is max(gaps)*2+7 — would let a single long gap outvote every
    real observation: one 120-day vacation used to drop h[7] from 0.79 to 0.17.
    """
    clean = rec._hazard([7] * 25)
    vacation = rec._hazard([7] * 25 + [120])

    assert clean[7] > 0.9
    assert vacation[7] > 0.9
    assert abs(vacation[7] - clean[7]) < 0.1  # one outlier ≈ one observation


def test_hazard_monthly_rhythm_is_forecastable():
    """A monthly cadence must peak near 30 days, not be flattened to ~0.1."""
    h = rec._hazard([30, 31, 28, 31, 30])
    assert max(h[28:32]) > 0.5
    assert h[15] < 0.05  # mid-cycle stays quiet


def test_dow_lift_is_mean_one_and_favours_the_habitual_weekday():
    lift = rec._dow_lift([11, 0, 0, 0, 0, 0, 0], n_days=11)
    assert abs(float(np.mean(lift)) - 1.0) < 1e-9  # calibration-preserving
    assert lift[0] > 4.0  # Mondays boosted
    assert all(value < 0.3 for value in lift[1:])  # the rest damped
    # No history and small samples fall back to "no weekday preference".
    assert np.allclose(rec._dow_lift([0] * 7, n_days=0), np.ones(7))
    assert float(np.max(rec._dow_lift([1, 1, 0, 0, 0, 0, 0], n_days=2))) < lift[0]


def test_renewal_probs_daily_cluster_stays_high_all_week():
    """The DP resets the clock on occurrence — without it, a daily habit's
    forecast would collapse to ~0 by mid-week."""
    probs = rec._renewal_probs([1] * 30, days_since_last=1, horizon=7)
    assert len(probs) == 7
    assert all(p > 0.6 for p in probs)


def test_renewal_probs_weekly_cluster_peaks_at_due_day():
    # An occurrence on the first forecast day would complete a gap of 7 —
    # exactly the habitual interval — so day index 0 is the peak.
    probs = rec._renewal_probs([7] * 20, days_since_last=7, horizon=7)
    assert probs[0] == max(probs)
    assert all(0.0 <= p <= 1.0 for p in probs)


# ── week_forecast / due_list ───────────────────────────────────────────────────


def _weekly_profile(**overrides) -> dict:
    p = {
        "l1_cluster_id": "c1",
        "display_name": "Gym Session",
        "l0_class": "EXERCISE",
        "n_occurrence_days": 11,
        "first_seen": datetime.date(2026, 1, 5),
        "last_seen": datetime.date(2026, 3, 16),
        "dow_counts": [11, 0, 0, 0, 0, 0, 0],
        "daypart_counts": [0, 11, 0, 0],
        "intervals_days": [7] * 10,
        "interval_median": 7.0,
        "interval_p25": 7.0,
        "interval_p75": 7.0,
        "interval_p90": 7.0,
        "periodicity_confidence": 1.0,
    }
    p.update(overrides)
    return p


def _daily_profile(**overrides) -> dict:
    p = _weekly_profile(
        l1_cluster_id="d1",
        display_name="Coffee",
        l0_class="ROUTINE",
        n_occurrence_days=31,
        first_seen=datetime.date(2026, 2, 14),
        dow_counts=[5, 4, 4, 4, 5, 4, 5],
        daypart_counts=[0, 31, 0, 0],
        intervals_days=[1] * 30,
        interval_median=1.0,
        interval_p25=1.0,
        interval_p75=1.0,
        interval_p90=1.0,
    )
    p.update(overrides)
    return p


def _monthly_profile(**overrides) -> dict:
    p = _weekly_profile(
        l1_cluster_id="m1",
        display_name="Rent",
        l0_class="ADMIN",
        n_occurrence_days=6,
        first_seen=datetime.date(2025, 10, 17),
        dow_counts=[1, 1, 1, 1, 1, 1, 0],
        daypart_counts=[0, 0, 6, 0],
        intervals_days=[30, 31, 28, 31, 30],
        interval_median=30.0,
        interval_p25=30.0,
        interval_p75=31.0,
        interval_p90=31.0,
        periodicity_confidence=0.9,
    )
    p.update(overrides)
    return p


def _forecast_mass(monkeypatch, profile, start, days) -> float:
    """Summed P(occurs) for one cluster over *days* — its expected occurrences."""
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [profile])
    out = rec.week_forecast("user", days=days, start=start)
    return sum(
        c["p_occur"]
        for d in out
        for c in d["clusters"]
        if c["cluster_id"] == profile["l1_cluster_id"]
    )


def _cluster_by_day(days: list[dict], cluster_id: str) -> list[float]:
    return [
        next(
            (c["p_occur"] for c in d["clusters"] if c["cluster_id"] == cluster_id), 0.0
        )
        for d in days
    ]


def test_week_forecast_expected_occurrences_match_the_base_rate(monkeypatch):
    """
    Calibration, not argmax: over 60 days a cluster whose median gap is k days
    should be expected to occur about 60/k times.  Asserting *magnitude* is the
    point — a forecast that is flat at 7%/day, or one whose hazard prior has
    been diluted by an arbitrary array length, still puts the peak on the right
    day but gets the total badly wrong (the pre-fix engine expected 39.8
    occurrences for a daily cluster and 1.49 for a monthly one).
    """
    monday = datetime.date(2026, 3, 16)  # == _weekly_profile last_seen
    tomorrow = monday + datetime.timedelta(days=1)
    cases = [
        ("weekly", _weekly_profile(), tomorrow, 7.0),
        # Stale: days_since_last (8) is past every observed gap, the regime where
        # the forecast used to collapse to a flat ~0.07/day.
        ("weekly, stale", _weekly_profile(), monday + datetime.timedelta(days=8), 7.0),
        ("daily", _daily_profile(), tomorrow, 1.0),
        ("monthly", _monthly_profile(), tomorrow, 30.0),
        (
            "every three days",
            _weekly_profile(
                l1_cluster_id="t1",
                n_occurrence_days=24,
                first_seen=datetime.date(2026, 1, 6),
                dow_counts=[4, 3, 3, 4, 3, 3, 4],
                daypart_counts=[0, 24, 0, 0],
                intervals_days=[3] * 23,
                interval_median=3.0,
                interval_p25=3.0,
                interval_p75=3.0,
                interval_p90=3.0,
            ),
            tomorrow,
            3.0,
        ),
    ]
    for label, profile, start, median_gap in cases:
        total = _forecast_mass(monkeypatch, profile, start, days=60)
        expected = 60.0 / median_gap
        # Every regime lands within 0.90–0.96 of truth; the band is tight enough
        # that the pre-fix engine (0.66–0.76) fails all five.
        assert 0.8 * expected <= total <= 1.25 * expected, (
            f"{label}: expected ≈{expected:.2f} occurrences in 60 days, got {total:.2f}"
        )


def test_week_forecast_stale_weekly_habit_still_peaks_on_its_weekday(monkeypatch):
    """
    last_seen is a Monday and the window opens the *following* Tuesday, so
    days_since_last = 8 — past the largest observed gap, where the empirical
    hazard is pure prior.  This is the default path (week_forecast starts
    tomorrow), and it used to return a flat ~0.07 for all seven days with the
    correct Monday no higher than Thursday.
    """
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [_weekly_profile()])
    start = datetime.date(2026, 3, 24)  # Tuesday, 8 days after last_seen
    days = rec.week_forecast("user", days=7, start=start)

    by_day = _cluster_by_day(days, "c1")
    assert days[6]["dow"] == "Monday"
    assert by_day[6] == max(by_day)
    assert by_day[6] > 0.4  # a real prediction, not noise
    assert by_day[6] > 3 * max(by_day[:6])  # and clearly above the rest


def test_week_forecast_two_observation_cluster_is_not_near_certain(monkeypatch):
    """Two occurrences a week apart used to report p_occur = 0.99."""
    tuesday = datetime.date(2026, 3, 10)
    thin = _weekly_profile(
        n_occurrence_days=2,
        first_seen=tuesday,
        last_seen=tuesday + datetime.timedelta(days=7),
        dow_counts=[0, 2, 0, 0, 0, 0, 0],
        daypart_counts=[0, 2, 0, 0],
        intervals_days=[7],
        periodicity_confidence=0.0,
    )
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [thin])
    days = rec.week_forecast("user", days=7, start=datetime.date(2026, 3, 18))

    by_day = _cluster_by_day(days, "c1")
    assert max(by_day) <= 0.5
    assert by_day[6] == max(by_day)  # still points at Tuesday


def test_week_forecast_outlier_gap_does_not_flatten_a_weekly_habit(monkeypatch):
    """A single 120-day vacation in an otherwise weekly history."""
    vacation = _weekly_profile(
        n_occurrence_days=26,
        first_seen=datetime.date(2025, 6, 2),
        dow_counts=[26, 0, 0, 0, 0, 0, 0],
        daypart_counts=[0, 26, 0, 0],
        intervals_days=[7] * 12 + [120] + [7] * 12,
    )
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [vacation])
    days = rec.week_forecast("user", days=7, start=datetime.date(2026, 3, 17))

    by_day = _cluster_by_day(days, "c1")
    assert days[6]["dow"] == "Monday"
    assert by_day[6] > 0.8


def test_week_forecast_shape_and_sorting(monkeypatch):
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(
        rec,
        "_load_profiles",
        lambda uid: [
            _weekly_profile(),
            _weekly_profile(
                l1_cluster_id="c2",
                display_name="Groceries",
                l0_class="ERRAND",
                intervals_days=[3] * 10,
                interval_median=3.0,
            ),
        ],
    )
    start = datetime.date(2026, 3, 17)  # Tuesday after last_seen Monday
    days = rec.week_forecast("user", days=7, start=start)

    assert len(days) == 7
    assert days[0]["date"] == "2026-03-17"
    assert days[0]["dow"] == "Tuesday"
    for day in days:
        probs = [c["p_occur"] for c in day["clusters"]]
        assert probs == sorted(probs, reverse=True)
        assert all(rec.FORECAST_P_FLOOR <= p <= 0.99 for p in probs)

    # Weekly Monday habit should peak the following Monday (index 6)
    gym_by_day = [
        next((c["p_occur"] for c in d["clusters"] if c["cluster_id"] == "c1"), 0.0)
        for d in days
    ]
    assert gym_by_day[6] == max(gym_by_day)
    # Daypart tendencies survive into the response
    gym = next(c for c in days[6]["clusters"] if c["cluster_id"] == "c1")
    assert gym["daypart_probs"] == {"morning": 1.0}


def test_week_forecast_skips_single_occurrence_clusters(monkeypatch):
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(
        rec,
        "_load_profiles",
        lambda uid: [
            _weekly_profile(n_occurrence_days=1, intervals_days=[]),
        ],
    )
    days = rec.week_forecast("user", days=7, start=datetime.date(2026, 3, 17))
    assert all(d["clusters"] == [] for d in days)


def test_due_list_flags_overdue_and_sorts_first(monkeypatch):
    today = datetime.datetime.utcnow().date()
    fresh = _weekly_profile(last_seen=today - datetime.timedelta(days=2))
    overdue = _weekly_profile(
        l1_cluster_id="c9",
        display_name="See Friends",
        l0_class="SOCIAL",
        last_seen=today - datetime.timedelta(days=16),
    )
    low_conf = _weekly_profile(l1_cluster_id="c3", periodicity_confidence=0.1)
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [fresh, overdue, low_conf])

    due = rec.due_list("user")

    assert [r["cluster_id"] for r in due] == ["c9", "c1"]  # low-conf excluded
    assert due[0]["overdue"] is True
    assert due[0]["days_since_last"] == 16
    assert due[0]["due_in_days"] == 7.0 - 16
    assert due[0]["scheduled_date"] is None
    assert due[1]["overdue"] is False
    assert due[1]["due_in_days"] == 5.0
    assert due[1]["window"] == [5.0, 5.0]


# ── RRULE parse / expand / cadence (Layer 3) ────────────────────────────────────


def test_parse_recurrence_accepts_string_and_dict():
    assert rec.parse_recurrence("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE") == {
        "freq": "WEEKLY",
        "interval": 2,
        "byday": [0, 2],
        "until": None,
        "count": None,
    }
    assert rec.parse_recurrence("RRULE:FREQ=DAILY") == {
        "freq": "DAILY",
        "interval": 1,
        "byday": [],
        "until": None,
        "count": None,
    }
    assert rec.parse_recurrence({"freq": "monthly", "interval": 1}) == {
        "freq": "MONTHLY",
        "interval": 1,
        "byday": [],
        "until": None,
        "count": None,
    }


def test_parse_recurrence_reads_until_and_count():
    assert rec.parse_recurrence("FREQ=WEEKLY;UNTIL=20250101T000000Z;BYDAY=MO")[
        "until"
    ] == datetime.date(2025, 1, 1)
    assert rec.parse_recurrence("FREQ=WEEKLY;UNTIL=2025-01-01")[
        "until"
    ] == datetime.date(2025, 1, 1)
    assert rec.parse_recurrence("FREQ=WEEKLY;COUNT=3")["count"] == 3
    # Unparseable terminators degrade to "no end", never to an exception.
    assert rec.parse_recurrence("FREQ=DAILY;UNTIL=whenever")["until"] is None
    assert rec.parse_recurrence("FREQ=DAILY;COUNT=lots")["count"] is None
    assert rec.parse_recurrence("FREQ=DAILY;COUNT=0")["count"] is None


def test_parse_recurrence_rejects_junk():
    assert rec.parse_recurrence(None) is None
    assert rec.parse_recurrence("") is None
    assert rec.parse_recurrence("FREQ=HOURLY") is None
    assert rec.parse_recurrence({"nope": 1}) is None


def test_expand_occurrences_weekly_byday():
    rule = rec.parse_recurrence("FREQ=WEEKLY;BYDAY=TU")
    occ = rec.expand_occurrences(
        rule,
        datetime.date(2026, 1, 6),  # a Tuesday
        datetime.date(2026, 1, 5),
        datetime.date(2026, 1, 27),
    )
    assert occ == [
        datetime.date(2026, 1, 6),
        datetime.date(2026, 1, 13),
        datetime.date(2026, 1, 20),
        datetime.date(2026, 1, 27),
    ]


def test_expand_occurrences_biweekly_skips_alternate_weeks():
    rule = rec.parse_recurrence("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")
    occ = rec.expand_occurrences(
        rule,
        datetime.date(2026, 1, 5),  # a Monday
        datetime.date(2026, 1, 5),
        datetime.date(2026, 2, 2),
    )
    assert occ == [
        datetime.date(2026, 1, 5),
        datetime.date(2026, 1, 19),
        datetime.date(2026, 2, 2),
    ]


def test_expand_occurrences_stops_at_until():
    rule = rec.parse_recurrence("FREQ=WEEKLY;BYDAY=TU;UNTIL=20260114")
    occ = rec.expand_occurrences(
        rule,
        datetime.date(2026, 1, 6),
        datetime.date(2026, 1, 5),
        datetime.date(2026, 1, 27),
    )
    assert occ == [datetime.date(2026, 1, 6), datetime.date(2026, 1, 13)]


def test_expand_occurrences_ended_series_yields_nothing():
    """A standup from a job the user left must not recur forever."""
    rule = rec.parse_recurrence("FREQ=WEEKLY;UNTIL=20250101T000000Z;BYDAY=MO")
    assert (
        rec.expand_occurrences(
            rule,
            datetime.date(2024, 1, 1),
            datetime.date(2026, 8, 3),
            datetime.date(2026, 8, 17),
        )
        == []
    )


def test_expand_occurrences_honours_count():
    rule = rec.parse_recurrence("FREQ=WEEKLY;COUNT=3;BYDAY=TU")
    assert rec.expand_occurrences(
        rule,
        datetime.date(2026, 1, 6),
        datetime.date(2026, 1, 5),
        datetime.date(2026, 2, 28),
    ) == [
        datetime.date(2026, 1, 6),
        datetime.date(2026, 1, 13),
        datetime.date(2026, 1, 20),
    ]
    # COUNT runs from series_start, so a later window sees a spent series.
    assert (
        rec.expand_occurrences(
            rule,
            datetime.date(2026, 1, 6),
            datetime.date(2026, 2, 1),
            datetime.date(2026, 2, 28),
        )
        == []
    )


def test_rrule_cadence_days():
    assert rec._rrule_cadence_days(rec.parse_recurrence("FREQ=WEEKLY")) == 7.0
    assert rec._rrule_cadence_days(rec.parse_recurrence("FREQ=MONTHLY")) == 30.0
    assert rec._rrule_cadence_days(rec.parse_recurrence("FREQ=YEARLY")) == 365.25
    assert rec._rrule_cadence_days(
        rec.parse_recurrence("FREQ=WEEKLY;BYDAY=MO,WE,FR")
    ) == round(7 / 3, 1)


def test_parse_and_expand_yearly():
    rule = rec.parse_recurrence("FREQ=YEARLY")
    assert rule is not None
    assert rule["freq"] == "YEARLY"
    occ = rec.expand_occurrences(
        rule,
        datetime.date(2024, 7, 4),
        datetime.date(2026, 1, 1),
        datetime.date(2026, 12, 31),
    )
    assert occ == [datetime.date(2026, 7, 4)]


# ── Reconciliation: due_list (Layer 1) + week_forecast (Layer 2) ────────────────


def _event(cluster_id, days_ahead, status="confirmed", **kw):
    st = datetime.datetime.utcnow() + datetime.timedelta(days=days_ahead)
    return {
        "cluster_id": cluster_id,
        "display_name": "X",
        "l0_class": "SOCIAL",
        "start_time": st,
        "status": status,
        "is_recurring": False,
        "recurrence_pattern": None,
        **kw,
    }


def test_due_list_suppresses_overdue_when_booked(monkeypatch):
    today = datetime.datetime.utcnow().date()
    overdue = _weekly_profile(
        l1_cluster_id="c9",
        display_name="See Friends",
        l0_class="SOCIAL",
        last_seen=today - datetime.timedelta(days=16),
    )
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [overdue])
    # A confirmed catch-up two days out: no longer "neglected".
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [_event("c9", 2)])

    due = rec.due_list("user")
    assert len(due) == 1
    assert due[0]["overdue"] is False
    assert due[0]["scheduled_date"] == (today + datetime.timedelta(days=2)).isoformat()


def test_upcoming_events_sql_excludes_cancelled_and_deleted():
    """
    The cancelled / no_show exclusion lives entirely in the loader's WHERE
    clause, so any test that monkeypatches _load_upcoming_events cannot
    exercise it — assert the predicate itself instead. (Reachable only from the
    staging compose environment otherwise; see the module docstring.)
    """
    sql = " ".join(rec._UPCOMING_EVENTS_SQL.split())
    assert "e.status IN ('confirmed', 'tentative')" in sql
    assert "e.is_deleted = FALSE" in sql


def test_due_list_overdue_stands_when_nothing_is_booked(monkeypatch):
    today = datetime.datetime.utcnow().date()
    overdue = _weekly_profile(
        l1_cluster_id="c9", last_seen=today - datetime.timedelta(days=16)
    )
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [overdue])
    monkeypatch.setattr(rec, "_load_upcoming_events", lambda uid, h: [])

    due = rec.due_list("user")
    assert due[0]["overdue"] is True
    assert due[0]["scheduled_date"] is None


def test_due_list_ended_series_does_not_suppress_overdue(monkeypatch):
    """
    Recurring rows are loaded regardless of date, so an ended series used to
    expand into phantom occurrences and permanently clear the overdue flag.
    """
    today = datetime.datetime.utcnow().date()
    overdue = _weekly_profile(
        l1_cluster_id="c9",
        display_name="Team Standup",
        l0_class="WORK",
        last_seen=today - datetime.timedelta(days=16),
    )
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [overdue])
    monkeypatch.setattr(
        rec,
        "_load_upcoming_events",
        lambda uid, h: [
            {
                "cluster_id": "c9",
                "display_name": "Team Standup",
                "l0_class": "WORK",
                "start_time": datetime.datetime.utcnow() - datetime.timedelta(days=730),
                "status": "confirmed",
                "is_recurring": True,
                "recurrence_pattern": f"FREQ=WEEKLY;UNTIL={(today - datetime.timedelta(days=365)):%Y%m%d}T000000Z",
            }
        ],
    )

    due = rec.due_list("user")
    assert due[0]["scheduled_date"] is None
    assert due[0]["overdue"] is True


def test_due_list_seeds_from_calendar_recurrence(monkeypatch):
    # Only 2 statistical intervals (< 3, normally excluded) but a weekly RRULE.
    today = datetime.datetime.utcnow().date()
    thin = _weekly_profile(
        l1_cluster_id="c5",
        display_name="Team Standup",
        l0_class="WORK",
        intervals_days=[7, 7],
        periodicity_confidence=0.0,
        last_seen=today - datetime.timedelta(days=3),
    )
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [thin])
    monkeypatch.setattr(
        rec,
        "_load_upcoming_events",
        lambda uid, h: [
            {
                "cluster_id": "c5",
                "display_name": "Team Standup",
                "l0_class": "WORK",
                "start_time": datetime.datetime.utcnow() + datetime.timedelta(days=4),
                "status": "confirmed",
                "is_recurring": True,
                "recurrence_pattern": "FREQ=WEEKLY",
            },
        ],
    )

    due = rec.due_list("user")
    assert len(due) == 1  # seeded despite <3 intervals
    assert due[0]["median_interval_days"] == 7.0
    assert due[0]["scheduled_date"] is not None


def test_week_forecast_overlays_booked_event(monkeypatch):
    start = datetime.date(2026, 3, 17)
    monkeypatch.setattr(
        rec,
        "_load_profiles",
        lambda uid: [
            _weekly_profile(l1_cluster_id="c1", last_seen=datetime.date(2026, 3, 16)),
        ],
    )
    # A confirmed event on day index 2 for a cluster with no profile at all.
    ev_dt = datetime.datetime(2026, 3, 19, 15, 0)
    monkeypatch.setattr(
        rec,
        "_load_upcoming_events",
        lambda uid, h: [
            {
                "cluster_id": "cX",
                "display_name": "Dentist",
                "l0_class": "ERRAND",
                "start_time": ev_dt,
                "status": "confirmed",
                "is_recurring": False,
                "recurrence_pattern": None,
            },
        ],
    )

    days = rec.week_forecast("user", days=7, start=start)
    dentist = next(c for c in days[2]["clusters"] if c["cluster_id"] == "cX")
    assert dentist["p_occur"] == 1.0
    assert dentist["scheduled"] is True
    # statistical cells remain flagged not-scheduled (the Monday-only gym habit
    # now only has a cell on its own weekday — index 6)
    gym = next(c for c in days[6]["clusters"] if c["cluster_id"] == "c1")
    assert gym["scheduled"] is False


def test_week_forecast_ignores_ended_recurring_series(monkeypatch):
    """An ended RRULE must not pin p_occur = 1.0 cells into the future."""
    start = datetime.date(2026, 3, 17)
    monkeypatch.setattr(rec, "_load_profiles", lambda uid: [])
    monkeypatch.setattr(
        rec,
        "_load_upcoming_events",
        lambda uid, h: [
            {
                "cluster_id": "cGone",
                "display_name": "Old Standup",
                "l0_class": "WORK",
                "start_time": datetime.datetime(2024, 1, 1, 9, 0),
                "status": "confirmed",
                "is_recurring": True,
                "recurrence_pattern": "FREQ=WEEKLY;UNTIL=20250101T000000Z;BYDAY=MO",
            }
        ],
    )

    days = rec.week_forecast("user", days=7, start=start)
    assert all(d["clusters"] == [] for d in days)
