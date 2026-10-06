"""
The daily rhythm the user typed into onboarding, as a densification prior.

``corpus.densify`` fills unobserved buckets with a single filler class, which
made 97.5% of a densified corpus one meaningless label. But the user has
already *told* us what most of that time is. The FTUE's "Time and place" step
(``frontend/apps/web/src/pages/OnboardingPage/TimeAndPlaceStep.tsx``) asks when
they usually wake, go to bed, and start and end work, and stores the answers on
the self-entity:

    ci.entities.properties->'schedule'
        {"wake_time": "09:00", "sleep_time": "02:00",
         "work_start": "10:00", "work_end": "18:00", "source": "onboarding"}

Nothing under ``ci.hbpe`` reads it. For a corpus whose SLEEP class has zero
support while the user sleeps seven hours a night, that is the cheapest real
signal available: the sleep window alone accounts for ~29% of the day here and
is currently labelled "nothing recorded".

⚠ The declared times are **local**; ``hbpe.token_stream`` buckets are **UTC**.
``data_client`` derives a bucket with ``date_trunc('day', e.start_time)`` on a
timestamptz in a UTC session, and nothing anywhere localizes it. A user in
America/New_York who says they sleep 02:00–09:00 must therefore have SLEEP
written to buckets 06:00–13:00 UTC, and applying the clock times directly puts
the whole window four hours early. Conversion is per-day because the offset
moves with DST, and a corpus spanning years crosses it repeatedly.

This is a *declared* rhythm, not an observed one. It is a prior over
unobserved buckets and nothing more: an actual token always wins, so a night
spent working still reads as WORK. Treating it as ground truth would be
fabricating observations. Treating it as a default is what the user was asked
for.

The work window is deliberately **not** applied. Work is the class the corpus
already observes densely through the calendar, so defaulting to it would
manufacture agreement between the prior and the labels it is being scored
against, which is the same circularity ``schedule.py`` warns about. Sleep is
the class nothing else supplies.
"""

from __future__ import annotations

import datetime
from collections.abc import Callable, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.pipeline.baselines import _as_date
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

_L0_SET = frozenset(L0_CLASSES)

# Default filler for ``densify``. The L0 taxonomy has no "nothing recorded"
# member, and adding one would change N_CLASSES and every array shape scoring
# depends on, so the densified corpus borrows UNKNOWN. That is a proxy, not a
# synonym: UNKNOWN already means "the labeler could not tell from the title",
# and after densifying it also means "no event covered this bucket". The two
# are indistinguishable afterwards, so UNKNOWN's per-class recall is not
# interpretable on a densified run. Every other class stays clean.
DEFAULT_BACKGROUND = "UNKNOWN"

_TIMEZONE_SQL = "SELECT timezone FROM ci.users WHERE id = %s"

_PROFILE_SQL = """
    SELECT properties -> 'schedule'
    FROM ci.entities
    WHERE owner_user_id = %s
      AND is_self IS TRUE
      AND properties -> 'schedule' IS NOT NULL
    LIMIT 1
"""


def fetch_rhythm(user_id: str) -> dict | None:
    """The self-entity's declared schedule, or None when onboarding skipped it."""
    from ci.hbpe.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_PROFILE_SQL, (user_id,))
            row = cur.fetchone()
    return row[0] if row and row[0] else None


def fetch_timezone(user_id: str) -> str | None:
    """The user's IANA timezone, or None when unset."""
    from ci.hbpe.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_TIMEZONE_SQL, (user_id,))
            row = cur.fetchone()
    return row[0] if row and row[0] else None


