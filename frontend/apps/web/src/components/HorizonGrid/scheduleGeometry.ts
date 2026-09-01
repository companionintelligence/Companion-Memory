/**
 * Shared schedule geometry — the maths behind the schedule surface.
 *
 * Clipping events onto a day, resolving a pointer ratio to an instant, and
 * folding HBPE's dayparts into 15-minute rhythm cells all used to live inside
 * `HorizonGrid`, which is gone (#2308: Calendar and Horizon are one view now).
 * They are kept apart from {@link VerticalCalendar} because they are pure
 * date/geometry functions with no React in them — that is what lets them be
 * tested directly rather than through a rendered grid.
 */

import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';
import { type ActivityClass, normalizeClass } from '@/lib/activityPalette';
import { weekClusterVisible } from '@/lib/forecastDisplay';

import { addDays, sameLocalDay } from './nowNext';
import { packItemLanes, type EventSpan } from './scheduleClusters';

// ── Constants ─────────────────────────────────────────────────────────────────

const MINUTES_PER_DAY = 24 * 60;
/** Matches `ci.hbpe.buckets.BUCKET_MINUTES` — occupancy and the calendar strip share this grain. */
const BUCKET_MINUTES = 15;
const BUCKETS_PER_DAY = MINUTES_PER_DAY / BUCKET_MINUTES;

/**
 * HBPE bins behaviour into four 6-hour dayparts anchored at UTC midnight
 * (recurrence.py: BUCKETS_PER_PART = 24). Cells are resolved per local 15-minute
 * slot by looking up the UTC instant that slot actually falls in, so a viewer
 * far from UTC sees their real rhythm rather than a label that assumes
 * "morning" means their morning.
 */
const DAYPART_HOURS = 6;
const DAYPART_NAMES = ['night', 'morning', 'afternoon', 'evening'] as const;

type DaypartName = (typeof DAYPART_NAMES)[number];

/** Below this weight, a rhythm cell is noise rather than signal — leave it blank. */
const RHYTHM_NOISE_FLOOR = 0.05;

/**
 * Ink range for a rhythm cell. The floor keeps a weak-but-real pattern visible;
 * the ceiling keeps the layer ambient so it never competes with committed time.
 * Weight maps linearly across the range rather than being clamped, so a 0.9 cell
 * still reads darker than a 0.6 one.
 */
const MIN_CELL_INK = 0.14;
const MAX_CELL_INK = 0.85;

function cellOpacity(intensity: number): number {
  return MIN_CELL_INK + (MAX_CELL_INK - MIN_CELL_INK) * Math.min(intensity, 1);
}

/**
 * Dropping snaps to this grain. Finer would imply a precision the suggestion
 * does not have; coarser would fight the user placing something after lunch.
 */
const DROP_SNAP_MINUTES = 15;

// ── Instants ──────────────────────────────────────────────────────────────────

/**
 * The instant `minutes` of WALL CLOCK into the day `dayStart` opens.
 *
 * Deliberately not `dayStart.getTime() + minutes * 60_000`. Chips are positioned
 * by wall clock (`localMinutes`), so on a DST transition day absolute-millisecond
 * arithmetic disagrees with what the user is looking at: on a 23-hour day the
 * visual noon guide books 13:00, and the right-hand end of the row lands on the
 * following date. Setting the clock on the row's own calendar date keeps both
 * readings in agreement whatever the day's real length.
 */
function atLocalMinutes(dayStart: Date, minutes: number): Date {
  const whole = Math.floor(minutes);
  const at = new Date(dayStart);
  at.setHours(Math.floor(whole / 60), whole % 60, 0, 0);

  // The sub-minute remainder is a fraction of a pointer position rather than a
  // crossing, so adding it as elapsed time cannot straddle a transition.
  return new Date(at.getTime() + Math.round((minutes - whole) * 60_000));
}

/** Unsnapped instant for a ratio across a day row. Zero when the ratio is unusable. */
function rawInstant(dayStart: Date, ratio: number): Date {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;

  return atLocalMinutes(dayStart, clamped * MINUTES_PER_DAY);
}

/** Round an instant to the drop grain. */
function snapInstant(instant: Date): Date {
  const grainMs = DROP_SNAP_MINUTES * 60_000;

  return new Date(Math.round(instant.getTime() / grainMs) * grainMs);
}

/**
 * Local instant for a drop at `ratio` across a day row, snapped to the grain.
 *
 * A non-finite ratio (a drop event carrying no usable coordinate) falls back to
 * the start of the day rather than producing an Invalid Date, which would
 * otherwise travel all the way to the accept mutation.
 */
