import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn, Tooltip } from '@ci/shadcn';

import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';
import {
  type ActivityClass,
  type ColorMode,
  CLASS_LABEL,
  chipBorder,
  chipFill,
  classColor,
  classifyEvent,
  eventColor,
  normalizeClass,
  sourceOf,
} from '@/lib/activityPalette';
import {
  CANDIDATE_DRAG_TYPE,
  EVENT_DRAG_TYPE,
  EVENT_EXTERNAL_DRAG_TYPE,
  parseEventDrag,
} from '@/lib/scheduleDrag';

import {
  DAY_LANES_EXPANDED_MAX_HEIGHT_PX,
  DAY_LANES_MAX_HEIGHT_PX,
  LANE_GAP_PX,
  LANE_HEIGHT_PX,
  NARROW_SPAN_PCT,
  foldMicroClusters,
  packItemLanes,
  stackHeightPx,
  unpackToSingles,
  type EventSpan,
  type PackedItem,
} from './scheduleClusters';

// ── Constants ─────────────────────────────────────────────────────────────────

const MINUTES_PER_DAY = 24 * 60;
const HOURS_PER_DAY = 24;

/**
 * HBPE bins behaviour into four 6-hour dayparts anchored at UTC midnight
 * (recurrence.py: BUCKETS_PER_PART = 12). Cells are resolved per local hour by
 * looking up the UTC instant that hour actually falls in, so a viewer far from
 * UTC sees their real rhythm rather than a label that assumes "morning" means
 * their morning.
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

/** Quarter-day guides, so the eye can find noon without counting. */
const GUIDE_HOURS = [6, 12, 18];
const AXIS_HOURS = [0, 4, 8, 12, 16, 20];

/** Long horizons virtualize inside a scroll pane; week views stay fully mounted. */
const VIRTUALIZE_DAYS_AFTER = 14;
/** Conservative row height for windowing — lanes can grow, so bias high. */
const ESTIMATED_DAY_ROW_PX = 280;
const VIRTUAL_OVERSCAN = 2;

/**
 * Dropping snaps to this grain. Finer would imply a precision the suggestion
 * does not have; coarser would fight the user placing something after lunch.
 */
const DROP_SNAP_MINUTES = 15;

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

/** True when the event is a mirror of a row owned by an external calendar. */
function isExternallyOwned(event: ScheduleEvent): boolean {
  return Boolean(event.sourceSystem);
}

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);

  return d;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Short hour label ("6 AM"), for the axis. */
