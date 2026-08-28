"""
Recurrence profiler — week/month-horizon occurrence and due forecasts.

The 24h histogram (inference_engine) predicts *occupancy*: which L0/L1 class
fills each 30-min bucket.  That object dissolves at longer horizons — nobody
cares whether gym is 14:00 or 14:30 next Thursday.  The right objects are:

  week  →  *occurrence*:  P(cluster happens on day D), Bernoulli per day
  month →  *renewal*:     when is the cluster due again, given its
                          inter-arrival distribution and time-since-last

Both are derived from a per-(user, L1 cluster) statistical profile rebuilt
nightly from ``hbpe.token_stream``:

  • day-of-week occurrence counts        (the "when within a week")
  • daypart token counts                 (night/morning/afternoon/evening)
  • inter-arrival gaps in days           (the "how often")
  • periodicity_confidence ∈ [0,1]       (is this recurrent at all?)

Forecast math
-------------
Occurrence probability uses a discrete renewal process over the empirical gap
distribution.  The hazard ``h(g) = P(gap == g | gap >= g)`` — each g smoothed
with its own Beta prior, so the smoothing strength does not depend on the
largest gap ever observed — drives a small dynamic program over "days since
last occurrence", so that a possible occurrence on Tuesday correctly *resets*
the clock for Wednesday; without this, frequent clusters get badly
underestimated late in the week.

The gap distribution answers *how often*; the day-of-week histogram answers
*which day*, and it is never switched off.  It enters as a mean-1 multiplicative
lift on the hazard, so "gym every Monday" keeps pointing at Monday even when
``days_since_last`` has run past every observed gap — out there the empirical
hazard is pure prior and flat, and the lift is the only structure left.  The
result is then blended with the day-of-week base rate weighted by
``periodicity_confidence``: ad-hoc clusters fall back to "how often does this
happen on a Tuesday".

Due predictions only make sense for clusters with periodic structure
(confidence >= DUE_CONFIDENCE_MIN): due_in = median gap − days since last,
credible window from the p25/p75 gap quantiles, overdue once the p90 is
exceeded — the "deviation flag" (you usually see friends weekly; it's been
16 days).

All dates are UTC calendar days, matching token_stream serialization; clients
localize at display per the platform timezone convention.

Implements CI-Server-ci4 (profiler) and the occurrence-actuals backfill half
of CI-Server-a9w.
"""

from __future__ import annotations

import datetime
import logging
from itertools import pairwise

import numpy as np
import psycopg2.extras

from ci.hbpe.buckets import BUCKETS_PER_PART
from ci.hbpe.database import get_conn

log = logging.getLogger(__name__)

HISTORY_DAYS = 180  # profile lookback window
MIN_INTERVALS_CONF = 4  # intervals needed before confidence can exceed 0
MAX_INTERVALS_KEPT = 64  # cap stored raw gaps (most recent kept)
HAZARD_ALPHA = 0.05  # Beta prior (pseudo-counts) on each per-gap Bernoulli
DUE_CONFIDENCE_MIN = 0.5  # clusters below this get no due prediction
FORECAST_P_FLOOR = 0.01  # don't log/return occurrence probs below this
MODEL_VERSION = "recurrence-v1"

# Day-of-week smoothing. The DoW histogram is the only signal that survives once
# the renewal DP runs past the largest observed gap, so it has to be both present
# (never weighted to zero) and honest about small samples.
DOW_LIFT_PRIOR = 0.25  # per-weekday Dirichlet prior for the hazard's DoW shape
DOW_PRIOR_WEEKS = 3.0  # pseudo-weeks smoothing the DoW base rate
DOW_MIN_DAYS = 4  # occurrence days before DoW evidence counts at face value
DOW_P_MAX = 0.95  # a statistical DoW rate never reads as certainty

DAYPART_NAMES = ("night", "morning", "afternoon", "evening")

# ── Schedule reconciliation (future ci.events × recurrence) ─────────────────────
# The profiler is retrospective (statistical expectation from token_stream). The
# calendar is prospective ground truth. Reconciliation lets ground truth override
# expectation: a booked haircut is not "due", and a booked catch-up is not the
# "16 days since friends" deviation. Both forecasts join events → clusters via
# hbpe.l1_event_cluster (future events are labeled by the nightly Qwen pass just
# like past ones), so the link already exists — we just consume it here.
RECON_HORIZON_DAYS = 45  # lookahead for a booked instance in the due list
SCHED_P_CONFIRMED = 1.0  # a confirmed calendar event ≈ certain occurrence
SCHED_P_TENTATIVE = 0.9  # tentative: very likely, not certain
_WEEKDAY_IDX = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


# ── Profile building ───────────────────────────────────────────────────────────

