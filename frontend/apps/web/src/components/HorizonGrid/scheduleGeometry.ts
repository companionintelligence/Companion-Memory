/**
 * Shared schedule geometry — the maths behind the schedule surface.
 *
 * Clipping events onto a day, resolving a pointer ratio to an instant, and
 * folding HBPE's dayparts into 15-minute rhythm cells all used to live inside
 * `HorizonGrid`, which is gone (#2308: Calendar and Horizon are one view now).
 * They are kept apart from {@link VerticalCalendar} because they are pure
 * date/geometry functions with no React in them — that is what lets them be
 * tested directly rather than through a rendered grid.
 *
 * ═══ WHICH CLOCK ═══
 * Every day boundary and minute-of-day here is read in the OWNER'S PROFILE
 * ZONE — the same zone the backend places planned blocks in. See
 * {@link ./zonedClock} for the whole argument and for the read/write helpers.
 * The trailing `zone` argument defaults to the browser's so a caller with no
 * profile zone keeps today's behaviour rather than silently moving to UTC.
 */

import type { ForecastBucket } from '@/api/useForecastService';
import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';
import { type ActivityClass, normalizeClass } from '@/lib/activityPalette';
import { weekClusterVisible } from '@/lib/forecastDisplay';
import { detectBrowserTimeZone } from '@/lib/timezone';

import { addDays, sameLocalDay } from './nowNext';
import { packItemLanes, type EventSpan } from './scheduleClusters';
import { localDayKey } from './scheduleToTimeline';
import { instantAtDayMinutes, zonedMinutesOfDay, zonedStartOfDay } from './zonedClock';

/** An empty place on the calendar the user pointed at. */
export interface CalendarSlot {
  instant: Date;
  allDay: boolean;
}

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
 * Ink range for a rhythm wash behind committed time. The floor keeps a
 * weak-but-real pattern visible; the ceiling stays ambient so chips still
 * read as the foreground. Weight maps linearly across the range rather than
 * being clamped, so a 0.9 cell still reads darker than a 0.6 one.
 */
const MIN_CELL_INK = 0.12;
const MAX_CELL_INK = 0.42;

function cellOpacity(intensity: number): number {
  return MIN_CELL_INK + (MAX_CELL_INK - MIN_CELL_INK) * Math.min(intensity, 1);
}

/**
 * Dropping snaps to this grain. Finer would imply a precision the suggestion
 * does not have; coarser would fight the user placing something after lunch.
 */
const DROP_SNAP_MINUTES = 15;

// ── Instants ──────────────────────────────────────────────────────────────────