function dropInstant(dayStart: Date, ratio: number): Date {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const raw = clamped * MINUTES_PER_DAY;
  const snapped = Math.round(raw / DROP_SNAP_MINUTES) * DROP_SNAP_MINUTES;

  // Capped one grain short of the row's end so a drop at the far right stays on
  // the day it was made on. The cap is in wall-clock minutes, so it holds on a
  // 23- or 25-hour day too — 23:45 is the last slot of every calendar date.
  return atLocalMinutes(dayStart, Math.min(snapped, MINUTES_PER_DAY - DROP_SNAP_MINUTES));
}

/**
 * Where a dragged event should now start.
 *
 * Moves by the delta between grab point and drop point rather than snapping the
 * event's start to the cursor. Grabbing the middle of a two-hour block and
 * dropping it on Thursday afternoon should shift it, not make it begin under the
 * pointer — and for a chip that is only the clipped tail of an overnight event,
 * a delta is the sole interpretation that does not teleport it a day.
 */
function movedStart(dayStart: Date, ratio: number, grabOffsetMs: number): Date {
  return snapInstant(new Date(rawInstant(dayStart, ratio).getTime() - grabOffsetMs));
}

// ── Event copy ────────────────────────────────────────────────────────────────

/**
 * True when the description says something the title does not.
 *
 * Suppressed when it merely restates the title — several producers copy the
 * title into the description, and repeating one line twice in a tooltip reads
 * as a bug rather than as detail.
 */
function describes(event: ScheduleEvent): boolean {
  const description = event.description?.trim();

  if (!description) {
    return false;
  }

  return description.toLowerCase() !== (event.title ?? '').trim().toLowerCase();
}

/**
 * Page URL for a captured visit (or null when the event has nowhere to open).
 * Browser-extension rows store it at `metadata.url`.
 */
function eventUrl(event: ScheduleEvent): string | null {
  const raw = event.metadata?.url;

  if (typeof raw !== 'string') {
    return null;
  }

  const url = raw.trim();

  return /^https?:\/\//i.test(url) ? url : null;
}

// ── Day geometry ──────────────────────────────────────────────────────────────

function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** UTC calendar date of an instant — how forecast days are keyed. */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Clip an event to a single local day and express it as percentages of that row.
 *
 * A flight that departs Sunday night and lands Monday morning must appear on
 * both rows; that is why this clips rather than filters. Zero-length and all-day
 * events get a floor width so they stay clickable.
 */
function spanForDay(event: ScheduleEvent, dayStart: Date): EventSpan | null {
  const dayEnd = addDays(dayStart, 1);
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : start;

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  if (start >= dayEnd || end < dayStart) {
    return null;
  }

  if (event.isAllDay) {
    return { event, leftPct: 0, widthPct: 100, continuesFrom: false, continuesTo: false };
  }

  const clippedStart = start < dayStart ? dayStart : start;
  const clippedEnd = end > dayEnd ? dayEnd : end;

  const startMin = sameLocalDay(clippedStart, dayStart) ? localMinutes(clippedStart) : 0;
  const endMin = clippedEnd >= dayEnd ? MINUTES_PER_DAY : localMinutes(clippedEnd);

  const widthMin = Math.max(endMin - startMin, 20);

  return {
    event,
    leftPct: (startMin / MINUTES_PER_DAY) * 100,
    widthPct: Math.min((widthMin / MINUTES_PER_DAY) * 100, 100 - (startMin / MINUTES_PER_DAY) * 100),
    continuesFrom: start < dayStart,
    continuesTo: end > dayEnd,
  };
}

// ── Rhythm ────────────────────────────────────────────────────────────────────

type RhythmCluster = RhythmDay['clusters'][number];

/** One rhythm slot: how hard it pulls, and which behaviour is doing the pulling. */
interface RhythmClaim {
  weight: number;
  l0Class: ActivityClass;
}

/**
 * The four daypart weights for one forecast day.
 *
 * A daypart's weight is the STRONGEST single claim on it —
 * `max(pOccur × daypartProb)` — not the union of every claim. The union reads
 * better in theory and is useless in practice: a real user has ~20 discovered
 * clusters, most with pOccur near 1 and mass spread across all four dayparts, so
 * a noisy-OR saturates everything to ~1.0 and the layer degenerates into
 * "everything, always". The max asks the question that carries information: how
 * hard does the most-expected behaviour pull on this part of the day.
 */
function daypartClaims(day: RhythmDay | undefined): RhythmClaim[] {
  const claims: RhythmClaim[] = [
    { weight: 0, l0Class: 'UNKNOWN' },
    { weight: 0, l0Class: 'UNKNOWN' },
    { weight: 0, l0Class: 'UNKNOWN' },
    { weight: 0, l0Class: 'UNKNOWN' },
  ];

  if (!day) {
    return claims;
  }

  for (const cluster of day.clusters) {
    for (const entry of cluster.daypartProbs) {
      const idx = DAYPART_NAMES.indexOf(entry.label as DaypartName);
      const weight = cluster.pOccur * entry.probability;

      // The winning cluster carries the daypart's colour as well as its
      // weight — the class of the behaviour that pulls hardest is the honest
      // label for the cell, for the same reason the weight is a max and not a
      // union.
      if (idx >= 0 && weight > claims[idx].weight) {
        claims[idx] = { weight, l0Class: normalizeClass(cluster.l0Class) };
      }
    }
  }

  return claims;
}