# Distinct occurrence days (with their dayparts) per L1 cluster, restricted to
# clusters that still exist in hbpe.l1_clusters — summary-derived tokens can
# carry labels that were never promoted to clusters.
_OCCURRENCES_SQL = """
    SELECT ts.token_id::uuid AS cluster_id,
           ts.date,
           ARRAY_AGG(DISTINCT ts.bucket_idx / %(per_part)s) AS dayparts
    FROM hbpe.token_stream ts
    JOIN hbpe.l1_clusters c
      ON c.cluster_id::text = ts.token_id AND c.user_id = ts.user_id
    WHERE ts.user_id = %(user_id)s
      AND ts.level = 'L1'
      AND ts.date >= (NOW() AT TIME ZONE 'UTC')::date - %(history)s::int
      -- future-dated rows (bad imports / test data) would make days_since_last
      -- negative and poison the interval stats
      AND ts.date <= (NOW() AT TIME ZONE 'UTC')::date
    GROUP BY ts.token_id, ts.date
    ORDER BY ts.token_id, ts.date
"""

_UPSERT_PROFILE_SQL = """
    INSERT INTO hbpe.recurrence_profiles
        (user_id, l1_cluster_id, computed_at, history_days, n_occurrence_days,
         first_seen, last_seen, dow_counts, daypart_counts, intervals_days,
         interval_median, interval_p25, interval_p75, interval_p90,
         interval_mean, interval_std, periodicity_confidence)
    VALUES (%(user_id)s, %(cluster_id)s, NOW(), %(history)s, %(n_days)s,
            %(first_seen)s, %(last_seen)s, %(dow)s, %(daypart)s, %(gaps)s,
            %(median)s, %(p25)s, %(p75)s, %(p90)s, %(mean)s, %(std)s, %(conf)s)
    ON CONFLICT (user_id, l1_cluster_id) DO UPDATE SET
        computed_at            = EXCLUDED.computed_at,
        history_days           = EXCLUDED.history_days,
        n_occurrence_days      = EXCLUDED.n_occurrence_days,
        first_seen             = EXCLUDED.first_seen,
        last_seen              = EXCLUDED.last_seen,
        dow_counts             = EXCLUDED.dow_counts,
        daypart_counts         = EXCLUDED.daypart_counts,
        intervals_days         = EXCLUDED.intervals_days,
        interval_median        = EXCLUDED.interval_median,
        interval_p25           = EXCLUDED.interval_p25,
        interval_p75           = EXCLUDED.interval_p75,
        interval_p90           = EXCLUDED.interval_p90,
        interval_mean          = EXCLUDED.interval_mean,
        interval_std           = EXCLUDED.interval_std,
        periodicity_confidence = EXCLUDED.periodicity_confidence
"""


def _profile_stats(dates: list[datetime.date], daypart_lists: list[list[int]]) -> dict:
    """Compute the statistical fields of one cluster's profile row."""
    from math import exp

    from ci.hbpe.pipeline.kernel import DECAY_LAMBDA

    as_of = datetime.datetime.utcnow().date()
    dow = [0.0] * 7
    daypart = [0] * 4
    for d, parts in zip(dates, daypart_lists, strict=True):
        weight = exp(-max((as_of - d).days, 0) / DECAY_LAMBDA)
        dow[d.weekday()] += weight
        for p in parts:
            if 0 <= p < 4:
                daypart[p] += 1

    gaps = [(b - a).days for a, b in pairwise(dates)]
    gaps = gaps[-MAX_INTERVALS_KEPT:]

    stats: dict = {
        "n_days": len(dates),
        "first_seen": dates[0],
        "last_seen": dates[-1],
        "dow": [round(v * 10) for v in dow],
        "daypart": daypart,
        "gaps": gaps,
        "median": None,
        "p25": None,
        "p75": None,
        "p90": None,
        "mean": None,
        "std": None,
        "conf": 0.0,
    }
    if gaps:
        arr = np.asarray(gaps, dtype=np.float64)
        stats.update(
            median=float(np.median(arr)),
            p25=float(np.percentile(arr, 25)),
            p75=float(np.percentile(arr, 75)),
            p90=float(np.percentile(arr, 90)),
            mean=float(arr.mean()),
            std=float(arr.std()),
        )
        if len(gaps) >= MIN_INTERVALS_CONF and stats["mean"] > 0:
            # Regularity heuristic: 1 − coefficient of variation, shrunk toward 0
            # for small samples. CV≈0 (metronomic weekly habit) → ~1; bursty or
            # irregular (CV ≥ 1) → 0.
            cv = stats["std"] / stats["mean"]
            stats["conf"] = float(
                np.clip(1.0 - cv, 0.0, 1.0) * min(1.0, len(gaps) / 8.0)
            )
    return stats


