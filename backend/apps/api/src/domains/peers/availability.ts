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

/**
 * The granularity a `redacted` availability answer is coarsened to.
 *
 * Thirty minutes rather than sixty: an hour-aligned quantization that shrinks
 * INWARD (see {@link coarsenFreeBusy}) destroys most real gaps outright — a
 * 14:07–15:53 slot spans only the 15:00 boundary, so both edges land on 15:00
 * and a genuine 106-minute opening disappears. That is safe in the disclosure
 * direction and useless in the product direction, which would retire FR4
 * ("are you free the weekend of the 21st?") rather than bound it.
 *
 * Thirty minutes rather than five: the point is to stop handing over the
 * INSTANTS a meeting started and ended at, which is the presence signal T2 is
 * about. A five-minute grid still reports them.
 *
 * This bounds PRECISION, not FREQUENCY. A peer who asks every minute for a
 * month still accumulates a detailed picture from coarse answers; that is a
 * cumulative-disclosure problem and it belongs to the budget work (#2364), not
 * to a rung.
 */
export const REDACTED_SLOT_GRANULARITY_MINUTES = 30;

/**
 * Coarsen a free/busy result for the `redacted` rung.
 *
 * ═══ WHY THIS EXISTS: `redacted` USED TO CLAMP NOTHING ═══
 *
 * `clampAvailability` read `case 'full': case 'redacted':` and returned the
 * intervals as computed for both. But `redacted` sits BELOW `full` on the
 * ladder, and it is where the `trusted` tier's ceiling lands — so a `trusted`
 * peer received the owner's real calendar boundaries, auto-answered under a
 * standing grant, exactly as if no ceiling applied at all.
 *
 * That is the defect logged as D2 in docs/asks-threat-model.md, and it is the
 * same one `applyDisclosureCeiling` fixed for item references with the argument
 * that a rung which clamps nothing is not a rung, it is a label the owner can
 * pick believing it does something. The argument was never ported to this,
 * the third clamp in the codebase.
 *
 * ═══ WHAT `redacted` MEANS FOR A CALENDAR ═══
 *
 * Elsewhere `redacted` is "the references the owner kept, and nothing about the
 * rest". Availability has no per-item redaction to inherit — nothing is picked
 * over — so the analogue is the coarse SHAPE of the owner's availability rather
 * than their actual schedule:
 *
 *   - `busy` is dropped entirely. Busy boundaries are the direct answer to
 *     "when does this person have meetings", which is the one thing a ceiling
 *     below `full` must stop. Nothing needs them: an asker schedules against
 *     free time.
 *   - `free` survives, quantized to {@link REDACTED_SLOT_GRANULARITY_MINUTES}.
 *
 * ═══ QUANTIZATION SHRINKS, NEVER GROWS ═══
 *
 * The start rounds UP and the end rounds DOWN, so a coarsened slot is always a
 * SUBSET of a real one. Rounding outward would be the disclosure-safe direction
 * for boundaries but the wrong direction for truth: it would tell an asker the
 * owner is free at a time they are in a meeting, and an availability answer
 * that can be wrong in that direction is worse than one that is merely coarse.
 *
 * A slot too short to survive is DROPPED rather than widened. It discloses
 * strictly less, which is the safe direction, and the summary is recomputed
 * from the surviving set so the sentence cannot state a count the arrays
 * contradict.
 *
 * Pure.
 */
export function coarsenFreeBusy(
  freeBusy: FreeBusy,
  granularityMinutes: number = REDACTED_SLOT_GRANULARITY_MINUTES,
): FreeBusy {
  const step = Math.max(1, Math.round(granularityMinutes)) * 60_000;

  const free: BusyInterval[] = [];

  for (const slot of freeBusy.free) {
    const start = Date.parse(slot.start);
    const end = Date.parse(slot.end);

    // An unparseable boundary is dropped, not passed through. This function's
    // whole job is to narrow, and a value it cannot reason about is the one
    // case where forwarding the original would defeat that.
    if (Number.isNaN(start) || Number.isNaN(end)) {
      continue;
    }

    const coarseStart = Math.ceil(start / step) * step;
    const coarseEnd = Math.floor(end / step) * step;

    if (coarseEnd <= coarseStart) {
      continue;
    }

    free.push({
      start: new Date(coarseStart).toISOString(),
      end: new Date(coarseEnd).toISOString(),
    });
  }

  return { busy: [], free };
}
