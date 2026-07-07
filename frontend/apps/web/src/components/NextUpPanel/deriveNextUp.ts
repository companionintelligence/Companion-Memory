import type { ForecastBucket } from '@/api/useForecastService';

import { dominantL0, MINUTES_PER_BUCKET, topL1 } from '../ForecastStrip/forecastData';

const BUCKET_MS = MINUTES_PER_BUCKET * 60_000;

/** Segments with a dominant-class probability below this floor are noise, not a plan. */
const MIN_SEGMENT_PROB = 0.15;

export interface NextUpSegment {
  /** Segment start/end instants (end is exclusive: last bucket start + 30min). */
  start: Date;
  end: Date;
  /** Dominant L0 class shared by every bucket in the segment (e.g. "WORK"). */
  l0: string;
  /** Mean probability of the dominant class across the segment's buckets. */
  meanProb: number;
  /** Highest-probability L1 context seen across the segment, if any. */
  topContext: { name: string; prob: number } | null;
}

export interface NextUpResult {
  segments: NextUpSegment[];
  /**
   * 'today' when the first segment starts on the viewer's current local day —
   * the panel reads as "next up". Otherwise 'upcoming' (the forecast window is
   * a future day, e.g. tomorrow) and the panel reads as "at a glance".
   */
  mode: 'today' | 'upcoming';
}

interface TimedBucket {
  start: Date;
  l0: string;
  prob: number;
  context: { name: string; prob: number } | null;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Distill a 48-bucket forecast into a short, chronological "what's ahead" list:
 * consecutive buckets sharing a dominant L0 class merge into one segment carrying
 * the class, its mean probability, and the strongest L1 context.
 *
 * Only buckets that end after `now` are considered, so a rest-of-day window shows
 * the remaining hours and a tomorrow window shows the whole day. Buckets with no
 * probabilities (gap fills) and UNKNOWN-dominant stretches are skipped — the panel
 * is a glanceable plan, not a coverage report.
 */
export function deriveNextUp(
  buckets: ForecastBucket[],
  now: Date = new Date(),
  { horizonHours = 8, maxSegments = 5 }: { horizonHours?: number; maxSegments?: number } = {},
): NextUpResult {
  const timed: TimedBucket[] = buckets
    .filter((b) => b.l0Probs.length > 0)
    .map((b) => {
      const start = new Date(b.startTime);

      return {
        start,
        l0: dominantL0(b.l0Probs),
        prob: Math.max(0, ...b.l0Probs.map((p) => p.probability)),
        context: topL1(b.l1Probs),
      };
    })
    .filter((b) => !Number.isNaN(b.start.getTime()))
    .filter((b) => b.start.getTime() + BUCKET_MS > now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (timed.length === 0) {
    return { segments: [], mode: 'today' };
  }

  // Only look a working-horizon ahead of the window start — "next up", not the whole day.
  const windowStart = timed[0].start.getTime();
  const horizonEnd = windowStart + horizonHours * 3_600_000;
  const inHorizon = timed.filter((b) => b.start.getTime() < horizonEnd);

  const segments: NextUpSegment[] = [];
  let current: (NextUpSegment & { probs: number[] }) | null = null;

  for (const bucket of inHorizon) {
    const contiguous =
      current != null &&
      bucket.l0 === current.l0 &&
      bucket.start.getTime() - current.end.getTime() < BUCKET_MS; // end is exclusive → equal means adjacent

    if (contiguous && current != null) {
      current.end = new Date(bucket.start.getTime() + BUCKET_MS);
      current.probs.push(bucket.prob);
      if (bucket.context && (!current.topContext || bucket.context.prob > current.topContext.prob)) {
        current.topContext = bucket.context;
      }
    } else {
      if (current) {
        segments.push(finalize(current));
      }

      current = {
        start: bucket.start,
        end: new Date(bucket.start.getTime() + BUCKET_MS),
        l0: bucket.l0,
        meanProb: 0,
        probs: [bucket.prob],
        topContext: bucket.context,
      };
    }
  }

  if (current) {
    segments.push(finalize(current));
  }

  const visible = segments
    .filter((s) => s.l0 !== 'UNKNOWN' && s.meanProb >= MIN_SEGMENT_PROB)
    .slice(0, maxSegments);

  return {
    segments: visible,
    mode: visible.length > 0 && sameLocalDay(visible[0].start, now) ? 'today' : 'upcoming',
  };
}

function finalize(segment: NextUpSegment & { probs: number[] }): NextUpSegment {
  const { probs, ...rest } = segment;

  return {
    ...rest,
    meanProb: probs.reduce((sum, p) => sum + p, 0) / probs.length,
  };
}