def build_recurrence_profiles(user_id: str, history_days: int = HISTORY_DAYS) -> dict:
    """
    Rebuild ``hbpe.recurrence_profiles`` for *user_id* from token_stream history.

    Upserts one row per L1 cluster observed in the window and deletes profiles
    for clusters no longer observed (or deactivated).  Idempotent.

    An empty read is a no-op: "no occurrences this run" (a token_stream
    serialization gap, a misconfigured window, a partially-completed nightly)
    is not evidence that the user has no clusters, and pruning on it would wipe
    every profile — and with it every /forecast and /forecast/due answer — until
    enough history reappears.

    Returns ``{"user_id", "profiles", "periodic"}`` — total profiles written and
    how many have periodicity_confidence >= DUE_CONFIDENCE_MIN — plus
    ``"skipped": True`` when there was nothing to rebuild from.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                _OCCURRENCES_SQL,
                {
                    "user_id": user_id,
                    "history": history_days,
                    "per_part": BUCKETS_PER_PART,
                },
            )
            rows = cur.fetchall()

    # Group by cluster (rows arrive ordered by cluster, date)
    by_cluster: dict[str, tuple[list, list]] = {}
    for cluster_id, date, dayparts in rows:
        dates, parts = by_cluster.setdefault(str(cluster_id), ([], []))
        dates.append(date)
        parts.append(list(dayparts or []))

    if not by_cluster:
        # Nothing read → nothing to rebuild from, and nothing to prune against.
        log.warning(
            "recurrence profiles user=%s: no occurrences in window, "
            "leaving existing profiles untouched",
            user_id[:8],
        )
        return {"user_id": user_id, "profiles": 0, "periodic": 0, "skipped": True}

    periodic = 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            for cluster_id, (dates, parts) in by_cluster.items():
                s = _profile_stats(dates, parts)
                if s["conf"] >= DUE_CONFIDENCE_MIN:
                    periodic += 1
                cur.execute(
                    _UPSERT_PROFILE_SQL,
                    {
                        "user_id": user_id,
                        "cluster_id": cluster_id,
                        "history": history_days,
                        **s,
                    },
                )
            # Drop profiles for clusters that vanished from the window
            cur.execute(
                """DELETE FROM hbpe.recurrence_profiles
                   WHERE user_id = %s AND NOT (l1_cluster_id = ANY(%s::uuid[]))""",
                (user_id, list(by_cluster.keys())),
            )

    log.info(
        "recurrence profiles user=%s written=%d periodic=%d",
        user_id[:8],
        len(by_cluster),
        periodic,
    )
    return {"user_id": user_id, "profiles": len(by_cluster), "periodic": periodic}


# ── Forecasting ────────────────────────────────────────────────────────────────

_LOAD_PROFILES_SQL = """
    SELECT p.l1_cluster_id::text, c.label, c.l0_class,
           COALESCE(c.tier, 'anchor') AS tier,
           COALESCE(c.naming_method, 'LLM') AS naming_method,
           p.n_occurrence_days, p.first_seen, p.last_seen,
           p.dow_counts, p.daypart_counts, p.intervals_days,
           p.interval_median, p.interval_p25, p.interval_p75, p.interval_p90,
           p.periodicity_confidence
    FROM hbpe.recurrence_profiles p
    JOIN hbpe.l1_clusters c ON c.cluster_id = p.l1_cluster_id
    WHERE p.user_id = %s AND c.is_active
