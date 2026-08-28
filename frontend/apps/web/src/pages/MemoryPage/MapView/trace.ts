/**
 * Set-level arithmetic on the location trace — the `ci.position` layer the map
 * draws underneath its event pins.
 *
 * Pure and DOM-free for the same reason `pinSet.ts` is: these decide what the
 * user is told they are looking at (how coarse the trace is, which points are
 * really connected), and every one of them is cheap to get subtly wrong.
 */

/** Minimum a trace point has to carry to be drawn, weighted or connected. */
export interface TracePoint {
  latitude: number;
  longitude: number;
  /** ISO instant of the point's first fix. */
  startTime: string;
  /** ISO instant of the point's last fix (equal to startTime for a raw fix). */
  endTime: string;
  /** Fixes this point stands for — 1 when raw, the bucket's weight when downsampled. */
  fixCount: number;
}

/**
 * How far apart two consecutive points may be in time and still be joined by a
 * line.
 *
 * Without a break rule the polyline is a lie: this history has a fix in Chicago
 * in May 2013 and its next one in Los Angeles in April 2016, and connecting
 * them draws a three-year "journey" that never happened. Three days is wider
 * than any gap inside a genuinely continuous stretch of tracking and far
 * narrower than the multi-month holes between the early scattered fixes.
 */
export const TRACE_GAP_MS = 3 * 24 * 60 * 60 * 1000;

/** A drawable polyline: consecutive [lat, lng] pairs. */
export type TraceSegment = Array<[number, number]>;

/**
 * Split a time-ordered trace into the stretches that are actually continuous.
 *
 * Points are compared END of one against START of the next, because a
 * downsampled point spans a whole bucket: comparing starts would call two
 * adjacent 2.4-day buckets a 2.4-day gap and shatter a continuous trace into
 * single points.
 *
 * Single-point stretches are dropped — a polyline of one draws nothing — but
 * the caller still renders every point as a dot, so no location is lost.
 */
export function traceSegments(points: TracePoint[], maxGapMs: number = TRACE_GAP_MS): TraceSegment[] {
  const segments: TraceSegment[] = [];
  let current: TraceSegment = [];
  let previousEnd: number | null = null;

  for (const point of points) {
    const start = Date.parse(point.startTime);
    const end = Date.parse(point.endTime);

    if (isNaN(start) || isNaN(end)) {
      continue;
    }

    if (previousEnd != null && start - previousEnd > maxGapMs) {
      if (current.length > 1) {
        segments.push(current);
      }

      current = [];
    }

    current.push([point.latitude, point.longitude]);
    previousEnd = end;
  }

  if (current.length > 1) {
    segments.push(current);
  }

  return segments;
}

/**
 * Dot radius in pixels for a point standing for `fixCount` fixes.
 *
 * Logarithmic, not linear: the weights on a real history span four orders of
 * magnitude (one fix in a quiet bucket, thousands in a bucket spent at home),
 * and a linear scale would render everything but home as an invisible speck.
 */
export function traceRadius(fixCount: number): number {
  const weight = Math.max(fixCount, 1);

  return Math.min(2 + Math.log10(weight) * 2.5, 9);
}

/**
 * How the trace describes itself in the map's status line.
 *
 * Never claims to be showing more than it is: when the server downsampled, the
 * count of points on screen and the count of fixes they stand for are different
 * numbers and the user is told both.
 */
export function describeTrace({
  points,
  totalFixes,
  bucketSeconds,
  hasMore,
}: {
  points: number;
  totalFixes: number | null;
  bucketSeconds: number | null;
  hasMore: boolean;
}): string {
  if (points === 0) {
    return 'No location history here';
  }

  const shown = `${points.toLocaleString()} ${points === 1 ? 'point' : 'points'}`;

  if (bucketSeconds == null) {
    const suffix =
      hasMore && totalFixes != null ? ` of ${totalFixes.toLocaleString()} fixes` : ' (every fix)';

    return `${shown}${suffix}`;
  }

  const from = totalFixes != null ? ` from ${totalFixes.toLocaleString()} fixes` : '';

  // NOT "averaged" — the server's `first(..., time)` picks one real fix per
  // bucket rather than averaging them, precisely so a bucket spanning a
  // flight lands on a real point and not an average position in the ocean.
  // The copy has to say what the number actually is: a real fix sampled every
  // so often, not a synthetic mean.
  return `${shown}${from}, sampled every ${formatBucket(bucketSeconds)}`;
}

/** A bucket width as the coarsest unit that still reads as a round number. */
function formatBucket(seconds: number): string {
  const units: Array<[number, string]> = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];

  for (const [size, name] of units) {
    if (seconds >= size) {
      const value = Math.round((seconds / size) * 10) / 10;

      return `${value} ${value === 1 ? name : `${name}s`}`;
    }
  }

  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}
