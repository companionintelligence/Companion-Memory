"""
Declared sleep, written into the token stream.

Nothing in a user's event data says "sleep". Calendar events do not, and the
wearable sources that would are rarely connected, so ``hbpe.token_stream`` ends
up with no SLEEP tokens at all while the user sleeps seven hours a night. Every
model that learns from the stream — the weekly recurrence profiles, the HMT
training set, the occupancy baselines — then learns that the small hours of the
morning are empty, and the week view paints nothing there.

The FTUE's "Time and place" step already asks when the user usually wakes and
goes to bed and stores the answers on the self-entity
(``ci.entities.properties->'schedule'``). ``pipeline/rhythm.py`` turns that
into a set of UTC buckets, per day, DST included. This module writes those
buckets into a day's token stream as SLEEP.

It is a prior, and it is written as one:

- Only buckets with **no record at all** get it. An event, a completed task or
  a summary always wins, so a night actually spent working still reads WORK.
- The soft-probability vector puts ``SLEEP_FILL_CONFIDENCE`` on SLEEP rather
  than 1.0, so anything that reads the distribution can tell a declared window
  from an observation.
- It is applied only to days that already carry at least one token. A day with
  no events is not turned into a day of sleep: an ingestion gap is not
  evidence about the night.

The L1 token matters as much as the L0 one. The weekly climate is built from
L1 tokens joined to ``hbpe.l1_clusters`` (recurrence.py), so an L0-only SLEEP
token would train the models and still leave the week view empty. The user's
static "Night Sleep" cluster is attached when one exists.
"""

from __future__ import annotations

import datetime
import logging
import time
from dataclasses import dataclass

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

log = logging.getLogger(__name__)

# Confidence in a declared window, against 1.0 for something that happened. High
# because the user typed it, below 1 because it is a routine and not a record.
SLEEP_FILL_CONFIDENCE = 0.9

# How long a loaded prior is trusted. A serializer lives for one run, so this
# only matters to a caller that keeps one around; five minutes keeps a settings
# edit from being ignored for long without a query per serialized day.
_PRIOR_TTL_SECONDS = 300.0

_SLEEP = "SLEEP"

_CLUSTER_SQL = """
    SELECT cluster_id::text
    FROM hbpe.l1_clusters
    WHERE user_id = %s AND l0_class = 'SLEEP'
    ORDER BY is_active DESC, member_count DESC, cluster_id
    LIMIT 1
"""


@dataclass(frozen=True)
class SleepPrior:
    """What is needed to fill a user's nights: the window, its zone, a cluster."""

    rhythm: dict
    tz: str | None
    cluster_id: str | None


def soft_vector() -> list[float]:
    """The 8-class soft assignment for a filled bucket."""
    others = (1.0 - SLEEP_FILL_CONFIDENCE) / (len(L0_CLASSES) - 1)
    return [SLEEP_FILL_CONFIDENCE if cls == _SLEEP else others for cls in L0_CLASSES]


def sleep_fill_records(
    records: list[dict],
    asleep_buckets: set[int],
    cluster_id: str | None,
    n_buckets: int = BUCKETS_PER_DAY,
) -> list[dict]:
    """
    New SLEEP records for every asleep bucket that *records* leaves empty.

    Returns only the additions, L0 then L1 per bucket, ordered by bucket. A
    bucket counts as occupied if it has a record at any level, so a summary
    token that carries no L0 still blocks the fill.
    """
    occupied = {r["bucket_idx"] for r in records}
    vector = soft_vector()
    added: list[dict] = []
    for bucket in sorted(asleep_buckets):
        if bucket in occupied or not 0 <= bucket < n_buckets:
            continue
        added.append(
            {
                "level": "L0",
                "token_id": _SLEEP,
                "soft_prob_vector": vector,
                "bucket_idx": bucket,
            }
        )
        if cluster_id:
            added.append(
                {
                    "level": "L1",
                    "token_id": cluster_id,
                    "soft_prob_vector": [SLEEP_FILL_CONFIDENCE],
                    "bucket_idx": bucket,
                }
            )
    return added


def load_sleep_prior(user_id: str) -> SleepPrior | None:
    """
    The user's declared sleep window, or None when there is nothing to fill.

    None covers every way of having no usable prior: onboarding skipped the
    schedule, the times do not parse, or the window is degenerate. The caller
    treats all of them identically, as "write the day as it was".
    """
    from ci.hbpe.database import get_conn
    from ci.hbpe.pipeline.rhythm import fetch_rhythm, fetch_timezone, sleep_buckets

    rhythm = fetch_rhythm(user_id)
    if not rhythm or not sleep_buckets(rhythm, BUCKETS_PER_DAY):
        return None

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_CLUSTER_SQL, (user_id,))
            row = cur.fetchone()

    return SleepPrior(
        rhythm=rhythm,
        tz=fetch_timezone(user_id),
        cluster_id=row[0] if row else None,
    )


def fill_for_day(
    records: list[dict],
    prior: SleepPrior,
    date_str: str,
) -> list[dict]:
    """The additions for one UTC calendar day, in that day's own UTC offset."""
    from ci.hbpe.pipeline.rhythm import sleep_buckets

    day = datetime.date.fromisoformat(date_str)
    asleep = sleep_buckets(prior.rhythm, BUCKETS_PER_DAY, tz=prior.tz, on=day)
    return sleep_fill_records(records, asleep, prior.cluster_id)


class PriorCache:
    """A per-user sleep prior with a short lifetime."""

    def __init__(self, ttl_seconds: float = _PRIOR_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[str, tuple[float, SleepPrior | None]] = {}

    def get(self, user_id: str) -> SleepPrior | None:
        now = time.monotonic()
        hit = self._entries.get(user_id)
        if hit is not None and now - hit[0] < self._ttl:
            return hit[1]
        try:
            prior = load_sleep_prior(user_id)
        except Exception as exc:
            # A failed read must not take serialization down, and must not be
            # cached: the next day should try again rather than inherit a blip.
            log.warning("Declared-sleep prior unavailable (non-fatal): %s", exc)
            return None
        self._entries[user_id] = (now, prior)
        return prior