"""


def _load_profiles(user_id: str) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(_LOAD_PROFILES_SQL, (user_id,))
            rows = [dict(r) for r in cur.fetchall()]
    # Human-readable name from the label slug, matching
    # InferenceEngine._load_l1_display_names (display_name column was dropped
    # in 20260413000003). Ambient / junk names never become "Thursday usually".
    from ci.hbpe.tokenizer.label_quality import is_displayable_label

    visible: list[dict] = []
    for r in rows:
        label = r.pop("label") or ""
        r["display_name"] = label.replace("_", " ").title()
        if r.get("tier") == "ambient":
            continue
        if not is_displayable_label(r["display_name"]) and not is_displayable_label(
            label
        ):
            continue
        visible.append(r)
    return visible


def _hazard(gaps: list[int]) -> np.ndarray:
    """
    Smoothed discrete hazard h(g) = P(gap == g | gap >= g) for g in [1, G].

    Each h(g) is its own Bernoulli — "given the gap has reached g, does it end
    today?" — so it is smoothed with its own Beta(α, α) prior rather than with a
    Dirichlet spread over the whole tail.  That matters: a prior proportional to
    the array length would scale with max(gaps), so one 120-day vacation gap
    would swamp 25 real weekly observations and flatten the hazard.  The array
    is still sized off max(gaps) so the DP can run past the largest observed gap
    without index errors, but that length no longer touches the estimate.

    Past the observed support (at_risk == 0) the hazard is the prior mean, 0.5:
    "we have never survived this long, so we have nothing to say" — the DoW lift
    in _renewal_probs is what supplies the structure there.
    """
    G = max(gaps) * 2 + 7
    counts = np.zeros(G + 1)
    for g in gaps:
        counts[min(g, G)] += 1
    h = np.zeros(G + 1)
    for g in range(1, G + 1):
        at_risk = counts[g:].sum()
        h[g] = (counts[g] + HAZARD_ALPHA) / (at_risk + 2.0 * HAZARD_ALPHA)
    return h


def _dow_lift(dow_counts: list[int], n_days: int) -> np.ndarray:
    """
    Multiplicative day-of-week factor on the hazard, normalized to mean 1.

    A metronomic "gym every Monday" cluster puts all its mass on one weekday:
    the lift raises Monday's hazard and damps the other six.  This is what keeps
    the forecast pointed at the right day once ``days_since_last`` exceeds every
    observed gap — there the empirical hazard is flat prior, so the lift is the
    only structure left and it dominates by construction.

    Shrunk toward 1 (no weekday preference) for small samples.
    """
    counts = np.asarray(dow_counts, dtype=np.float64)
    total = float(counts.sum())
    if total <= 0 or counts.size == 0:
        return np.ones(max(counts.size, 7))
    share = (counts + DOW_LIFT_PRIOR) / (total + counts.size * DOW_LIFT_PRIOR)
    shrink = min(1.0, n_days / float(DOW_MIN_DAYS))
    return 1.0 + shrink * (counts.size * share - 1.0)


def _renewal_probs(
    gaps: list[int],
    days_since_last: int,
    horizon: int,
    day_lift: list[float] | None = None,
) -> list[float]:
    """
    P(cluster occurs on each of the next *horizon* days) via a renewal DP.

    ``days_since_last`` is the gap an occurrence on the *first* forecast day
    would complete: (first_forecast_date - last_seen).days.

    State: distribution over "days since last occurrence" at the start of each
    forecast day.  An occurrence resets the state to 1 the following day, so a
    likely Tuesday occurrence correctly feeds Wednesday's probability.

    ``day_lift`` optionally scales the hazard per forecast day (see _dow_lift),
    turning the process into a seasonal renewal: *how often* comes from the gap
    distribution, *which day* from the day-of-week histogram.
    """
    h = _hazard(gaps)
    G = len(h) - 1
    dist = np.zeros(G + 1)
    dist[min(max(days_since_last, 1), G)] = 1.0

    probs: list[float] = []
    for i in range(horizon):
        h_i = h if day_lift is None else np.clip(h * day_lift[i], 0.0, 1.0)
        p_today = float((dist * h_i).sum())
        probs.append(p_today)
        nxt = np.zeros(G + 1)
        nxt[1] = p_today  # occurred → clock resets
        survived = dist * (1.0 - h_i)  # didn't occur → gap grows
        nxt[2:] += survived[1:-1]
        nxt[G] += survived[G]  # absorb at max gap
        dist = nxt
    return probs


# ── Calendar-declared recurrence (RRULE) ───────────────────────────────────────


def _parse_until(value) -> datetime.date | None:
    """UNTIL → date. Accepts 20260101T000000Z / 20260101 / ISO / date(time)."""
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    s = str(value or "").strip().split("T", 1)[0].rstrip("Zz")
    if not s:
        return None
    try:
        if len(s) == 8 and s.isdigit():
            return datetime.date(int(s[0:4]), int(s[4:6]), int(s[6:8]))
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


def parse_recurrence(pattern) -> dict | None:
    """
    Normalize ci.events.recurrence_pattern into
    {freq, interval, byday, until, count}.

    Accepts the shapes importers emit: a structured dict
    (``{"freq": "WEEKLY", "interval": 2, "byday": ["MO", "WE"]}``) or an
    iCalendar RRULE string (``"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"``, with or
    without a leading ``"RRULE:"``). ``byday`` is returned as sorted weekday
    ints (Mon=0). Returns None for anything unparseable — callers fall back to
    the statistical estimate, so a weird pattern degrades to "no calendar hint"
    rather than an error.

    ``until``/``count`` carry the series' termination; dropping them would make
    every ended series recur forever (a standup from a job the user left still
    pinning p=1.0 cells and suppressing that cluster's overdue flag).
    """
    if not pattern:
        return None

    if isinstance(pattern, str):
        s = pattern.strip()
        if s.upper().startswith("RRULE:"):
            s = s[6:]
        parts = {
            k.upper(): v
            for k, v in (kv.split("=", 1) for kv in s.split(";") if "=" in kv)
        }
    elif isinstance(pattern, dict):
        parts = {str(k).upper(): v for k, v in pattern.items()}
    else:
        return None

    freq = str(parts.get("FREQ", "")).upper() or None
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        return None

    try:
        interval = max(int(parts.get("INTERVAL", 1) or 1), 1)
    except (TypeError, ValueError):
        interval = 1

    raw = parts.get("BYDAY", parts.get("BYWEEKDAY", []))
    if isinstance(raw, str):
        raw = [d for d in raw.split(",") if d]
    byday = sorted(
        {
            _WEEKDAY_IDX[c]
            for c in (str(d).strip().upper()[-2:] for d in (raw or []))
            if c in _WEEKDAY_IDX
        }
    )

    try:
        count = int(parts.get("COUNT") or 0) or None
    except (TypeError, ValueError):
        count = None
    if count is not None and count < 1:
        count = None

    return {
        "freq": freq,
        "interval": interval,
        "byday": byday,
        "until": _parse_until(parts.get("UNTIL")),
        "count": count,
    }


def expand_occurrences(
    rule: dict | None,
    series_start: datetime.date,
    win_start: datetime.date,
    win_end: datetime.date,
) -> list[datetime.date]:
    """
    Concrete occurrence dates of a parsed rule within [win_start, win_end].

    Day-by-day membership test over the (short) forecast window — no calendar
    arithmetic beyond weekday / day-of-month, which keeps DST and month-length
    edge cases out of a spike.

    UNTIL truncates the window; COUNT is counted from *series_start* (that is
    what RFC 5545 means), so a rule carrying one scans from the series start and
    stops at the COUNT-th occurrence — which also bounds the scan.
    """
    if not rule or win_end < win_start:
        return []
    freq, interval, byday = rule["freq"], rule["interval"], rule["byday"]
    until, count = rule.get("until"), rule.get("count")
    stop = min(win_end, until) if until else win_end
    out: list[datetime.date] = []
    # COUNT needs the occurrences already consumed before the window, so the
    # scan has to start at the series start rather than at the window.
    d = series_start if count else max(win_start, series_start)
    seen = 0
    while d <= stop:
        delta = (d - series_start).days
        hit = False
        if delta >= 0:
            if freq == "DAILY":
                hit = delta % interval == 0
            elif freq == "WEEKLY":
                weekday_ok = (
                    (d.weekday() in byday)
                    if byday
                    else (d.weekday() == series_start.weekday())
                )
                hit = weekday_ok and (delta // 7) % interval == 0
            elif freq == "MONTHLY":
                months = (d.year - series_start.year) * 12 + (
                    d.month - series_start.month
                )
                hit = d.day == series_start.day and months % interval == 0
            elif freq == "YEARLY":
                years = d.year - series_start.year
                hit = (
                    d.month == series_start.month
                    and d.day == series_start.day
                    and years % interval == 0
                )
        if hit:
            seen += 1
            if d >= win_start:
                out.append(d)
            if count and seen >= count:
                break
        d += datetime.timedelta(days=1)
    return out


def _rrule_cadence_days(rule: dict | None) -> float | None:
    """Effective inter-arrival gap (days) implied by a recurrence rule, or None."""
    if not rule:
        return None
    base = {"DAILY": 1, "WEEKLY": 7, "MONTHLY": 30, "YEARLY": 365.25}.get(rule["freq"])
    if base is None:
        return None
    if rule["freq"] == "WEEKLY" and rule["byday"]:
        # N weekdays per cycle → occurs N times per `interval` weeks
        return round(7.0 * rule["interval"] / len(rule["byday"]), 1)
    return float(base * rule["interval"])


# ── Upcoming-event loading + reconciliation ─────────────────────────────────────

# Future (or recurring) events that carry an L1 cluster assignment. Recurring
# rows are pulled regardless of start_time (their series_start is usually in the
# past); one-off rows are bounded to the lookahead window. cancelled / no_show /
# completed are excluded — a fallen-through booking must NOT suppress a due item.
_UPCOMING_EVENTS_SQL = """
    SELECT ec.cluster_id::text AS cluster_id,
           c.label, c.l0_class,
           e.start_time, e.status, e.is_recurring, e.recurrence_pattern
    FROM hbpe.l1_event_cluster ec
    JOIN ci.events e      ON e.event_id  = ec.event_id
    JOIN hbpe.l1_clusters c ON c.cluster_id = ec.cluster_id AND c.is_active
    WHERE e.user_id     = %(user_id)s
      AND e.is_deleted  = FALSE
      AND e.status IN ('confirmed', 'tentative')
      AND (
            e.is_recurring = TRUE
         OR (e.start_time >= (NOW() AT TIME ZONE 'UTC')::date
             AND e.start_time <  (NOW() AT TIME ZONE 'UTC')::date + %(horizon)s::int)
      )
"""


def _load_upcoming_events(user_id: str, horizon_days: int) -> list[dict]:
    """Rows for reconciliation: one per (labeled, active) upcoming/recurring event."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                _UPCOMING_EVENTS_SQL, {"user_id": user_id, "horizon": horizon_days}
            )
            rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["display_name"] = (r.pop("label") or "").replace("_", " ").title()
    rows.extend(_load_upcoming_tasks(user_id, horizon_days))
    return rows


