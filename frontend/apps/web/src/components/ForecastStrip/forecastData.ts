import type { ForecastBucket, ProbabilityEntry } from '@/api/useForecastService';

// ── Constants ─────────────────────────────────────────────────────────────────

export const N_BUCKETS = 48;
export const MINUTES_PER_BUCKET = 30;
export const MINUTES_PER_DAY = 24 * 60;

// ── Colour mapping ────────────────────────────────────────────────────────────

export const L0_BG: Record<string, string> = {
  WORK: 'bg-blue-500',
  EXERCISE: 'bg-green-500',
  SOCIAL: 'bg-orange-500',
  ERRAND: 'bg-yellow-500',
  LEISURE: 'bg-purple-500',
  TRANSIT: 'bg-teal-500',
  SLEEP: 'bg-indigo-500',
  UNKNOWN: 'bg-gray-400',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Local minutes-since-midnight for an ISO instant, or null if empty/unparseable. */
export function localMinutesOfDay(iso: string): number | null {
  if (!iso) {
    return null;
  }

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.getHours() * 60 + d.getMinutes();
}

/** Format minutes-since-local-midnight as a clock label (e.g. 510 → "8:30 AM"). */
export function formatClock(minutesOfDay: number): string {
  const m = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  // Date constructor normalises overflow: 1440 → Jan 2 midnight → "12:00 AM"
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Always returns exactly N_BUCKETS entries sorted 0–47, filling gaps with neutral defaults. */
export function normalizeBuckets(raw: ForecastBucket[]): ForecastBucket[] {
  const byIndex = new Map(raw.map((b) => [b.bucketIndex, b]));

  return Array.from(
    { length: N_BUCKETS },
    (_, i) =>
      byIndex.get(i) ?? {
        bucketIndex: i,
        startTime: '',
        l0Probs: [],
        l1Probs: [],
        l2Probs: null,
        q10: 0,
        q50: 0,
        q90: 0,
      },
  );
}

/**
 * Order the 48 buckets so the strip reads local midnight → 23:30, labeling each by its
 * real instant in the viewer's local time.
 *
 * HBPE bins behaviour by UTC time-of-day, so bucket N describes the UTC half-hour N — but
 * each bucket carries its real `startTime` instant. We derive the viewer's UTC→local
 * offset from the first bucket with a valid instant, apply it to every bucket (so gap-
 * filled buckets sort correctly too), then order into a local day. Timezone handling stays
 * purely at display: no server-side re-bucketing, and it tracks the browser clock (incl.
 * DST) automatically. With no valid instants (non-READY placeholder), offset is 0 and the
 * strip falls back to index order (00:00 → 23:30).
 */
export function orderLocalDay(raw: ForecastBucket[]): { bucket: ForecastBucket; localMin: number }[] {
  const pinned = normalizeBuckets(raw);

  let offsetMin = 0;
  for (const bucket of pinned) {
    const lm = localMinutesOfDay(bucket.startTime);
    if (lm != null) {
      offsetMin =
        (((lm - bucket.bucketIndex * MINUTES_PER_BUCKET) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
        MINUTES_PER_DAY;
      break;
    }
  }

  return pinned
    .map((bucket) => ({
      bucket,
      localMin: (bucket.bucketIndex * MINUTES_PER_BUCKET + offsetMin) % MINUTES_PER_DAY,
    }))
    .sort((a, b) => a.localMin - b.localMin);
}

export function dominantL0(probs: ProbabilityEntry[]): string {
  return probs.reduce(
    (best, { label, probability }) => (probability > best.probability ? { label, probability } : best),
    { label: 'UNKNOWN', probability: -1 },
  ).label;
}

export function topL1(probs: ProbabilityEntry[]): { name: string; prob: number } | null {
  if (!probs.length) {
    return null;
  }

  const top = probs.reduce((best, cur) => (cur.probability > best.probability ? cur : best));

  return { name: top.label, prob: top.probability };
}