function formatHour(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
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

/**
 * One line saying everything the chip's tooltip says.
 *
 * The tooltip is the only place an event's time, place and activity class
 * appear, and it is hover-driven — so without this the chip has no accessible
 * name at all, and a narrow one has no text of any kind. That would leave hue
 * as the sole carrier of identity, which is exactly the precondition the
 * palette's contrast budget depends on not happening.
 */
function chipLabel(event: ScheduleEvent, colorMode: ColorMode): string {
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : null;

  const parts = [
    event.title,
    event.isAllDay ? 'all day' : `${formatClock(start)}${end ? ` to ${formatClock(end)}` : ''}`,
    colorMode === 'source' ? sourceOf(event) : CLASS_LABEL[classifyEvent(event)],
  ];

  if (event.locationName) {
    parts.push(event.locationName);
  }

  if (event.status === 'tentative') {
    parts.push('tentative');
  }

  return parts.join(', ');
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
 * Rhythm intensity for each of the 24 local hours of a day.
 *
 * Rendering per-hour cells rather than four wide bands is what makes the layer
 * legible: 6-hour slabs of near-equal weight fuse into one uniform bar, while
 * a row of discrete cells reads as texture and shows where the day's weight
 * actually sits. It also makes the UTC offset fall out for free — each hour asks
 * which UTC daypart it lands in, so no band has to be split at local midnight.
 */
function rhythmClaims(dayStart: Date, lookup: (utcDate: string) => RhythmDay | undefined): RhythmClaim[] {
  const claimCache = new Map<string, RhythmClaim[]>();

  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
    const instant = new Date(dayStart.getTime() + hour * 3_600_000);
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
  return [...(day?.clusters ?? [])].sort((a, b) => b.pOccur - a.pOccur).slice(0, limit);
}

/**
 * Text equivalent of the rhythm lane.
 *
 * The lane encodes everything it says in hue and opacity across 24 empty cells,
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

type RhythmCluster = RhythmDay['clusters'][number];

/** One rhythm slot: how hard it pulls, and which behaviour is doing the pulling. */
interface RhythmClaim {
  weight: number;
  l0Class: ActivityClass;
}

/**
 * Classic lane packer for span arrays (tests + stories). Production packing
 * runs on folded clusters via `packItemLanes`.
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

/** Folded browser pile — one chip; titles live in the tooltip. */
function ClusterChip({
  item,
  top,
  colorMode,
  onExpandDay,
}: {
  item: Extract<PackedItem, { kind: 'cluster' }>;
  top: number;
  colorMode: ColorMode;
  /** Clicking the stack unpacks the day. */
  onExpandDay?: () => void;
}) {
  const lead = item.spans[0]?.event;
  const color = lead ? eventColor(lead, colorMode) : classColor('UNKNOWN');
  const count = item.spans.length;
  const label = `${count} overlapping activities`;

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <div
          role="listitem"
          data-schedule-chip
          tabIndex={0}
          aria-label={label}
          title={label}
          className={cn(
            'group/chip absolute z-[5] cursor-pointer overflow-hidden whitespace-nowrap border text-[11px] leading-[26px]',
            'rounded-md text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'transition-[filter,z-index] duration-150 hover:z-30 focus-within:z-30 hover:brightness-110',
          )}
          style={{
            left: `${item.leftPct}%`,
            width: `${Math.max(item.widthPct, 1.2)}%`,
            top,
            height: LANE_HEIGHT_PX,
            backgroundColor: color,
            borderColor: chipBorder(color),
            borderLeftWidth: '3px',
            borderLeftColor: color,
            boxShadow: `2px 2px 0 ${chipFill(color)}, 4px 4px 0 ${chipBorder(color)}`,
          }}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            onExpandDay?.();
          }}
        >
          <span className="px-1.5 font-semibold tabular-nums text-background mix-blend-difference">
            {count}
          </span>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Content side="top">
        <div className="max-w-64 space-y-1 text-left">
          <p className="text-xs font-medium">{label}</p>
          <ul className="space-y-0.5">
            {item.spans.map(({ event }) => {
              const url = eventUrl(event);

              return (
                <li key={event.id} className="text-[11px] leading-snug">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={(clickEvent) => clickEvent.stopPropagation()}
                    >
                      {event.title}
                    </a>
                  ) : (
                    <span className="font-medium">{event.title}</span>
                  )}
                  <span className="ml-1.5 text-[10px] opacity-75 tabular-nums">
                    {formatClock(new Date(event.startTime))}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] opacity-75">Expand the day to unpack</p>
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface DayRowProps {
  dayStart: Date;
  dayEvents: ScheduleEvent[];
  lookup: (utcDate: string) => RhythmDay | undefined;
  isToday: boolean;
  isSelected: boolean;
  nowPct: number | null;
  colorMode: ColorMode;
  onSelectDay?: (dayStart: Date) => void;
  onDropCandidate?: (candidateId: string, startTime: Date) => void;
  onMoveEvent?: (eventId: string, startTime: Date) => void;
}

const DayRow = memo(function DayRow({
  dayStart,
  dayEvents,
  lookup,
  isToday,
  isSelected,
  nowPct,
  colorMode,
  onSelectDay,
  onDropCandidate,
  onMoveEvent,
}: DayRowProps) {
  /** Where a dragged candidate would land, as a percentage across the row. */
  const [dropPct, setDropPct] = useState<number | null>(null);
  /** Dense days start capped; click the day chrome to reveal more lanes. */
  const [expanded, setExpanded] = useState(false);
  const spans = useMemo(
    () =>
      dayEvents
        .map((event) => spanForDay(event, dayStart))
        .filter((span): span is EventSpan => span !== null)
        .sort((a, b) => a.leftPct - b.leftPct),
    [dayEvents, dayStart],
  );

  // Collapsed: bucket micros into compact stack chips. Expanded: unpack to
  // capped singles so the day can actually show more.
  const collapsedPacked = useMemo(() => foldMicroClusters(spans), [spans]);
  const expandedPacked = useMemo(() => unpackToSingles(spans), [spans]);
  const packed = expanded ? expandedPacked : collapsedPacked;
  const lanes = useMemo(() => packItemLanes(packed), [packed]);
  const laneCount = Math.max(1, ...lanes.map((lane) => lane + 1));
  const stackHeight = stackHeightPx(laneCount);
  const expandedLaneCount = useMemo(() => {
    const expandedLanes = packItemLanes(expandedPacked);

    return Math.max(1, ...expandedLanes.map((lane) => lane + 1));
  }, [expandedPacked]);
  const canExpand =
    collapsedPacked.some((item) => item.kind === 'cluster') ||
    stackHeightPx(expandedLaneCount) > DAY_LANES_MAX_HEIGHT_PX + 1;
  const lanesMaxHeight = expanded
    ? Math.min(stackHeight, DAY_LANES_EXPANDED_MAX_HEIGHT_PX)
    : Math.min(stackHeight, DAY_LANES_MAX_HEIGHT_PX);

  const claims = useMemo(() => rhythmClaims(dayStart, lookup), [dayStart, lookup]);
  const clusters = useMemo(() => topClusters(lookup(utcDateKey(dayStart))), [lookup, dayStart]);
  const hasRhythm = claims.some((c) => c.weight >= RHYTHM_NOISE_FLOOR);

  const dayLabel = dayStart.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const isDropTarget = dropPct !== null;
  const acceptsDrops = Boolean(onDropCandidate ?? onMoveEvent);

  const openDayStory = () => {
    if (dayEvents.length > 0) {
      onSelectDay?.(dayStart);
    }
  };

  /** Ratio across the lane for a pointer event, from the lane's own box. */
  const ratioFor = (event: { clientX: number; currentTarget: HTMLElement }): number => {
    const box = event.currentTarget.getBoundingClientRect();

    return box.width === 0 ? 0 : (event.clientX - box.left) / box.width;
  };

  /** Which payload is in flight, and whether this row can take it. */
  const draggedKind = (types: readonly string[]): 'candidate' | 'event' | null => {
    if (onDropCandidate && types.includes(CANDIDATE_DRAG_TYPE)) {
      return 'candidate';
    }

    if (onMoveEvent && types.includes(EVENT_DRAG_TYPE)) {
      return 'event';
    }

    return null;
  };

  return (
    <div
      role="listitem"
      aria-label={dayLabel}
      className={cn(
        'flex items-stretch gap-3 rounded-lg px-2 py-2 transition-colors [contain-intrinsic-size:auto_120px] [content-visibility:auto]',
        // Today is marked with a rail rather than a wash — a filled row drowns
        // its own rhythm lane, which is the thing you most want to read there.
        isSelected
          ? 'bg-accent/20 ring-1 ring-inset ring-primary/40'
          : isToday
            ? 'bg-accent/15 ring-1 ring-inset ring-primary/25'
            : 'hover:bg-accent/15',
        isDropTarget && 'bg-primary/10 ring-1 ring-inset ring-primary/60',
      )}
    >
      <button
        type="button"
        className={cn(
          'w-10 shrink-0 rounded-md pt-0.5 text-right outline-none',
          'cursor-pointer hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring',
        )}
        aria-pressed={isSelected}
        aria-label={`Show ${dayLabel} as a story`}
        onClick={() => onSelectDay?.(dayStart)}
      >
        <div
          className={cn(
            'text-xs leading-tight',
            isSelected || isToday ? 'font-medium' : 'text-muted-foreground',
          )}
        >
          {dayStart.toLocaleDateString([], { weekday: 'short' })}
        </div>
        <div
          className={cn('text-[11px] leading-tight', isSelected || isToday ? '' : 'text-muted-foreground/70')}
        >
          {dayStart.getDate()}
        </div>
      </button>

      <div
        className="relative min-w-0 flex-1"
        onDragOver={
          acceptsDrops
            ? (e) => {
                // Only claim the drop for payloads this row can handle;
                // preventDefault is what marks the element as a valid target.
                const kind = draggedKind(e.dataTransfer.types);

                if (!kind) {
                  return;
                }

                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropPct(Math.max(0, Math.min(1, ratioFor(e))) * 100);
              }
            : undefined
        }
        onDragLeave={() => setDropPct(null)}
        onDrop={
          acceptsDrops
            ? (e) => {
                setDropPct(null);

                const kind = draggedKind(e.dataTransfer.types);

                if (!kind) {
                  return;
                }

                e.preventDefault();

                if (kind === 'candidate') {
                  const id = e.dataTransfer.getData(CANDIDATE_DRAG_TYPE);

                  if (id) {
                    onDropCandidate?.(id, dropInstant(dayStart, ratioFor(e)));
                  }

                  return;
                }

                const payload = parseEventDrag(e.dataTransfer.getData(EVENT_DRAG_TYPE));

                if (payload) {
                  onMoveEvent?.(payload.id, movedStart(dayStart, ratioFor(e), payload.grabOffsetMs));
                }
              }
            : undefined
        }
      >
        {/* Where it would land, and at what time. */}
        {dropPct !== null && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-primary"
              style={{ left: `${dropPct}%` }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -top-1 z-20 -translate-x-1/2 rounded bg-primary px-1 py-px text-[10px] text-primary-foreground tabular-nums"
              style={{ left: `${dropPct}%` }}
            >
              {formatClock(dropInstant(dayStart, dropPct / 100))}
            </div>
          </>
        )}

        {/* Quarter-day guides — find noon without counting. */}
        {GUIDE_HOURS.map((hour) => (
          <div
            key={hour}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-border/50"
            style={{ left: `${(hour / HOURS_PER_DAY) * 100}%` }}
          />
        ))}

        {/* Now — only on today, and only as a hairline. */}
        {isToday && nowPct !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-10 w-px bg-foreground/50"
            style={{ left: `${nowPct}%` }}
          />
        )}

        {/* Committed lane — solid chips. Overlapping browser ticks fold into
            stack chips; the lane stack is capped (click day to expand) and
            scrolls past the expanded ceiling so one day never owns the page. */}
        <div
          role="list"
          aria-label={`Committed time on ${dayLabel}`}
          data-testid="day-lanes-scroll"
          className={cn(
            'relative overflow-x-visible overflow-y-auto overscroll-contain pr-0.5 [scrollbar-width:thin]',
            canExpand && 'cursor-pointer',
          )}
          style={{ maxHeight: lanesMaxHeight }}
          onClick={
            canExpand
              ? (clickEvent) => {
                  // Empty day chrome expands; chips/links keep their own jobs.
                  // Do NOT match role=listitem — the day row itself uses that.
                  if (
                    (clickEvent.target as HTMLElement | null)?.closest?.('[data-schedule-chip], a, button')
                  ) {
                    return;
                  }

                  setExpanded((value) => {
                    if (!value) {
                      openDayStory();
                    }

                    return !value;
                  });
                }
              : undefined
          }
        >
          <div className="relative" style={{ height: Math.max(LANE_HEIGHT_PX, stackHeight) }}>
            {packed.map((item, index) => {
              if (item.kind === 'cluster') {
                return (
                  <ClusterChip
                    key={`cluster-${item.leftPct}-${item.spans[0]?.event.id ?? index}`}
                    item={item}
                    top={lanes[index] * (LANE_HEIGHT_PX + LANE_GAP_PX)}
                    colorMode={colorMode}
                    onExpandDay={
                      canExpand
                        ? () => {
                            setExpanded(true);
                            openDayStory();
                          }
                        : undefined
                    }
                  />
                );
              }

              const { event, leftPct, widthPct, continuesFrom, continuesTo } = item.span;
              const isNarrow = widthPct < NARROW_SPAN_PCT;
              const movable = Boolean(onMoveEvent);
              const color = eventColor(event, colorMode);
              const url = eventUrl(event);

              return (
                <Tooltip key={`${event.id}-${dayStart.toDateString()}`}>
                  <Tooltip.Trigger asChild>
                    <div
                      role="listitem"
                      data-schedule-chip
                      tabIndex={0}
                      aria-label={chipLabel(event, colorMode)}
                      title={isNarrow ? event.title : undefined}
                      draggable={movable}
                      onDragStart={
                        movable
                          ? (e) => {
                              if ((e.target as Element | null)?.closest?.('a')) {
                                e.preventDefault();

                                return;
                              }

                              const box = e.currentTarget.getBoundingClientRect();
                              const withinChip = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
                              const grabDayRatio =
                                (leftPct + Math.max(0, Math.min(1, withinChip)) * widthPct) / 100;
                              const grabbedAt = rawInstant(dayStart, grabDayRatio);
                              const grabOffsetMs = event.isAllDay
                                ? 0
                                : grabbedAt.getTime() - new Date(event.startTime).getTime();
                              const external = isExternallyOwned(event);

                              e.dataTransfer.setData(
                                EVENT_DRAG_TYPE,
                                JSON.stringify({
                                  id: event.id,
                                  grabOffsetMs,
                                  externallyOwned: external,
                                }),
                              );

                              if (external) {
                                e.dataTransfer.setData(EVENT_EXTERNAL_DRAG_TYPE, '1');
                              }

                              e.dataTransfer.setData('text/plain', event.title);
                              e.dataTransfer.effectAllowed = 'move';
                            }
                          : undefined
                      }
                      className={cn(
                        'group/chip absolute z-[5] whitespace-nowrap border text-[11px] leading-[26px]',
                        'text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        'transition-[filter,box-shadow,z-index] duration-150',
                        'hover:z-30 focus-within:z-30',
                        movable && 'cursor-grab active:cursor-grabbing hover:brightness-110',
                        isNarrow ? 'overflow-hidden' : 'overflow-hidden px-2',
                        event.status === 'tentative' && 'border-dashed text-muted-foreground',
                        continuesFrom ? 'rounded-l-none border-l-0' : 'rounded-l-md',
                        continuesTo ? 'rounded-r-none border-r-0' : 'rounded-r-md',
                      )}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: lanes[index] * (LANE_HEIGHT_PX + LANE_GAP_PX),
                        height: LANE_HEIGHT_PX,
                        backgroundColor: isNarrow ? color : chipFill(color),
                        borderColor: chipBorder(color),
                        ...(continuesFrom ? {} : { borderLeftWidth: '3px', borderLeftColor: color }),
                      }}
                    >
                      {!isNarrow &&
                        (url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            draggable={false}
                            className="block truncate select-text font-medium text-foreground underline-offset-2 hover:underline"
                            onClick={(clickEvent) => clickEvent.stopPropagation()}
                            onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
                          >
                            {event.title}
                          </a>
                        ) : (
                          <span className="block truncate select-text">{event.title}</span>
                        ))}
                    </div>
                  </Tooltip.Trigger>
                  <Tooltip.Content side="top">
                    <div className="max-w-64 space-y-1 text-left">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-xs font-medium underline-offset-2 hover:underline"
                          onClick={(clickEvent) => clickEvent.stopPropagation()}
                        >
                          {event.title}
                        </a>
                      ) : (
                        <p className="text-xs font-medium">{event.title}</p>
                      )}
                      <p className="text-[10px] opacity-75">
                        {event.isAllDay
                          ? 'All day'
                          : `${formatClock(new Date(event.startTime))}${
                              event.endTime ? ` – ${formatClock(new Date(event.endTime))}` : ''
                            }`}
                      </p>
                      {describes(event) && (
                        <p className="text-[11px] leading-snug opacity-90">{event.description}</p>
                      )}
                      {event.locationName && <p className="text-[10px] opacity-60">{event.locationName}</p>}
                      {event.status === 'tentative' && <p className="text-[10px] opacity-60">Tentative</p>}
                      <p className="flex items-center gap-1.5 text-[10px] opacity-60">
                        <span
                          aria-hidden
                          className="h-2 w-2 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: color }}
                        />
                        {colorMode === 'source' ? sourceOf(event) : CLASS_LABEL[classifyEvent(event)]}
                      </p>
                      {url && <p className="truncate text-[10px] opacity-60">{url}</p>}
                      {movable && isExternallyOwned(event) && (
                        <p className="border-t border-current/20 pt-1 text-[10px] opacity-60">
                          {event.externalSyncStatus === 'pending'
                            ? `Moved here — not yet pushed back to ${event.sourceSystem}.`
                            : `From ${event.sourceSystem}. Moving it here won't change the source.`}
                        </p>
                      )}
                    </div>
                  </Tooltip.Content>
                </Tooltip>
              );
            })}
          </div>
        </div>

        {canExpand && (
          <button
            type="button"
            data-testid="day-expand-toggle"
            className="mt-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            aria-expanded={expanded}
            onClick={() =>
              setExpanded((value) => {
                if (!value) {
                  openDayStory();
                }

                return !value;
              })
            }
          >
            {expanded ? 'Show less' : `Expand day · ${expandedLaneCount} items`}
          </button>
        )}

        {/* Rhythm lane — what this day usually holds. Ambient, never a task. */}
        <Tooltip>
          <Tooltip.Trigger asChild>
            {/* Discrete cells, not a bar: the gaps are what let the eye read
                density. A continuous fill of near-equal weight looks like a
                slab and says nothing. */}
            <div
              className="mt-1.5 flex h-2 gap-[2px]"
              // Named as an image with the behaviours spelled out: the cells
              // carry no text, so `role="img"` collapsing them to one node
              // loses nothing and gains a name most screen readers will read.
              // A lane with no signal in it is decoration and says so.
              {...(hasRhythm
                ? { role: 'img', 'aria-label': rhythmLabel(dayStart, clusters) }
                : { 'aria-hidden': true })}
            >
              {claims.map((claim, hour) => {
                const lit = claim.weight >= RHYTHM_NOISE_FLOOR;

                return (
                  <div
                    key={hour}
                    className={cn('flex-1 rounded-[2px]', !lit && 'bg-foreground/[0.06]')}
                    style={
                      lit
                        ? {
                            // In type mode the cell wears the class of the
                            // behaviour that claims it, which is what turns the
                            // lane from a density bar into a reading of the day.
                            // Source mode has nothing to say here — a prediction
                            // has no calendar — so it stays on the theme colour
                            // rather than inventing an answer.
                            backgroundColor:
                              colorMode === 'type' ? classColor(claim.l0Class) : 'var(--primary)',
                            opacity: cellOpacity(claim.weight),
                          }
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </Tooltip.Trigger>
          {hasRhythm && (
            <Tooltip.Content side="bottom">
              <div className="w-52 space-y-1 text-left">
                <p className="text-xs font-medium">
                  {dayStart.toLocaleDateString([], { weekday: 'long' })} — usually
                </p>
                {clusters.length === 0 ? (
                  <p className="text-[10px] opacity-60">No established pattern yet.</p>
                ) : (
                  clusters.map((cluster) => (
                    <div key={cluster.clusterId} className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {colorMode === 'type' && (
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: classColor(normalizeClass(cluster.l0Class)) }}
                          />
                        )}
                        <span className="truncate text-[10px] opacity-75">{cluster.name}</span>
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums opacity-60">
                        {Math.round(cluster.pOccur * 100)}%
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Tooltip.Content>
          )}
        </Tooltip>
      </div>
    </div>
  );
});

// ── Virtual day list ──────────────────────────────────────────────────────────

interface VirtualDayListProps {
  dayStarts: Date[];
  eventsByDayKey: Map<string, ScheduleEvent[]>;
  lookup: (utcDate: string) => RhythmDay | undefined;
  today: Date;
  selectedDay: Date;
  nowPct: number;
  colorMode: ColorMode;
  onSelectDay?: (dayStart: Date) => void;
  onDropCandidate?: (candidateId: string, startTime: Date) => void;
  onMoveEvent?: (eventId: string, startTime: Date) => void;
}

/**
 * Scroll-window day rows for month/year horizons. Week views mount every row;
 * longer windows keep off-screen rows out of the DOM unless a drag is in flight
 * (so a card can be dropped on a row the user scrolls to).
 */
function VirtualDayList({
  dayStarts,
  eventsByDayKey,
  lookup,
  today,
  selectedDay,
  nowPct,
  colorMode,
  onSelectDay,
  onDropCandidate,
  onMoveEvent,
}: VirtualDayListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  const virtualize = dayStarts.length > VIRTUALIZE_DAYS_AFTER && !dragActive;

  useEffect(() => {
    const pin = () => setDragActive(true);
    const unpin = () => setDragActive(false);

    document.addEventListener('dragstart', pin);
    document.addEventListener('dragend', unpin);
    document.addEventListener('drop', unpin);

    return () => {
      document.removeEventListener('dragstart', pin);
      document.removeEventListener('dragend', unpin);
      document.removeEventListener('drop', unpin);
    };
  }, []);

  useEffect(() => {
    const element = scrollRef.current;

    if (!element || !virtualize) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });

    observer.observe(element);
    setViewportHeight(element.clientHeight);

    return () => observer.disconnect();
  }, [virtualize]);

  const { startIndex, endIndex, paddingTop, paddingBottom } = useMemo(() => {
    if (!virtualize || viewportHeight === 0) {
      return {
        startIndex: 0,
        endIndex: dayStarts.length,
        paddingTop: 0,
        paddingBottom: 0,
      };
    }

    const start = Math.max(0, Math.floor(scrollTop / ESTIMATED_DAY_ROW_PX) - VIRTUAL_OVERSCAN);
    const end = Math.min(
      dayStarts.length,
      Math.ceil((scrollTop + viewportHeight) / ESTIMATED_DAY_ROW_PX) + VIRTUAL_OVERSCAN,
    );

    return {
      startIndex: start,
      endIndex: end,
      paddingTop: start * ESTIMATED_DAY_ROW_PX,
      paddingBottom: (dayStarts.length - end) * ESTIMATED_DAY_ROW_PX,
    };
  }, [virtualize, viewportHeight, scrollTop, dayStarts.length]);

  const visibleDays = dayStarts.slice(startIndex, endIndex);

  return (
    <div
      ref={scrollRef}
      role="list"
      aria-label="Days"
      data-testid={virtualize ? 'horizon-virtual-scroll' : 'horizon-week'}
      className={cn(
        'flex flex-col gap-0.5',
        virtualize && 'max-h-[min(70vh,calc(100vh-12rem))] overflow-y-auto',
      )}
      onScroll={virtualize ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
    >
      {paddingTop > 0 && <div aria-hidden style={{ height: paddingTop }} />}
      {visibleDays.map((dayStart) => {
        const key = dayStart.toISOString();
        const isToday = sameLocalDay(dayStart, today);

        return (
          <DayRow
            key={key}
            dayStart={dayStart}
            dayEvents={eventsByDayKey.get(key) ?? []}
            lookup={lookup}
            isToday={isToday}
            isSelected={sameLocalDay(dayStart, selectedDay)}
            nowPct={isToday ? nowPct : null}
            colorMode={colorMode}
            onSelectDay={onSelectDay}
            onDropCandidate={onDropCandidate}
            onMoveEvent={onMoveEvent}
          />
        );
      })}
      {paddingBottom > 0 && <div aria-hidden style={{ height: paddingBottom }} />}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface HorizonGridProps {
  /** First day of the window, local midnight. */
  start: Date;
  days: number;
  events: ScheduleEvent[];
  rhythm: RhythmDay[];
  /**
   * Called when a slate candidate is dropped on a day. Omit to make the grid
   * read-only — drops are then simply not accepted.
   */
  onDropCandidate?: (candidateId: string, startTime: Date) => void;
  /**
   * Called when an already-committed event is dragged to a new time. Omit and
   * the chips stay put.
   */
  onMoveEvent?: (eventId: string, startTime: Date) => void;
  /** Day whose story strip is open. Defaults to today. */
  selectedDay?: Date;
  /** Click a weekday label to open that day's story. */
  onSelectDay?: (dayStart: Date) => void;
  /** What hue encodes: activity class, or the calendar it came from. */
  colorMode?: ColorMode;
  /**
   * Provenance note, rendered inside the card. It lives here rather than under
   * the card so the grid and the panel beside it are the same two boxes, ending
   * on the same line.
   */
  footer?: ReactNode;
  className?: string;
}

/**
 * The week, as days-down / time-across.
 *
 * Days are rows rather than columns because a fuzzy time window is a horizontal
 * smear, and because it lets a week, a month, and a year share one geometry.
 * Per-day rows are memoized; horizons longer than two weeks virtualize inside a
 * scroll pane (every row stays mounted during an active drag).
 *
 * The whole grid sits on its own card: PageContent paints a background texture,
 * and hairline content read directly against it is close to unreadable.
 */
export function HorizonGrid({
  start,
  days,
  events,
  rhythm,
  onDropCandidate,
  onMoveEvent,
  selectedDay,
  onSelectDay,
  colorMode = 'type',
  footer,
  className,
}: HorizonGridProps) {
  const now = new Date();
  const today = startOfLocalDay(now);
  const nowPct = ((now.getHours() * 60 + now.getMinutes()) / MINUTES_PER_DAY) * 100;

  const rhythmByDate = useMemo(() => new Map(rhythm.map((day) => [day.date, day])), [rhythm]);
  const lookup = useCallback((utcDate: string) => rhythmByDate.get(utcDate), [rhythmByDate]);

  const dayStarts = useMemo(
    () => Array.from({ length: days }, (_, index) => addDays(start, index)),
    [start, days],
  );

  const eventsByDayKey = useMemo(() => {
    const map = new Map<string, ScheduleEvent[]>();

    for (const dayStart of dayStarts) {
      const key = dayStart.toISOString();
      map.set(
        key,
        events.filter((entry) => spanForDay(entry, dayStart) !== null),
      );
    }

    return map;
  }, [dayStarts, events]);

  const handleDropCandidate = useCallback(
    (candidateId: string, startTime: Date) => {
      onDropCandidate?.(candidateId, startTime);
    },
    [onDropCandidate],
  );

  const handleMoveEvent = useCallback(
    (eventId: string, startTime: Date) => {
      onMoveEvent?.(eventId, startTime);
    },
    [onMoveEvent],
  );

  return (
    <div
      role="group"
      aria-label="Schedule"
      className={cn('flex flex-col rounded-xl border border-border bg-card p-3 md:p-4', className)}
    >
      {/* Time axis */}
      <div className="flex items-center gap-3 pb-2">
        <div className="w-10 shrink-0" />
        <div className="relative h-4 flex-1">
          {AXIS_HOURS.map((hour) => (
            <span
              key={hour}
              className="absolute text-[10px] text-muted-foreground"
              style={{ left: `${(hour / HOURS_PER_DAY) * 100}%` }}
            >
              {formatHour(hour)}
            </span>
          ))}
        </div>
      </div>

      <VirtualDayList
        dayStarts={dayStarts}
        eventsByDayKey={eventsByDayKey}
        lookup={lookup}
        today={today}
        selectedDay={selectedDay ?? today}
        nowPct={nowPct}
        colorMode={colorMode}
        onSelectDay={onSelectDay}
        onDropCandidate={onDropCandidate ? handleDropCandidate : undefined}
        onMoveEvent={onMoveEvent ? handleMoveEvent : undefined}
      />

      {footer && <div className="pt-2 text-[10px] text-muted-foreground">{footer}</div>}
    </div>
  );
}

export {
  spanForDay,
  packLanes,
  daypartWeights,
  describes,
  eventUrl,
  rhythmCells,
  dropInstant,
  movedStart,
  startOfLocalDay,
  addDays,
  VIRTUALIZE_DAYS_AFTER,
  ESTIMATED_DAY_ROW_PX,
};