/** Weights alone — the shape the layout maths and its tests work in. */
function daypartWeights(day: RhythmDay | undefined): number[] {
  return daypartClaims(day).map((claim) => claim.weight);
}

/**
 * Rhythm intensity for each 15-minute local slot of a day (96 cells).
 *
 * The week forecast still speaks in four UTC dayparts; painting them at the
 * occupancy grain keeps the strip on the same clock as Forecast and drop-snap,
 * and lets a UTC offset split a daypart at the real quarter-hour instead of
 * the hour. Each slot asks which UTC instant it is, so no band has to be
 * split at local midnight by hand.
 */
function rhythmClaims(dayStart: Date, lookup: (utcDate: string) => RhythmDay | undefined): RhythmClaim[] {
  const claimCache = new Map<string, RhythmClaim[]>();

  return Array.from({ length: BUCKETS_PER_DAY }, (_, slot) => {
    const instant = atLocalMinutes(dayStart, slot * BUCKET_MINUTES);
    const key = utcDateKey(instant);

    if (!claimCache.has(key)) {
      claimCache.set(key, daypartClaims(lookup(key)));
    }

    const idx = Math.floor(instant.getUTCHours() / DAYPART_HOURS);

    return claimCache.get(key)?.[idx] ?? { weight: 0, l0Class: 'UNKNOWN' };
  });
}

/** Intensities alone — the shape the layout maths and its tests work in. */
function rhythmCells(dayStart: Date, lookup: (utcDate: string) => RhythmDay | undefined): number[] {
  return rhythmClaims(dayStart, lookup).map((claim) => claim.weight);
}

/** Top behaviours for a day, for the row tooltip. */
function topClusters(day: RhythmDay | undefined, limit = 4): RhythmCluster[] {
  return [...(day?.clusters ?? [])]
    .filter((cluster) =>
      weekClusterVisible({
        name: cluster.name,
        l0Class: cluster.l0Class,
        pOccur: cluster.pOccur,
        scheduled: Boolean(cluster.scheduled),
      }),
    )
    .sort((a, b) => b.pOccur - a.pOccur)
    .slice(0, limit);
}

/**
 * Text equivalent of the rhythm lane.
 *
 * The lane encodes everything it says in hue and opacity across 96 empty cells,
 * with the words only in a hover tooltip. Naming it as an image, with the same
 * behaviours the tooltip lists, is what makes the layer legible to anyone not
 * using a mouse.
 */
function rhythmLabel(dayStart: Date, clusters: RhythmCluster[]): string {
  const day = dayStart.toLocaleDateString([], { weekday: 'long' });

  if (clusters.length === 0) {
    return `Predicted rhythm for ${day}: no established pattern yet.`;
  }

  const listed = clusters.map((c) => `${c.name} ${Math.round(c.pOccur * 100)}%`).join(', ');

  return `Predicted rhythm for ${day}: ${listed}.`;
}

/**
 * Waiting twin of {@link rhythmLabel}.
 *
 * The week draws one strip per day, and every one of them is waiting at the
 * same time, so a name that says only "still being built" announces itself
 * seven times over — seven tab stops that a screen reader cannot tell apart.
 * Day-scoping it the way `rhythmLabel` already does keeps each strip's name
 * its own. Same seven-day (or single-day) window, so a weekday alone is unique
 * here for exactly the reason it is unique there.
 */
function rhythmWaitingLabel(dayStart: Date): string {
  const day = dayStart.toLocaleDateString([], { weekday: 'long' });

  return `Predicted rhythm for ${day}: still being built. This can take a while.`;
}

// ── Lanes ─────────────────────────────────────────────────────────────────────

/**
 * Classic lane packer for span arrays. Production packing runs on folded
 * clusters via `packItemLanes`; this is the plain-span adapter its tests drive.
 */
function packLanes(spans: EventSpan[]): number[] {
  return packItemLanes(
    spans.map((span) => ({
      kind: 'single' as const,
      span,
      leftPct: span.leftPct,
      widthPct: span.widthPct,
    })),
  );
}

export {
  spanForDay,
  packLanes,
  daypartWeights,
  describes,
  eventUrl,
  rhythmCells,
  rhythmClaims,
  rhythmLabel,
  rhythmWaitingLabel,
  topClusters,
  cellOpacity,
  utcDateKey,
  dropInstant,
  movedStart,
  RHYTHM_NOISE_FLOOR,
  BUCKET_MINUTES,
  BUCKETS_PER_DAY,
};

export type { RhythmClaim, RhythmCluster };