def _load_upcoming_tasks(user_id: str, horizon_days: int) -> list[dict]:
    """Open/scheduled tasks with an L1 id pin occurrence; they never train."""
    sql = """
        SELECT t.l1_cluster_id::text AS cluster_id,
               c.label, c.l0_class,
               COALESCE(t.due_at, (t.scheduled_for::timestamptz)) AS start_time,
               'confirmed' AS status,
               FALSE AS is_recurring,
               NULL AS recurrence_pattern
        FROM ci.tasks t
        JOIN hbpe.l1_clusters c ON c.cluster_id = t.l1_cluster_id AND c.is_active
        WHERE t.user_id = %s::uuid
          AND t.status IN ('open', 'in_progress')
          AND t.l1_cluster_id IS NOT NULL
          AND (
                (t.due_at IS NOT NULL AND t.due_at::date >= (NOW() AT TIME ZONE 'UTC')::date
                 AND t.due_at::date < (NOW() AT TIME ZONE 'UTC')::date + %s::int)
             OR (t.scheduled_for IS NOT NULL
                 AND t.scheduled_for >= (NOW() AT TIME ZONE 'UTC')::date
                 AND t.scheduled_for < (NOW() AT TIME ZONE 'UTC')::date + %s::int)
          )
    """
    try:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (str(user_id), horizon_days, horizon_days))
                rows = [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.info("upcoming tasks skipped: %s", exc)
        return []
    for r in rows:
        r["display_name"] = (r.pop("label") or "").replace("_", " ").title()
    return rows


def _scheduled_by_cluster(
    events: list[dict], win_start: datetime.date, win_end: datetime.date
) -> dict[str, list[dict]]:
    """
    Map cluster_id → date-sorted [{date, status, name, l0_class}] of the concrete
    occurrences landing in [win_start, win_end].

    Non-recurring events contribute their own day; recurring events are expanded
    from recurrence_pattern, falling back to their single start day when the rule
    is absent/unparseable so a recurring-but-opaque event still reconciles once.
    """
    out: dict[str, list[dict]] = {}
    for e in events:
        st = e["start_time"]
        start_date = st.date() if hasattr(st, "date") else st
        if e.get("is_recurring"):
            occ = expand_occurrences(
                parse_recurrence(e.get("recurrence_pattern")),
                start_date,
                win_start,
                win_end,
            )
            if not occ and win_start <= start_date <= win_end:
                occ = [start_date]
        else:
            occ = [start_date] if win_start <= start_date <= win_end else []
        for d in occ:
            out.setdefault(e["cluster_id"], []).append(
                {
                    "date": d,
                    "status": e["status"],
                    "name": e["display_name"],
                    "l0_class": e["l0_class"],
                }
            )
    for occ in out.values():
        occ.sort(key=lambda o: o["date"])
    return out


def week_forecast(
    user_id: str,
    days: int = 7,
    start: datetime.date | None = None,
) -> list[dict]:
    """
    Per-day occurrence forecast for the next *days* days (default: starting
    tomorrow UTC — today is partially elapsed and already covered by /histogram).

    Returns one dict per day:
      {date, dow, clusters: [{cluster_id, name, l0_class, p_occur,
                              daypart_probs}, ...]}
    sorted by p_occur descending, probabilities below FORECAST_P_FLOOR dropped.
    """
    today = datetime.datetime.utcnow().date()
    start = start or (today + datetime.timedelta(days=1))
    profiles = _load_profiles(user_id)

    day_cluster_probs: list[list[dict]] = [[] for _ in range(days)]
    for p in profiles:
        gaps = list(p["intervals_days"] or [])
        n_days = int(p["n_occurrence_days"] or 0)
        if not gaps or n_days < 2:
            continue
        conf = float(p["periodicity_confidence"] or 0.0)
        since = max((start - p["last_seen"]).days, 1)

        # The day-of-week histogram feeds the forecast twice, and is never
        # switched off: as a multiplicative lift on the hazard (so the DP knows
        # *which* day, which is exactly what a metronomic weekly habit needs —
        # past its largest observed gap the lift is all that keeps the forecast
        # off a flat ~7%/day) and as the base-rate fallback below for clusters
        # whose gaps are too irregular to trust the phase.
        dow_counts = list(p["dow_counts"])
        lift = _dow_lift(dow_counts, n_days)
        day_lift = [
            float(lift[(start + datetime.timedelta(days=i)).weekday()])
            for i in range(days)
        ]
        renewal = _renewal_probs(gaps, since, days, day_lift=day_lift)

        # Day-of-week base rate: occurrences on that DoW per week observed,
        # smoothed toward the cluster's overall daily rate and discounted for
        # small samples — `c / weeks` is a rate, not a probability, and two
        # observations a week apart must not clamp to near-certainty.
        span_days = max((p["last_seen"] - p["first_seen"]).days + 1, 7)
        weeks = max(span_days / 7.0, 1.0)
        base = min(n_days / span_days, 1.0)
        evidence = min(1.0, n_days / float(DOW_MIN_DAYS))
        dow_rate = [
            evidence
            * min((c + DOW_PRIOR_WEEKS * base) / (weeks + DOW_PRIOR_WEEKS), DOW_P_MAX)
            for c in dow_counts
        ]

        dp_counts = np.asarray(p["daypart_counts"], dtype=np.float64)
        dp_total = dp_counts.sum()
        daypart_probs = (
            {
                DAYPART_NAMES[i]: round(float(v / dp_total), 3)
                for i, v in enumerate(dp_counts)
                if v > 0
            }
            if dp_total > 0
            else {}
        )

        for i in range(days):
            d = start + datetime.timedelta(days=i)
            p_occur = conf * renewal[i] + (1.0 - conf) * dow_rate[d.weekday()]
            p_occur = float(np.clip(p_occur, 0.0, 0.99))
            if p_occur >= FORECAST_P_FLOOR:
                day_cluster_probs[i].append(
                    {
                        "cluster_id": p["l1_cluster_id"],
                        "name": p["display_name"],
                        "l0_class": p["l0_class"],
                        "p_occur": round(p_occur, 4),
                        "daypart_probs": daypart_probs,
                        "scheduled": False,
                    }
                )

    # Layer 2 — overlay booked calendar events as near-certain occurrences. A
    # confirmed event pins its cell to ~1.0 and flags it `scheduled`; a
    # calendar-only cluster with no statistical profile still appears.
    upcoming = _load_upcoming_events(user_id, days + 2)
    scheduled = _scheduled_by_cluster(
        upcoming, start, start + datetime.timedelta(days=days - 1)
    )
    for i in range(days):
        d = start + datetime.timedelta(days=i)
        by_cid = {c["cluster_id"]: c for c in day_cluster_probs[i]}
        for cid, occs in scheduled.items():
            match = next((o for o in occs if o["date"] == d), None)
            if not match:
                continue
            sched_p = (
                SCHED_P_CONFIRMED
                if match["status"] == "confirmed"
                else SCHED_P_TENTATIVE
            )
            cell = by_cid.get(cid)
            if cell:
                cell["p_occur"] = max(cell["p_occur"], sched_p)
                cell["scheduled"] = True
            else:
                day_cluster_probs[i].append(
                    {
                        "cluster_id": cid,
                        "name": match["name"],
                        "l0_class": match["l0_class"],
                        "p_occur": sched_p,
                        "daypart_probs": {},
                        "scheduled": True,
                    }
                )

    out = []
    for i in range(days):
        d = start + datetime.timedelta(days=i)
        out.append(
            {
                "date": d.isoformat(),
                "dow": d.strftime("%A"),
                "clusters": sorted(
                    day_cluster_probs[i], key=lambda c: c["p_occur"], reverse=True
                ),
            }
        )
    return out


def due_list(user_id: str) -> list[dict]:
    """
    Renewal ("due") predictions for periodic clusters.

    Returns, for each cluster with periodicity_confidence >= DUE_CONFIDENCE_MIN
    and >= 3 observed intervals:
      {cluster_id, name, l0_class, last_seen, days_since_last,
       median_interval_days, due_in_days, window: [lo, hi], overdue, confidence}

    ``due_in_days`` may be negative (past the median but not yet past p90);
    ``overdue`` flips once days_since_last exceeds the p90 gap — the deviation
    signal ("you usually do this every ~7 days; it's been 16").

    Reconciliation (Layer 1): a cluster with a matching confirmed/tentative
    event in the lookahead window is annotated with ``scheduled_date`` and
    never flagged overdue — a booked catch-up is handled, not neglected.

    Calendar-declared recurrence (Layer 3): a cluster that lacks the ≥3
    statistical intervals but carries an RRULE (weekly standup, monthly rent)
    still gets a due prediction, using the RRULE cadence as its interval.
    Sorted: overdue first, then soonest due.
    """
    today = datetime.datetime.utcnow().date()
    win_end = today + datetime.timedelta(days=RECON_HORIZON_DAYS)
    upcoming = _load_upcoming_events(user_id, RECON_HORIZON_DAYS)
    scheduled = _scheduled_by_cluster(upcoming, today, win_end)

    # Shortest RRULE-implied cadence per cluster (Layer 3 seeding source).
    cadence: dict[str, float] = {}
    for e in upcoming:
        if not e.get("is_recurring"):
            continue
        rule = parse_recurrence(e.get("recurrence_pattern"))
        if rule and rule.get("until") and rule["until"] < today:
            continue  # series already ended — no cadence
        c = _rrule_cadence_days(rule)
        if c and c < cadence.get(e["cluster_id"], float("inf")):
            cadence[e["cluster_id"]] = c

    out = []
    for p in _load_profiles(user_id):
        cid = p["l1_cluster_id"]
        conf = float(p["periodicity_confidence"] or 0.0)
        gaps = list(p["intervals_days"] or [])
        calendar_recurring = cid in cadence

        periodic = conf >= DUE_CONFIDENCE_MIN and len(gaps) >= 3
        # Layer 3: accept a calendar-recurring cluster with even one observed gap
        # (we still need last_seen from the profile to know how overdue it is).
        if not periodic and not (calendar_recurring and len(gaps) >= 1):
            continue

        since = (today - p["last_seen"]).days
        if periodic:
            median = float(p["interval_median"])
            p25, p75, p90 = (
                float(p["interval_p25"]),
                float(p["interval_p75"]),
                float(p["interval_p90"]),
            )
        else:
            # RRULE cadence has no empirical spread — keep the window tight and
            # push the overdue threshold out by half a cycle.
            median = cadence[cid]
            p25, p75, p90 = median, median, median * 1.5

        occ = scheduled.get(cid)
        scheduled_date = occ[0]["date"].isoformat() if occ else None
        out.append(
            {
                "cluster_id": cid,
                "name": p["display_name"],
                "l0_class": p["l0_class"],
                "last_seen": p["last_seen"].isoformat(),
                "days_since_last": since,
                "median_interval_days": round(median, 1),
                "due_in_days": round(median - since, 1),
                "window": [round(p25 - since, 1), round(p75 - since, 1)],
                "overdue": since > p90 and scheduled_date is None,
                "scheduled_date": scheduled_date,
                "confidence": round(
                    max(conf, DUE_CONFIDENCE_MIN if calendar_recurring else conf), 3
                ),
            }
        )
    return sorted(out, key=lambda r: (not r["overdue"], r["due_in_days"]))


# ── Occurrence forecast logging + actuals backfill ─────────────────────────────

_INSERT_OCCURRENCE_SQL = """
    INSERT INTO hbpe.occurrence_log
        (user_id, predicted_at, target_date, l1_cluster_id, p_occur, model_version)
    VALUES (%s, %s, %s, %s, %s, %s)
    ON CONFLICT (
        user_id,
        target_date,
        l1_cluster_id,
        ((predicted_at AT TIME ZONE 'UTC')::date)
    ) DO NOTHING
"""


def log_occurrence_forecast(
    user_id: str,
    forecast: list[dict],
    predicted_at: datetime.datetime,
) -> None:
    """
    Write an issued week forecast to hbpe.occurrence_log for retrospective
    Brier scoring.  Non-fatal, mirroring histogram_api._log_prediction.
    """
    rows = [
        (
            user_id,
            predicted_at,
            day["date"],
            c["cluster_id"],
            c["p_occur"],
            MODEL_VERSION,
        )
        for day in forecast
        for c in day["clusters"]
    ]
    if not rows:
        return
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                psycopg2.extras.execute_batch(cur, _INSERT_OCCURRENCE_SQL, rows)
        log.debug("Logged %d occurrence forecasts for user=%s", len(rows), user_id[:8])
    except Exception:
        log.exception("occurrence_log write failed (non-fatal)")


# actual = TRUE/FALSE only when the elapsed day has *any* token_stream coverage —
# a day with no rows means "no data", not "didn't happen", and stays NULL.
_BACKFILL_OCCURRENCE_SQL = """
    UPDATE hbpe.occurrence_log o
    SET actual = EXISTS (
        SELECT 1 FROM hbpe.token_stream ts
        WHERE ts.user_id = o.user_id
          AND ts.date = o.target_date
          AND ts.level = 'L1'
          AND ts.token_id = o.l1_cluster_id::text
    )
    WHERE o.user_id = %(user_id)s
      AND o.actual IS NULL
      AND o.target_date < (NOW() AT TIME ZONE 'UTC')::date
      AND o.target_date >= (NOW() AT TIME ZONE 'UTC')::date - %(lookback)s::int
      AND EXISTS (
        SELECT 1 FROM hbpe.token_stream ts
        WHERE ts.user_id = o.user_id AND ts.date = o.target_date
      )
"""


def backfill_occurrence_actuals(user_id: str, lookback_days: int = 14) -> dict:
    """
    Fill hbpe.occurrence_log.actual for elapsed target days from observed
    token_stream L1 presence.  Idempotent (only touches NULL rows).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                _BACKFILL_OCCURRENCE_SQL,
                {"user_id": user_id, "lookback": lookback_days},
            )
            updated = cur.rowcount or 0
            cur.execute(
                "DELETE FROM hbpe.occurrence_log WHERE predicted_at < NOW() - INTERVAL '90 days'"
            )
            pruned = cur.rowcount or 0
    log.info(
        "occurrence actuals user=%s updated=%d pruned=%d",
        user_id[:8],
        updated,
        pruned,
    )
    return {"user_id": user_id, "updated": updated, "pruned": pruned}
