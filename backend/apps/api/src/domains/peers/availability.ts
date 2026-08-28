import type { BusyInterval } from './protocol';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The minimum an event must carry to contribute to a free/busy computation. */
export interface BusySource {
  startTime: Date;
  endTime: Date | null;
  isAllDay?: boolean | null;
}

export interface FreeBusy {
  busy: BusyInterval[];
  free: BusyInterval[];
}

/**
 * Compute free/busy over a window from the responder's events.
 *
 * DISCLOSURE CONTRACT: the output contains ONLY interval boundaries. Titles,
 * descriptions, locations, attendees, event counts and event ids never appear —
 * this function is the reason an availability ask can be auto-answered under a
 * standing grant without the owner reviewing each one. Overlapping and adjacent
 * busy blocks are MERGED, which also destroys the "how many meetings" signal.
 *
 * Rules:
 * - Events are clamped to the window; anything outside is ignored.
 * - An event with no `endTime` is treated as a point-in-time marker occupying
 *   `defaultDurationMinutes` (it still only contributes a boundary).
 * - All-day events make the whole overlapped span busy.
 * - `minMinutes` filters the returned FREE slots to those long enough to matter,
 *   so "free for lunch?" doesn't come back with a useless 5-minute gap.
 *
 * Pure.
 */
export function computeFreeBusy(
  events: readonly BusySource[],
  window: { from: Date; to: Date },
  options: { minMinutes?: number; defaultDurationMinutes?: number } = {},
): FreeBusy {
  const windowStart = window.from.getTime();
  const windowEnd = window.to.getTime();

  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    return { busy: [], free: [] };
  }

  const defaultDurationMs = (options.defaultDurationMinutes ?? 30) * 60_000;

  // 1. Project each event onto the window as a [start, end) span.
  const spans: { start: number; end: number }[] = [];
  for (const event of events) {
    const start = event.startTime?.getTime();
    if (start == null || !Number.isFinite(start)) {
      continue;
    }

    if (event.isAllDay) {
      // An all-day event blocks the entire day it starts on.
      //
      // Day boundaries are computed in UTC, NOT server-local time. `setHours`
      // would snap to whatever timezone the appliance happens to run in, so the
      // same event would produce different busy spans on two boxes — and near
      // midnight a day could be shifted far enough to mark a genuinely free
      // window as busy, or (worse) leave a busy day looking free. UTC is the
      // one frame both sides already agree on, since the ask window itself is
      // exchanged as ISO instants.
      const start = new Date(event.startTime);
      const dayStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0);
      const dayEnd = dayStart + DAY_MS;
      spans.push(clamp(dayStart, dayEnd, windowStart, windowEnd));
      continue;
    }

    const rawEnd = event.endTime?.getTime();
    const end =
      rawEnd != null && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + defaultDurationMs;

    spans.push(clamp(start, end, windowStart, windowEnd));
  }

  // 2. Drop empties, sort, and MERGE overlaps — this is what erases the
  //    per-event structure (and therefore the meeting count).
  const clipped = spans.filter((span) => span.end > span.start).sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const span of clipped) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  // 3. Invert to free gaps within the window.
  const minMs = (options.minMinutes ?? 0) * 60_000;
  const free: { start: number; end: number }[] = [];
  let cursor = windowStart;
  for (const span of merged) {
    if (span.start > cursor) {
      free.push({ start: cursor, end: span.start });
    }

    cursor = Math.max(cursor, span.end);
  }

  if (cursor < windowEnd) {
    free.push({ start: cursor, end: windowEnd });
  }

  return {
    busy: merged.map(toInterval),
    free: free.filter((slot) => slot.end - slot.start >= minMs).map(toInterval),
  };
}

/** Human summary for an availability answer — counts and durations only. */
export function summarizeAvailability(freeBusy: FreeBusy, who = 'They'): string {
  if (freeBusy.free.length === 0) {
    return `${who} have no free time in that window.`;
  }

  const longest = freeBusy.free.reduce(
    (best, slot) => {
      const duration = Date.parse(slot.end) - Date.parse(slot.start);

      return duration > best.duration ? { slot, duration } : best;
    },
    { slot: freeBusy.free[0], duration: 0 },
  );

  const minutes = Math.round(longest.duration / 60_000);
  const count = freeBusy.free.length;

  return `${who} have ${count} free slot${count === 1 ? '' : 's'} in that window (longest ${minutes} min).`;
}

function clamp(start: number, end: number, windowStart: number, windowEnd: number) {
  return { start: Math.max(start, windowStart), end: Math.min(end, windowEnd) };
}

function toInterval(span: { start: number; end: number }): BusyInterval {
  return { start: new Date(span.start).toISOString(), end: new Date(span.end).toISOString() };
}
