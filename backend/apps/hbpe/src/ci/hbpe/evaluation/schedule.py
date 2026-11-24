"""
Tomorrow's calendar as a forecast input.

Every other forecaster in this harness answers from history alone. But a
next-day forecast is made the evening before, and by then the scheduled part of
tomorrow is already sitting in ``ci.events``. Nothing in the serving path reads
it. The forecast a product can actually show is *known schedule plus learned
residual*: scheduled blocks come from the calendar, and the model is only asked
about the time nobody has booked.

⚠ On a calendar-derived corpus this row is close to circular, and must be read
as a ceiling rather than as a result.

``hbpe.token_stream`` is produced by tokenising ``ci.events``. Where every event
is a calendar event — which is the case for the corpora this has been run
against — reconstructing bucket→class from those same events reproduces the
actuals almost exactly, so the row scores near-perfectly and has measured
nothing except that the tokeniser is a function. It becomes a real measurement
only once the corpus carries classes that do *not* come from the calendar
(wearable sleep, location transit, media leisure), at which point the gap
between this row and the baselines is the genuine value of reading the
schedule.

What is informative today is the **coverage** number this module reports
separately: the fraction of a day's buckets any scheduled event speaks to at
all. That is not circular, and it bounds how much of the day the calendar can
ever explain.

The class attached to a scheduled event is also an assumption. Production would
run the labeler over tomorrow's calendar entry, which depends only on the
entry's own text and so is legitimately available in advance; here the label is
read from ``hbpe.l1_event_cluster`` because that is the only assignment
available offline. That is the oracle part.
"""

from __future__ import annotations

import datetime
from collections.abc import Sequence

import numpy as np

from ci.hbpe.buckets import BUCKET_MINUTES, BUCKETS_PER_DAY
from ci.hbpe.evaluation.forecaster import CLASS_INDEX, N_CLASSES, DayFit
from ci.hbpe.event_status import LIVE_EVENT_SQL

# Confidence assigned to a bucket a scheduled event covers. Not 1.0: a calendar
# entry says something was booked, not that it happened.
SCHEDULE_CONFIDENCE = 0.85

# An event that did not happen is not on the schedule either: a meeting the
# source cancelled is still a row, and counting it would forecast a block nobody
# attends. The predicate is the shared one (event_status.LIVE_EVENT_SQL), and
# tests/test_event_status_readers.py fails any ci.events reader that omits it.
_EVENTS_SQL = f"""
    SELECT e.start_time, e.end_time, lc.l0_class
    FROM ci.events e
    JOIN hbpe.l1_event_cluster lec ON lec.event_id = e.event_id
    JOIN hbpe.l1_clusters      lc  ON lc.cluster_id = lec.cluster_id
    WHERE e.user_id = %s
      AND e.is_deleted = FALSE AND {LIVE_EVENT_SQL}
      AND e.start_time IS NOT NULL
      AND lc.l0_class IS NOT NULL
"""


def covered_buckets(
    start: datetime.datetime, finish: datetime.datetime
) -> list[tuple[datetime.date, int]]:
    """
    ``(date, bucket_idx)`` pairs an event occupies.

    The cursor is floored to the bucket that contains *start*. Stepping from the
    exact start minute skips every later bucket the event still crosses: a
    10:14–10:16 event recorded 10:00–10:15 and then jumped to 10:29, leaving
    10:15–10:30 empty.
    """
    minute_of_day = start.hour * 60 + start.minute
    floored = (minute_of_day // BUCKET_MINUTES) * BUCKET_MINUTES
    cursor = start.replace(
        hour=floored // 60,
        minute=floored % 60,
        second=0,
        microsecond=0,
    )
    covered: list[tuple[datetime.date, int]] = []
    while cursor < finish:
        bucket = (cursor.hour * 60 + cursor.minute) // BUCKET_MINUTES
        if 0 <= bucket < BUCKETS_PER_DAY:
            covered.append((cursor.date(), bucket))
        cursor += datetime.timedelta(minutes=BUCKET_MINUTES)
    return covered


def fetch_schedule(user_id: str) -> dict[datetime.date, dict[int, str]]:
    """``{date: {bucket_idx: l0_class}}`` for every classified scheduled event."""
    from ci.hbpe.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_EVENTS_SQL, (user_id,))
            rows = cur.fetchall()

    out: dict[datetime.date, dict[int, str]] = {}
    for start, end, l0_class in rows:
        if start is None or l0_class not in CLASS_INDEX:
            continue
        finish = end or (start + datetime.timedelta(minutes=BUCKET_MINUTES))
        if finish <= start:
            finish = start + datetime.timedelta(minutes=BUCKET_MINUTES)

        for day, bucket in covered_buckets(start, finish):
            out.setdefault(day, {})[bucket] = l0_class
    return out


def coverage_fraction(
    schedule: dict[datetime.date, dict[int, str]],
    days: Sequence[datetime.date],
    n_buckets: int = BUCKETS_PER_DAY,
) -> float:
    """Fraction of buckets across *days* that any scheduled event covers."""
    if not days:
        return 0.0
    covered = sum(len(schedule.get(day, {})) for day in days)
    return covered / (len(days) * n_buckets)


class ScheduleForecaster:
    """
    Scheduled buckets from the calendar, everything else from *prior*.

    Read the class-level docstring before reading this row's score.
    """

    name = "schedule"

    def __init__(
        self,
        schedule: dict[datetime.date, dict[int, str]],
        prior,
        *,
        confidence: float = SCHEDULE_CONFIDENCE,
        name: str | None = None,
    ) -> None:
        self.schedule = schedule
        self.prior = prior
        self.confidence = confidence
        if name:
            self.name = name

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        out = np.asarray(
            self.prior.forecast(history, target_date, fit), dtype=np.float64
        ).copy()
        booked = self.schedule.get(target_date)
        if not booked:
            return out

        n_buckets = out.shape[0]
        spread = (1.0 - self.confidence) / (N_CLASSES - 1)
        for bucket, l0_class in booked.items():
            idx = CLASS_INDEX.get(l0_class)
            if idx is None or not (0 <= bucket < n_buckets):
                continue
            # Blend rather than overwrite, so the residual model still shows
            # through where the calendar and the history disagree.
            vec = np.full(N_CLASSES, spread, dtype=np.float64)
            vec[idx] = self.confidence
            out[bucket] = 0.5 * out[bucket] + 0.5 * vec
        return out / np.clip(out.sum(axis=1, keepdims=True), 1e-12, None)