/** Unsnapped instant for a ratio across a day row. Zero when the ratio is unusable. */
function rawInstant(dayStart: Date, ratio: number, zone: string): Date {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;

  return instantAtDayMinutes(dayStart, clamped * MINUTES_PER_DAY, zone);
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
function dropInstant(dayStart: Date, ratio: number, zone: string = detectBrowserTimeZone()): Date {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const raw = clamped * MINUTES_PER_DAY;
  const snapped = Math.round(raw / DROP_SNAP_MINUTES) * DROP_SNAP_MINUTES;

  // Capped one grain short of the row's end so a drop at the far right stays on
  // the day it was made on. The cap is in wall-clock minutes, so it holds on a
  // 23- or 25-hour day too — 23:45 is the last slot of every calendar date.
  return instantAtDayMinutes(dayStart, Math.min(snapped, MINUTES_PER_DAY - DROP_SNAP_MINUTES), zone);
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
function movedStart(
  dayStart: Date,
  ratio: number,
  grabOffsetMs: number,
  zone: string = detectBrowserTimeZone(),
): Date {
  return snapInstant(new Date(rawInstant(dayStart, ratio, zone).getTime() - grabOffsetMs));
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

/** UTC calendar date of an instant — how forecast days are keyed. */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** True when an instant sits exactly on UTC midnight — how a date-only value parses. */
function isUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/**
 * Whether an all-day event names this row's calendar date.
 *
 * An all-day event is a DATE, not an interval, and it reaches us in two shapes.
 * A Google import is date-only in the payload, so `new Date('2026-08-04')` pins
 * it to UTC midnight — `TransformGoogleCalendar` drops `start.timeZone`
 * entirely, which is the `floatingAsUtc` case `TemporalRepairStage` documents.
 * One created in this app is LOCAL midnight (`EventForm`'s
 * `combineDateAndClock`). Asking which local days either OVERLAPS as an instant
 * is what put a single birthday chip on two adjacent day columns: the
 * UTC-anchored one leaks into the following column under UTC and every zone
 * east of it and into the preceding one across the Americas, and the
 * local-midnight one leaks forward everywhere because its exclusive end lands
 * exactly on the next row's first instant.
 *
 * So read both ends as calendar dates in the zone the event's own midnight
 * belongs to — UTC when the start sits exactly on UTC midnight, local
 * otherwise — and compare those against the row's own date. The end is
 * exclusive (Google's `end.date` is the morning after), hence the step back
 * before it is read; an event with no end at all names the single date it
 * starts on.
 */
function allDayCoversDay(start: Date, end: Date, dayStart: Date, zone: string): boolean {
  const anchoredToUtc = isUtcMidnight(start);
  const dateKey = (instant: Date) => (anchoredToUtc ? utcDateKey(instant) : localDayKey(instant, zone));
  const lastInstant = new Date(Math.max(end.getTime() - 1, start.getTime()));
  const day = localDayKey(dayStart, zone);

  return day >= dateKey(start) && day <= dateKey(lastInstant);
}

/**
 * Clip an event to a single local day and express it as percentages of that row.
 *
 * A flight that departs Sunday night and lands Monday morning must appear on
 * both rows; that is why this clips rather than filters. Zero-length events get
 * a floor width so they stay clickable; an all-day event takes the whole row on
 * each date it names.
 */
function spanForDay(
  event: ScheduleEvent,
  dayStart: Date,
  zone: string = detectBrowserTimeZone(),
): EventSpan | null {
  const dayEnd = addDays(dayStart, 1, zone);
  const start = new Date(event.startTime);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  // An unparseable end does not disqualify the event — the start is what places
  // it — but it must not reach the date arithmetic below, where it would either
  // throw out of `toISOString` or spread NaN through the percentages.
  const declaredEnd = event.endTime ? new Date(event.endTime) : start;
  const end = Number.isNaN(declaredEnd.getTime()) ? start : declaredEnd;

  // All-day rows are decided by date before any instant test — an overlap test
  // cannot answer this correctly; see `allDayCoversDay`.
  if (event.isAllDay) {
    return allDayCoversDay(start, end, dayStart, zone)
      ? { event, leftPct: 0, widthPct: 100, continuesFrom: false, continuesTo: false }
      : null;
  }

  // The end instant is exclusive: an event finishing at 00:00 finished on the
  // day before. Letting it through minted a phantom chip at the top of the next
  // day — clipped to zero minutes, then widened to the 20-minute floor below,
  // clickable and titled. A zero-length event has no interval to be exclusive
  // about, so it keeps the day its start falls on.
  const extent = end > start ? end : new Date(start.getTime() + 1);

  if (start >= dayEnd || extent <= dayStart) {
    return null;
  }

  const clippedStart = start < dayStart ? dayStart : start;
  const clippedEnd = end > dayEnd ? dayEnd : end;

  const startMin = sameLocalDay(clippedStart, dayStart, zone) ? zonedMinutesOfDay(clippedStart, zone) : 0;
  const endMin = clippedEnd >= dayEnd ? MINUTES_PER_DAY : zonedMinutesOfDay(clippedEnd, zone);

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
function rhythmClaims(
  dayStart: Date,
  lookup: (utcDate: string) => RhythmDay | undefined,
  zone: string = detectBrowserTimeZone(),
): RhythmClaim[] {
  const claimCache = new Map<string, RhythmClaim[]>();

  return Array.from({ length: BUCKETS_PER_DAY }, (_, slot) => {
    const instant = instantAtDayMinutes(dayStart, slot * BUCKET_MINUTES, zone);
    const key = utcDateKey(instant);

    if (!claimCache.has(key)) {
      claimCache.set(key, daypartClaims(lookup(key)));
    }

    const idx = Math.floor(instant.getUTCHours() / DAYPART_HOURS);

    return claimCache.get(key)?.[idx] ?? { weight: 0, l0Class: 'UNKNOWN' };
  });
}

/** Intensities alone — the shape the layout maths and its tests work in. */
function rhythmCells(
  dayStart: Date,
  lookup: (utcDate: string) => RhythmDay | undefined,
  zone: string = detectBrowserTimeZone(),
): number[] {
  return rhythmClaims(dayStart, lookup, zone).map((claim) => claim.weight);
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
function rhythmLabel(
  dayStart: Date,
  clusters: RhythmCluster[],
  zone: string = detectBrowserTimeZone(),
): string {
  const day = dayStart.toLocaleDateString([], { weekday: 'long', timeZone: zone });

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
function rhythmWaitingLabel(dayStart: Date, zone: string = detectBrowserTimeZone()): string {
  const day = dayStart.toLocaleDateString([], { weekday: 'long', timeZone: zone });

  return `Predicted rhythm for ${day}: still being built. This can take a while.`;
}

/** One occupancy slot from the day-ahead histogram, already on the local clock. */
interface OccupancyCell extends RhythmClaim {
  bucket: ForecastBucket | null;
  localMin: number;
  minutes: number;
}

/**
 * The class to paint for one bin.
 *
 * Prefers HBPE's `predictedL0` over the most probable `l0Probs` entry. The two
 * differ on purpose: the probabilities are a calibrated posterior, and most of
 * a day carries no recorded activity, so their argmax answers UNKNOWN nearly
 * everywhere even when the distribution is exactly right. HBPE picks the label
 * with a floored prior correction, which is a decision the server is better
 * placed to make — it is the side that knows the class priors.
 *
 * Falls back to the argmax when the field is absent, so an HBPE that predates
 * it paints exactly as it used to.
 */
function dominantOccupancyClass(bucket: ForecastBucket | null | undefined): ActivityClass {
  if (!bucket?.l0Probs.length) {
    return 'UNKNOWN';
  }

  if (bucket.predictedL0) {
    return normalizeClass(bucket.predictedL0);
  }

  const top = bucket.l0Probs.reduce((best, cur) => (cur.probability > best.probability ? cur : best));

  return normalizeClass(top.label);
}

/**
 * The day-ahead HBPE histogram, clipped onto one local calendar day.
 *
 * Returns null when no bucket's `startTime` falls on this day — the strip then
 * keeps the week-forecast climate. Occupancy is a 24h histogram that can
 * straddle two local dates, so each day's strip only paints the bins that
 * actually belong to it.
 */
function occupancyClaims(
  dayStart: Date,
  buckets: ForecastBucket[],
  zone: string = detectBrowserTimeZone(),
): OccupancyCell[] | null {
  if (buckets.length === 0) {
    return null;
  }

  const dayEnd = addDays(dayStart, 1, zone);
  const bySlot = new Map<number, OccupancyCell>();

  for (const bucket of buckets) {
    if (!bucket.startTime) {
      continue;
    }

    const at = new Date(bucket.startTime);

    if (Number.isNaN(at.getTime()) || at < dayStart || at >= dayEnd) {
      continue;
    }

    const slot = Math.min(BUCKETS_PER_DAY - 1, Math.floor(zonedMinutesOfDay(at, zone) / BUCKET_MINUTES));

    const l0Class = dominantOccupancyClass(bucket);

    bySlot.set(slot, {
      // UNKNOWN is "no claim", and this file already spells that weight 0 (the
      // empty slots below, and the climate path). It has to here too: the head
      // reports high confidence that nothing is recorded for most of a day, and
      // carrying that through as weight would wash `--activity-none` — a
      // visible slate grey — over two thirds of the calendar.
      weight: l0Class === 'UNKNOWN' ? 0 : bucket.q50,
      l0Class,
      bucket,
      localMin: slot * BUCKET_MINUTES,
      minutes: BUCKET_MINUTES,
    });
  }

  if (bySlot.size === 0) {
    return null;
  }

  return Array.from({ length: BUCKETS_PER_DAY }, (_, slot) => {
    return (
      bySlot.get(slot) ?? {
        weight: 0,
        l0Class: 'UNKNOWN' as ActivityClass,
        bucket: null,
        localMin: slot * BUCKET_MINUTES,
        minutes: BUCKET_MINUTES,
      }
    );
  });
}

function occupancyLabel(dayStart: Date, zone: string = detectBrowserTimeZone()): string {
  const day = dayStart.toLocaleDateString([], { weekday: 'long', timeZone: zone });

  return `Predicted occupancy for ${day}: 96 quarter-hour bins from HBPE.`;
}

/**
 * Whether any occupancy bin in `from`…`to` is strong enough to light a cell.
 *
 * The histogram is a fixed 24h horizon, not the drawn week, so a later week
 * must not inherit tomorrow's signal — that is how a footer would claim a
 * live layer over seven empty strips.
 */
function occupancySignalInRange(buckets: ForecastBucket[], from: Date, to: Date): boolean {
  const fromMs = from.getTime();
  const toMs = to.getTime();

  return buckets.some((bucket) => {
    if (!bucket.startTime || bucket.q50 < RHYTHM_NOISE_FLOOR) {
      return false;
    }

    const at = new Date(bucket.startTime).getTime();

    return Number.isFinite(at) && at >= fromMs && at < toMs;
  });
}

function visibleClusters(day: RhythmDay | undefined): RhythmCluster[] {
  return (day?.clusters ?? []).filter((cluster) =>
    weekClusterVisible({
      name: cluster.name,
      l0Class: cluster.l0Class,
      pOccur: cluster.pOccur,
      scheduled: Boolean(cluster.scheduled),
    }),
  );
}

/**
 * One sentence for the slot drawer: what this weekday (and daypart) usually holds.
 *
 * Returns null when the model has nothing honest to say — the drawer then shows
 * the labeled empty state rather than inventing a pattern.
 */
function slotForecastLine(
  slot: CalendarSlot,
  lookup: (utcDate: string) => RhythmDay | undefined,
  zone: string = detectBrowserTimeZone(),
): string | null {
  const weekday = slot.instant.toLocaleDateString([], { weekday: 'long', timeZone: zone });

  if (slot.allDay) {
    // Midnight and noon of the same local day, because one local day touches up
    // to two UTC dates and the rhythm lane is keyed on UTC.
    const start = zonedStartOfDay(slot.instant, zone);
    const noon = instantAtDayMinutes(start, 12 * 60, zone);
    const merged = new Map<string, RhythmCluster>();

    for (const key of new Set([utcDateKey(start), utcDateKey(noon)])) {
      for (const cluster of visibleClusters(lookup(key))) {
        const existing = merged.get(cluster.clusterId);

        if (!existing || cluster.pOccur > existing.pOccur) {
          merged.set(cluster.clusterId, cluster);
        }
      }
    }

    const top = [...merged.values()].sort((a, b) => b.pOccur - a.pOccur)[0];

    return top ? `${weekday}s you usually have ${top.name}.` : null;
  }

  const daypart = DAYPART_NAMES[Math.floor(slot.instant.getUTCHours() / DAYPART_HOURS)];
  let best: { cluster: RhythmCluster; weight: number } | null = null;

  for (const cluster of visibleClusters(lookup(utcDateKey(slot.instant)))) {
    const probability = cluster.daypartProbs.find((entry) => entry.label === daypart)?.probability ?? 0;
    const weight = cluster.pOccur * probability;

    if (!best || weight > best.weight) {
      best = { cluster, weight };
    }
  }

  if (!best || best.weight < RHYTHM_NOISE_FLOOR) {
    return null;
  }

  return `${weekday} ${daypart}s you usually have ${best.cluster.name}.`;
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
  occupancyClaims,
  occupancyLabel,
  occupancySignalInRange,
  topClusters,
  cellOpacity,
  utcDateKey,
  dropInstant,
  movedStart,
  slotForecastLine,
  RHYTHM_NOISE_FLOOR,
  BUCKET_MINUTES,
  BUCKETS_PER_DAY,
};

export type { OccupancyCell, RhythmClaim, RhythmCluster };