def _utc_offset_minutes(tz: str | None, on: datetime.date | None) -> int:
    """
    Minutes east of UTC for *tz* on *on*, or 0 when it cannot be determined.

    Resolved per-day so a corpus spanning a DST boundary shifts with it rather
    than being an hour out for half the year.
    """
    if not tz:
        return 0
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return 0
    when = datetime.datetime.combine(
        on or datetime.date.today(), datetime.time(12, 0), tzinfo=zone
    )
    offset = when.utcoffset()
    return int(offset.total_seconds() // 60) if offset else 0


def _bucket_of(clock: str, n_buckets: int = BUCKETS_PER_DAY) -> int | None:
    """``"09:15"`` → bucket index under *n_buckets*. None when unparseable."""
    try:
        parsed = datetime.time.fromisoformat(clock.strip())
    except (AttributeError, ValueError):
        return None
    if n_buckets < 1:
        return None
    minutes = (24 * 60) // n_buckets
    if minutes < 1:
        return None
    bucket = (parsed.hour * 60 + parsed.minute) // minutes
    if bucket >= n_buckets:
        bucket = n_buckets - 1
    return bucket


def sleep_buckets(
    rhythm: dict | None,
    n_buckets: int = BUCKETS_PER_DAY,
    *,
    tz: str | None = None,
    on: datetime.date | None = None,
) -> set[int]:
    """
    Bucket indices covered by the declared sleep window, ``[sleep, wake)``.

    Wraps midnight when bedtime is later in the clock than wake time, which is
    the common case (22:00 → 07:00). It does not wrap when it need not: this
    user's 02:00 → 09:00 is a single contiguous run inside one day.

    An empty set when the window is missing, unparseable, or degenerate, so a
    caller can fall back to a flat filler without special-casing.
    """
    if not rhythm:
        return set()
    start = _bucket_of(str(rhythm.get("sleep_time") or ""), n_buckets)
    end = _bucket_of(str(rhythm.get("wake_time") or ""), n_buckets)
    if start is None or end is None or start == end:
        return set()

    # Declared local → stored UTC. Shifting both ends by the same offset keeps
    # the window's length intact and lets it wrap naturally.
    shift = _utc_offset_minutes(tz, on) // (24 * 60 // n_buckets)
    if shift:
        start = (start - shift) % n_buckets
        end = (end - shift) % n_buckets
        if start == end:
            return set()
    if start < end:
        return set(range(start, end))
    return set(range(start, n_buckets)) | set(range(0, end))


def background_by_bucket(
    rhythm: dict | None,
    filler: str,
    n_buckets: int = BUCKETS_PER_DAY,
    *,
    tz: str | None = None,
    on: datetime.date | None = None,
) -> list[str]:
    """Per-bucket default class: SLEEP inside the declared window, else *filler*."""
    asleep = sleep_buckets(rhythm, n_buckets, tz=tz, on=on)
    return ["SLEEP" if b in asleep else filler for b in range(n_buckets)]


def background_factory(
    rhythm: dict | None,
    filler: str,
    n_buckets: int = BUCKETS_PER_DAY,
    *,
    tz: str | None = None,
) -> Callable[[datetime.date], list[str]]:
    """
    A per-day background builder, memoised on UTC offset.

    ``densify`` needs one row of defaults per day rather than one for the whole
    corpus, because the local→UTC shift moves across a DST boundary. Only two
    distinct offsets ever occur for a zone, so the results are cached on the
    offset rather than recomputed per day.
    """
    cache: dict[int, list[str]] = {}

    def build(day: datetime.date) -> list[str]:
        offset = _utc_offset_minutes(tz, day)
        if offset not in cache:
            cache[offset] = background_by_bucket(
                rhythm, filler, n_buckets, tz=tz, on=day
            )
        return cache[offset]

    return build


def densify(
    rows: Sequence[dict],
    background: str | Sequence[str] | Callable[[datetime.date], Sequence[str]] = (
        DEFAULT_BACKGROUND
    ),
    n_buckets: int = BUCKETS_PER_DAY,
) -> list[dict]:
    """
    Give every bucket of every observed day a label, filling gaps with
    *background*.

    The sparse corpus asks "given that something was recorded here, which class
    was it?" — only observed buckets carry a target, so on a corpus at 2.6%
    occupancy a forecaster is fit and scored on a handful of points per day and
    is never asked what happens during the other 97%. That is not the question
    a next-day forecast has to answer.

    Densifying asks "what is happening in this bucket?" for all
    ``n_buckets`` of them, which is the deployable question, and takes the
    corpus from hundreds of labelled points to tens of thousands.

    Only days already present in *rows* are filled. A day absent from the token
    stream stays absent rather than becoming a fabricated day of background:
    ingestion gaps are not evidence that nothing happened.

    The filler is applied to history and actuals alike, because they are the
    same rows. Densifying actuals alone would score every forecaster against a
    class none of them had ever been fit on.

    *background* is either one class for every bucket, a per-bucket sequence of
    length *n_buckets*, or a callable returning that sequence for a given day.
    A callable is checked the same way as a fixed sequence: the wrong length or
    a class outside the L0 taxonomy raises ``ValueError`` instead of being
    written into the corpus. The sequence form is how a declared daily rhythm
    enters the corpus — see ``rhythm.background_by_bucket``, which marks the
    user's stated sleep window SLEEP and leaves the rest flat. An observed
    token always beats the filler, so a night actually spent working still
    reads WORK.
    """

    def _checked(raw: Sequence[str]) -> list[str]:
        fixed = list(raw)
        if len(fixed) != n_buckets:
            raise ValueError(
                f"background has {len(fixed)} entries, expected {n_buckets}"
            )
        unknown = sorted({c for c in fixed if c not in _L0_SET})
        if unknown:
            raise ValueError(f"background {unknown[0]!r} is not an L0 class")
        return fixed

    if callable(background):

        def per_day(day: datetime.date, _background=background) -> list[str]:
            return _checked(_background(day))

    else:
        if isinstance(background, str):
            fixed = _checked([background] * n_buckets)
        else:
            fixed = _checked(background)

        def per_day(_day: datetime.date, _fixed=fixed) -> list[str]:
            return _fixed

    seen: dict[datetime.date, set[int]] = {}
    out: list[dict] = []
    for row in rows:
        day = _as_date(row["date"])
        seen.setdefault(day, set())
        out.append(row)
        token = str(row.get("token_id") or "")
        if token not in _L0_SET:
            continue
        bucket = int(row["bucket_idx"])
        if 0 <= bucket < n_buckets:
            seen[day].add(bucket)

    for day, occupied in seen.items():
        defaults = per_day(day)
        for bucket in range(n_buckets):
            if bucket in occupied:
                continue
            out.append(
                {"date": day, "bucket_idx": bucket, "token_id": defaults[bucket]}
            )

    out.sort(key=lambda r: (_as_date(r["date"]), int(r["bucket_idx"])))
    return out
