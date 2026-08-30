import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@ci/shadcn';

import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';
import {
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
import { SCHEDULE_SCROLL_ATTR } from '@/lib/schedulePointerDrag';

import { EventPeek } from './EventPeek';
import { addDays, formatClock, sameLocalDay, startOfLocalDay } from './nowNext';
import { foldMicroClusters, packItemLanes, type PackedItem } from './scheduleClusters';
import {
  RHYTHM_NOISE_FLOOR,
  cellOpacity,
  describes,
  dropInstant,
  eventUrl,
  movedStart,
  rhythmClaims,
  rhythmLabel,
  spanForDay,
  topClusters,
  utcDateKey,
} from './scheduleGeometry';
import { useScheduleDropTarget } from './useScheduleDropTarget';

const MINUTES_PER_DAY = 24 * 60;
const HOURS_PER_DAY = 24;
const HOUR_HEIGHT_PX = 52;
const GRID_HEIGHT_PX = HOUR_HEIGHT_PX * HOURS_PER_DAY;
const AXIS_HOURS = Array.from({ length: HOURS_PER_DAY }, (_, hour) => hour);

/** Gap between 15-minute rhythm cells, in px — enough to read texture, not so much the strip is mostly gap. */
const RHYTHM_CELL_GAP_PX = 1;

function formatHour(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
}

function isExternallyOwned(event: ScheduleEvent): boolean {
  return Boolean(event.sourceSystem);
}

/** Wall-clock instant `minutes` into `dayStart` — same reading HorizonGrid uses for grabs. */
function atLocalMinutes(dayStart: Date, minutes: number): Date {
  const whole = Math.floor(minutes);
  const at = new Date(dayStart);
  at.setHours(Math.floor(whole / 60), whole % 60, 0, 0);

  return new Date(at.getTime() + Math.round((minutes - whole) * 60_000));
}

function blockLabel(event: ScheduleEvent, colorMode: ColorMode): string {
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

/** Ratio down a day column for a pointer event, from the column's own box. */
function ratioFor(event: { clientY: number; currentTarget: HTMLElement }): number {
  const box = event.currentTarget.getBoundingClientRect();

  return box.height === 0 ? 0 : (event.clientY - box.top) / box.height;
}

interface EventTooltipProps {
  event: ScheduleEvent;
  color: string;
  colorMode: ColorMode;
  movable: boolean;
}

function EventTooltipBody({ event, color, colorMode, movable }: EventTooltipProps) {
  const url = eventUrl(event);

  return (
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
      {describes(event) && <p className="text-[11px] leading-snug opacity-90">{event.description}</p>}
      {event.locationName && <p className="text-[10px] opacity-60">{event.locationName}</p>}
      {event.status === 'tentative' && <p className="text-[10px] opacity-60">Tentative</p>}
      <p className="flex items-center gap-1.5 text-[10px] opacity-60">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
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
  );
}

function ClusterBlock({
  item,
  lane,
  laneCount,
  colorMode,
}: {
  item: Extract<PackedItem, { kind: 'cluster' }>;
  lane: number;
  laneCount: number;
  colorMode: ColorMode;
}) {
  const lead = item.spans[0]?.event;
  const color = lead ? eventColor(lead, colorMode) : 'var(--activity-none)';
  const count = item.spans.length;
  const label = `${count} overlapping activities`;

  return (
    <EventPeek
      label={label}
      side="right"
      content={
        <div className="max-w-64 space-y-1 text-left">
          <p className="text-xs font-medium">{label}</p>
          <ul className="space-y-0.5">
            {item.spans.map(({ event }) => (
              <li key={event.id} className="text-[11px] leading-snug">
                <span className="font-medium">{event.title}</span>
                <span className="ml-1.5 text-[10px] opacity-75 tabular-nums">
                  {formatClock(new Date(event.startTime))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      }
    >
      <div
        role="listitem"
        data-schedule-chip
        tabIndex={0}
        aria-label={label}
        title={label}
        className={cn(
          'absolute z-[5] cursor-pointer overflow-hidden rounded-md border text-[11px] leading-5',
          'text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'hover:z-30 focus-within:z-30 hover:brightness-110',
        )}
        style={{
          top: `${item.leftPct}%`,
          height: `${Math.max(item.widthPct, (18 / GRID_HEIGHT_PX) * 100)}%`,
          left: `calc(${(lane / laneCount) * 100}% + 2px)`,
          width: `calc(${(1 / laneCount) * 100}% - 4px)`,
          backgroundColor: color,
          borderColor: chipBorder(color),
          borderLeftWidth: '3px',
          borderLeftColor: color,
        }}
      >
        <span className="px-1.5 font-semibold tabular-nums text-background mix-blend-difference">
          {count}
        </span>
      </div>
    </EventPeek>
  );
}

function TimedBlock({
  item,
  lane,
  laneCount,
  dayStart,
  colorMode,
  onMoveEvent,
}: {
  item: Extract<PackedItem, { kind: 'single' }>;
  lane: number;
  laneCount: number;
  dayStart: Date;
  colorMode: ColorMode;
  onMoveEvent?: (eventId: string, startTime: Date) => void;
}) {
  const { event, leftPct, widthPct, continuesFrom, continuesTo } = item.span;
  const color = eventColor(event, colorMode);
  const url = eventUrl(event);
  const movable = Boolean(onMoveEvent);
  const short = widthPct < (45 / MINUTES_PER_DAY) * 100;
  const label = blockLabel(event, colorMode);

  return (
    <EventPeek
      label={label}
      side="right"
      content={<EventTooltipBody event={event} color={color} colorMode={colorMode} movable={movable} />}
    >
      <div
        role="listitem"
        data-schedule-chip
        tabIndex={0}
        aria-label={label}
        draggable={movable}
        onDragStart={
          movable
            ? (e) => {
                if ((e.target as Element | null)?.closest?.('a')) {
                  e.preventDefault();

                  return;
                }

                const box = e.currentTarget.getBoundingClientRect();
                const withinChip = box.height > 0 ? (e.clientY - box.top) / box.height : 0;
                const grabDayRatio = (leftPct + Math.max(0, Math.min(1, withinChip)) * widthPct) / 100;
                const grabbedAt = atLocalMinutes(dayStart, grabDayRatio * MINUTES_PER_DAY);
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
          'absolute z-[5] overflow-hidden border text-[11px] leading-4',
          'text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'hover:z-30 focus-within:z-30',
          movable && 'cursor-grab active:cursor-grabbing hover:brightness-110',
          short ? 'px-1 py-0.5' : 'px-1.5 py-1',
          event.status === 'tentative' && 'border-dashed text-muted-foreground',
          continuesFrom ? 'rounded-t-none border-t-0' : 'rounded-t-md',
          continuesTo ? 'rounded-b-none border-b-0' : 'rounded-b-md',
        )}
        style={{
          top: `${leftPct}%`,
          height: `${widthPct}%`,
          left: `calc(${(lane / laneCount) * 100}% + 2px)`,
          width: `calc(${(1 / laneCount) * 100}% - 4px)`,
          backgroundColor: chipFill(color),
          borderColor: chipBorder(color),
          ...(continuesFrom ? {} : { borderLeftWidth: '3px', borderLeftColor: color }),
        }}
      >
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            className="block truncate font-medium text-foreground underline-offset-2 hover:underline"
            onClick={(clickEvent) => clickEvent.stopPropagation()}
            onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
          >
            {event.title}
          </a>
        ) : (
          <span className="block truncate font-medium">{event.title}</span>
        )}
        {!short && (
          <span className="block truncate text-[10px] tabular-nums text-muted-foreground">
            {formatClock(new Date(event.startTime))}
            {event.endTime ? ` – ${formatClock(new Date(event.endTime))}` : ''}
          </span>
        )}
      </div>
    </EventPeek>
  );
}

function AllDayChip({ event, colorMode }: { event: ScheduleEvent; colorMode: ColorMode }) {
  const color = eventColor(event, colorMode);
  const url = eventUrl(event);
  const label = blockLabel(event, colorMode);

  return (
    <EventPeek
      label={label}
      side="bottom"
      content={<EventTooltipBody event={event} color={color} colorMode={colorMode} movable={false} />}
    >
      <div
        role="listitem"
        data-schedule-chip
        tabIndex={0}
        aria-label={label}
        className={cn(
          'truncate rounded-md border px-1.5 py-0.5 text-[11px] leading-5',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          event.status === 'tentative' && 'border-dashed text-muted-foreground',
        )}
        style={{
          backgroundColor: chipFill(color),
          borderColor: chipBorder(color),
          borderLeftWidth: '3px',
          borderLeftColor: color,
        }}
      >
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
      </div>
    </EventPeek>
  );
}

interface RhythmStripProps {
  dayStart: Date;
  lookup: (utcDate: string) => RhythmDay | undefined;
  colorMode: ColorMode;
  /** True while nightly/Predict is in a named step and this day has no ink yet. */
  waiting?: boolean;
}

/**
 * Pattern rhythm (HBPE) for one day, stood on end beside the hours.
 *
 * The same reading the horizon draws as a lane, rotated to match this geometry:
 * one cell per 15-minute slot, the colour of the behaviour that claims it, the
 * weight in the ink. It sits immediately LEFT of the time labels rather than
 * behind the day column for two reasons — a wash under committed time is read
 * as a highlight on the chips sitting over it, and a rhythm cell only says
 * something once you can see which o'clock it belongs to.
 *
 * Cells are positioned rather than flexed so every one lands exactly on the
 * 15-minute slot it describes; a gapped flex column drifts by a cell over 96 slots.
 */
function RhythmStrip({ dayStart, lookup, colorMode, waiting = false }: RhythmStripProps) {
  const claims = useMemo(() => rhythmClaims(dayStart, lookup), [dayStart, lookup]);
  const slotCount = claims.length || 1;
  const clusters = useMemo(() => topClusters(lookup(utcDateKey(dayStart))), [dayStart, lookup]);
  const hasRhythm = claims.some((claim) => claim.weight >= RHYTHM_NOISE_FLOOR);
  const waitingForRhythm = waiting && !hasRhythm;
  const label = waitingForRhythm
    ? 'Predicted rhythm is still being built. This can take a while.'
    : rhythmLabel(dayStart, clusters);

  const strip = (
    <div
      data-testid="vertical-rhythm-strip"
      className="relative w-2 shrink-0 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ height: GRID_HEIGHT_PX }}
      // The cells carry no text, so collapsing them to one named image loses
      // nothing and gains a name. A strip with no signal is decoration unless
      // Predict is still running — then the shimmer is the only status.
      {...(hasRhythm || waitingForRhythm
        ? { role: 'img', 'aria-label': label, tabIndex: 0 }
        : { 'aria-hidden': true })}
    >
      {claims.map((claim, slot) => {
        const lit = claim.weight >= RHYTHM_NOISE_FLOOR;

        return (
          <div
            key={slot}
            className={cn(
              'absolute inset-x-0 rounded-[1px]',
              !lit && !waitingForRhythm && 'bg-foreground/[0.06]',
              !lit && waitingForRhythm && 'rhythm-cell-waiting',
            )}
            style={{
              top: `${(slot / slotCount) * 100}%`,
              height: `calc(${100 / slotCount}% - ${RHYTHM_CELL_GAP_PX}px)`,
              animationDelay: waitingForRhythm ? `${slot * 12}ms` : undefined,
              ...(lit
                ? {
                    // Type mode lets the cell wear the class of the behaviour
                    // that claims it. Source mode has nothing to say about a
                    // prediction — it came from no calendar — so it stays on
                    // the theme colour rather than inventing an answer.
                    backgroundColor: colorMode === 'type' ? classColor(claim.l0Class) : 'var(--primary)',
                    opacity: cellOpacity(claim.weight),
                  }
                : {}),
            }}
          />
        );
      })}
    </div>
  );

  if (!hasRhythm) {
    return strip;
  }

  return (
    <EventPeek
      label={label}
      side="right"
      content={
        <div className="w-52 space-y-1 text-left">
          <p className="text-xs font-medium">
            {dayStart.toLocaleDateString([], { weekday: 'long' })} — usually
          </p>
          {clusters.map((cluster) => (
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
          ))}
        </div>
      }
    >
      {strip}
    </EventPeek>
  );
}

interface DayLaneProps {
  dayStart: Date;
  dayEvents: ScheduleEvent[];
  isToday: boolean;
  nowPct: number | null;
  colorMode: ColorMode;
  onDropCandidate?: (candidateId: string, startTime: Date) => void;
  onMoveEvent?: (eventId: string, startTime: Date) => void;
}

const DayLane = memo(function DayLane({
  dayStart,
  dayEvents,
  isToday,
  nowPct,
  colorMode,
  onDropCandidate,
  onMoveEvent,
}: DayLaneProps) {
  const [dropPct, setDropPct] = useState<number | null>(null);
  const timedSpans = useMemo(
    () =>
      dayEvents
        .filter((event) => !event.isAllDay)
        .map((event) => spanForDay(event, dayStart))
        .filter((span): span is NonNullable<typeof span> => span !== null)
        .sort((a, b) => a.leftPct - b.leftPct),
    [dayEvents, dayStart],
  );
  const packed = useMemo(() => foldMicroClusters(timedSpans), [timedSpans]);
  const lanes = useMemo(() => packItemLanes(packed), [packed]);
  const laneCount = Math.max(1, ...lanes.map((lane) => lane + 1));
  const dayLabel = dayStart.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const acceptsDrops = Boolean(onDropCandidate ?? onMoveEvent);

  const handlePointerCandidate = useCallback(
    (id: string, ratio: number) => {
      onDropCandidate?.(id, dropInstant(dayStart, ratio));
    },
    [dayStart, onDropCandidate],
  );

  const handlePointerEvent = useCallback(
    (id: string, ratio: number, grabOffsetMs: number) => {
      onMoveEvent?.(id, movedStart(dayStart, ratio, grabOffsetMs));
    },
    [dayStart, onMoveEvent],
  );

  const { dropRef, dropAxis } = useScheduleDropTarget({
    axis: 'y',
    onDropCandidate: onDropCandidate ? handlePointerCandidate : undefined,
    onMoveEvent: onMoveEvent ? handlePointerEvent : undefined,
    onHoverPct: setDropPct,
  });

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
      ref={dropRef}
      {...dropAxis}
      role="listitem"
      aria-label={dayLabel}
      data-testid="vertical-day-lane"
      className="relative min-w-0 flex-1 border-l border-border/60"
      style={{ height: GRID_HEIGHT_PX }}
      onDragOver={
        acceptsDrops
          ? (e) => {
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
      {AXIS_HOURS.map((hour) => (
        <div
          key={hour}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 border-t',
            hour === 0 ? 'border-transparent' : hour === 12 ? 'border-border' : 'border-border/40',
          )}
          style={{ top: `${(hour / HOURS_PER_DAY) * 100}%` }}
        />
      ))}

      {isToday && nowPct !== null && (
        <div
          aria-hidden
          data-testid="vertical-now"
          className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
          style={{ top: `${nowPct}%` }}
        >
          <span className="absolute -left-1.5 h-2.5 w-2.5 rounded-full bg-destructive" />
          <span className="h-px w-full bg-destructive" />
        </div>
      )}

      {dropPct !== null && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-primary"
            style={{ top: `${dropPct}%` }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute left-1 z-20 -translate-y-1/2 rounded bg-primary px-1 py-px text-[10px] text-primary-foreground tabular-nums"
            style={{ top: `${dropPct}%` }}
          >
            {formatClock(dropInstant(dayStart, dropPct / 100))}
          </div>
        </>
      )}

      <div role="list" aria-label={`Committed time on ${dayLabel}`} className="absolute inset-0">
        {packed.map((item, index) =>
          item.kind === 'cluster' ? (
            <ClusterBlock
              key={`cluster-${item.leftPct}-${item.spans[0]?.event.id ?? index}`}
              item={item}
              lane={lanes[index]}
              laneCount={laneCount}
              colorMode={colorMode}
            />
          ) : (
            <TimedBlock
              key={`${item.span.event.id}-${dayStart.toDateString()}`}
              item={item}
              lane={lanes[index]}
              laneCount={laneCount}
              dayStart={dayStart}
              colorMode={colorMode}
              onMoveEvent={onMoveEvent}
            />
          ),
        )}
      </div>
    </div>
  );
});

interface VerticalCalendarProps {
  start: Date;
  days: number;
  events: ScheduleEvent[];
  rhythm: RhythmDay[];
  onDropCandidate?: (candidateId: string, startTime: Date) => void;
  onMoveEvent?: (eventId: string, startTime: Date) => void;
  selectedDay?: Date;
  onSelectDay?: (dayStart: Date) => void;
  colorMode?: ColorMode;
  /** Nightly/Predict is in a named step (`NIGHTLY:label`, …). Empty cells shimmer. */
  pipelineRunning?: boolean;
  footer?: ReactNode;
  className?: string;
}

/**
 * The week (or a single day), as hours-down / days-across.
 *
 * This is the conventional calendar geometry — Google Calendar, Apple Calendar,
 * Outlook. Timed blocks sit on a 24-hour column; all-day rows sit above it,
 * outside the scroll, so a busy all-day lane cannot shove one day's hours out
 * of line. This is the one schedule surface on the page: what the day is
 * predicted to hold rides in as a {@link RhythmStrip} beside the time axis
 * rather than as a second view of the same week.
 */
export function VerticalCalendar({
  start,
  days,
  events,
  rhythm,
  onDropCandidate,
  onMoveEvent,
  selectedDay,
  onSelectDay,
  colorMode = 'type',
  pipelineRunning = false,
  footer,
  className,
}: VerticalCalendarProps) {
  const now = new Date();
  const today = startOfLocalDay(now);
  const nowPct = ((now.getHours() * 60 + now.getMinutes()) / MINUTES_PER_DAY) * 100;
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const allDayByDayKey = useMemo(() => {
    const map = new Map<string, ScheduleEvent[]>();

    for (const dayStart of dayStarts) {
      const key = dayStart.toISOString();
      map.set(
        key,
        (eventsByDayKey.get(key) ?? []).filter((event) => event.isAllDay),
      );
    }

    return map;
  }, [dayStarts, eventsByDayKey]);

  useEffect(() => {
    const pane = scrollRef.current;

    if (!pane) {
      return;
    }

    const clock = new Date();
    const lookingAtToday = dayStarts.some((day) => sameLocalDay(day, clock));
    const minutes = lookingAtToday ? clock.getHours() * 60 + clock.getMinutes() : 7 * 60;
    const y = (minutes / MINUTES_PER_DAY) * GRID_HEIGHT_PX - pane.clientHeight / 3;
    pane.scrollTop = Math.max(0, y);
  }, [dayStarts]);

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
      aria-label="Calendar"
      data-testid="vertical-calendar"
      className={cn('flex flex-col overflow-hidden rounded-xl border border-border bg-card', className)}
    >
      {/* One-column views (phone Calendar) already name the day in WeekDayChips. */}
      {days > 1 ? (
        <div className="flex min-w-0 border-b border-border">
          <div className="w-16 shrink-0" />
          {dayStarts.map((dayStart) => {
            const isToday = sameLocalDay(dayStart, today);
            const isSelected = sameLocalDay(dayStart, selectedDay ?? today);
            const dayLabel = dayStart.toLocaleDateString([], {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            });

            return (
              <button
                key={dayStart.toISOString()}
                type="button"
                className={cn(
                  'flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-1.5',
                  'outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'bg-accent/20',
                )}
                aria-pressed={isSelected}
                aria-label={`Show ${dayLabel}`}
                onClick={() => onSelectDay?.(dayStart)}
              >
                <span
                  className={cn(
                    'text-[10px] font-medium uppercase tracking-wide',
                    isSelected || isToday ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {dayStart.toLocaleDateString([], { weekday: 'short' })}
                </span>
                <span
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums',
                    isToday && 'bg-primary text-primary-foreground',
                    isSelected && !isToday && 'bg-accent text-accent-foreground',
                  )}
                >
                  {dayStart.getDate()}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex min-w-0 border-b border-border">
        <div className="flex w-16 shrink-0 items-start justify-end pr-1.5 pt-1.5">
          <span className="text-[10px] leading-5 text-muted-foreground">All day</span>
        </div>
        {dayStarts.map((dayStart) => {
          const key = dayStart.toISOString();
          const allDay = allDayByDayKey.get(key) ?? [];
          const dayLabel = dayStart.toLocaleDateString([], { weekday: 'long' });

          return (
            // Mirrors the rhythm-strip + gap leading each day lane below, with
            // an unlabeled spacer in place of the strip, so the all-day chips
            // and the timed grid share the same left edge instead of the
            // all-day row drifting a rhythm-strip's width left of it.
            <div key={key} className="flex min-w-0 flex-1 gap-1 pl-1">
              <div aria-hidden className="w-2 shrink-0" />
              <div
                role="list"
                aria-label={`All day on ${dayLabel}`}
                className="flex min-h-10 min-w-0 flex-1 flex-col gap-0.5 border-l border-border/60 px-1 py-1"
              >
                {allDay.map((event) => (
                  <AllDayChip key={event.id} event={event} colorMode={colorMode} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        className="max-h-[min(70vh,calc(100vh-12rem))] overflow-auto"
        data-testid="vertical-calendar-scroll"
        {...{ [SCHEDULE_SCROLL_ATTR]: '' }}
      >
        <div className="flex min-w-0">
          {/* The hours the rhythm and the days both read against. Reading
              order per day is rhythm, then time, then what was committed —
              see the per-day wrapper below, where each day gets its own
              strip rather than one shared strip speaking for all of them. */}
          <div className="sticky left-0 z-10 flex w-16 shrink-0 items-start justify-end bg-card pr-1.5">
            <div className="relative w-full" style={{ height: GRID_HEIGHT_PX }}>
              {AXIS_HOURS.map((hour) => (
                <span
                  key={hour}
                  className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                  style={{ top: `${(hour / HOURS_PER_DAY) * 100}%` }}
                >
                  {hour === 0 ? '' : formatHour(hour)}
                </span>
              ))}
            </div>
          </div>

          <div role="list" aria-label="Days" className="flex min-w-0 flex-1">
            {dayStarts.map((dayStart) => {
              const key = dayStart.toISOString();
              const isToday = sameLocalDay(dayStart, today);

              return (
                <div key={key} className="flex min-w-0 flex-1 gap-1 pl-1">
                  <RhythmStrip
                    dayStart={dayStart}
                    lookup={lookup}
                    colorMode={colorMode}
                    waiting={pipelineRunning}
                  />
                  <DayLane
                    dayStart={dayStart}
                    dayEvents={eventsByDayKey.get(key) ?? []}
                    isToday={isToday}
                    nowPct={isToday ? nowPct : null}
                    colorMode={colorMode}
                    onDropCandidate={onDropCandidate ? handleDropCandidate : undefined}
                    onMoveEvent={onMoveEvent ? handleMoveEvent : undefined}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {footer && (
        <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">{footer}</div>
      )}
    </div>
  );
}

export { GRID_HEIGHT_PX, HOUR_HEIGHT_PX };
