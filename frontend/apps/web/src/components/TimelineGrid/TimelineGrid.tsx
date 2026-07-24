import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { cn } from '@ci/shadcn';

import { useTimelineGridSelection } from './useTimelineGridSelection';
import type { TimelineGridRange } from './useTimelineGridSelection';

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS_PER_WEEK = 7;

/** Only Mon/Wed/Fri are labeled, GitHub-style, so tight columns stay legible. */
const WEEKDAY_LETTERS = ['', 'M', '', 'W', '', 'F', ''];

const CELL_GAP_PX = 3;
const DEFAULT_CELL_PX = 12;

/**
 * Sequential ramp: one hue, light → dark. Index 0 is "no activity" — in light
 * mode `bg-muted` (oklch 0.97) all but disappears against the page, so empty
 * cells use a muted-foreground tint there and keep `bg-muted` in dark mode.
 */
const LEVEL_CLASSES = [
  'bg-muted-foreground/20 dark:bg-muted',
  'bg-primary/30',
  'bg-primary/55',
  'bg-primary/80',
  'bg-primary',
] as const;

/**
 * Selected cells swap to this azure ramp with the same progression, so range
 * membership reads as a hue change while density stays legible. Index 0 is a
 * faint tint rather than `bg-muted` so empty selected days still show as part
 * of the range.
 */
const SELECTED_LEVEL_CLASSES = [
  'bg-[#029cfd]/15',
  'bg-[#029cfd]/30',
  'bg-[#029cfd]/55',
  'bg-[#029cfd]/80',
  'bg-[#029cfd]',
] as const;

const MAX_LEVEL = LEVEL_CLASSES.length - 1;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TimelineGridDatum {
  /** Local calendar day, `yyyy-MM-dd`. */
  date: string;
  count: number;
}

export interface TimelineGridProps {
  data?: TimelineGridDatum[];
  /**
   * Earliest day scrolling may reach back to. Unbounded when omitted. Purely a
   * scroll floor: the grid always fills its height with week rows, so days
   * before `start` can still appear as empty cells.
   */
  start?: string;
  /** Last day shown. Defaults to today. */
  end?: string;
  /** Square cell edge in px. Fixed — a shorter container shows fewer weeks, not smaller cells. */
  cellSize?: number;
  /**
   * Fires with the visible window (inclusive `yyyy-MM-dd` keys) whenever it
   * changes — after the initial measure, on scroll, and on resize. The window
   * is always whole weeks, so it can pad a few days past `end` or before
   * `start`.
   */
  onTimeRangeChange?: (range: TimelineGridRange) => void;
  className?: string;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Keys are local-calendar `yyyy-MM-dd` strings; their lexicographic order is
// chronological order, so range membership is plain string comparison.

function toKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}-${m}-${d}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);

  return new Date(y, m - 1, d);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function orderRange(a: string, b: string): TimelineGridRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/**
 * The endpoint a shift-click keeps as its anchor: the one farther from the
 * clicked day, so the range grows (or shrinks) toward the click. Ties keep
 * `start`.
 */
function fartherEndpoint(range: TimelineGridRange, key: string): string {
  const clicked = fromKey(key).getTime();
  const toStart = Math.abs(clicked - fromKey(range.start).getTime());
  const toEnd = Math.abs(clicked - fromKey(range.end).getTime());

  return toStart >= toEnd ? range.start : range.end;
}

function formatDay(key: string): string {
  return fromKey(key).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Grid cell ─────────────────────────────────────────────────────────────────

interface GridCellProps {
  dayKey: string;
  count: number;
  level: number;
  selected: boolean;
  endpoint: boolean;
  onCellPointerDown: (key: string, e: ReactPointerEvent<HTMLButtonElement>) => void;
  onCellPointerEnter: (key: string, e: ReactPointerEvent<HTMLButtonElement>) => void;
}

/**
 * Memoized so drag-selection re-renders only touch cells whose props actually
 * changed — one Radix tooltip per cell made dragging across the grid lag badly,
 * so hover details live in a single overlay owned by the parent instead.
 */
const GridCell = memo(function GridCell({
  dayKey,
  count,
  level,
  selected,
  endpoint,
  onCellPointerDown,
  onCellPointerEnter,
}: GridCellProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${count} on ${formatDay(dayKey)}`}
      onPointerDown={(e) => onCellPointerDown(dayKey, e)}
      onPointerEnter={(e) => onCellPointerEnter(dayKey, e)}
      className={cn(
        'rounded-[2px]',
        (selected ? SELECTED_LEVEL_CLASSES : LEVEL_CLASSES)[level],
        // Endpoints ring in the theme's mid-grey ring token — neutral against
        // both the teal (unselected) and azure (selected) ramps, without the
        // harshness a foreground(black/white) ring had next to them.
        endpoint ? 'relative z-10 ring-2 ring-ring' : 'hover:ring-1 hover:ring-foreground/40',
      )}
    />
  );
});

// ── Public component ──────────────────────────────────────────────────────────

/**
 * Vertical contribution-style heatmap: the newest week sits at the top and
 * time runs downward into the past, weekdays left → right. Cells are a fixed
 * size — the height the component is given decides how many weeks of history
 * are visible, walking back from `end`. Click or drag cells to pick an
 * inclusive start/end day range; shift-click (or shift-drag) extends the
 * existing range toward the click. Mouse-wheel scrolling moves the window
 * through time — down into the past, up back toward `end` — and reports each
 * visible window through `onTimeRangeChange`.
 *
 * Selection state lives in {@link TimelineGridSelectionProvider} — the grid must
 * render under one, and siblings can read or clear the range through
 * `useTimelineGridSelection`.
 */
export function TimelineGrid({
  data = [],
  start,
  end,
  cellSize = DEFAULT_CELL_PX,
  onTimeRangeChange,
  className,
}: TimelineGridProps) {
  const endKey = end ?? toKey(new Date());

  // ── Visible window ──

  // The measured height of the grid area decides how many week-rows fit.
  const gridAreaRef = useRef<HTMLDivElement | null>(null);
  const [fitWeeks, setFitWeeks] = useState(52);
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    const el = gridAreaRef.current;
    if (!el) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const fit = Math.floor((entry.contentRect.height + CELL_GAP_PX) / (cellSize + CELL_GAP_PX));
      setFitWeeks(Math.max(1, fit));
      setMeasured(true);
    });

    observer.observe(el);

    return () => observer.disconnect();
  }, [cellSize]);

  // ── Scrolling through time ──

  // How many whole week-rows the window is scrolled back from `end`. Raw state
  // is clamped on read, so a resize that shrinks the reachable past needs no
  // corrective effect.
  const [backWeeks, setBackWeeks] = useState(0);

  useEffect(() => setBackWeeks(0), [endKey]);

  const maxBackWeeks = useMemo(() => {
    if (!start) {
      return Number.POSITIVE_INFINITY;
    }

    const endDate = fromKey(endKey);
    const endWeekStart = addDays(endDate, -endDate.getDay());
    const startDate = fromKey(start);
    const startWeekStart = addDays(startDate, -startDate.getDay());
    // Rounded because DST shifts make week spans slightly off 7×24h.
    const totalWeeks =
      Math.round((endWeekStart.getTime() - startWeekStart.getTime()) / (DAYS_PER_WEEK * 86_400_000)) + 1;

    return Math.max(0, totalWeeks - fitWeeks);
  }, [start, endKey, fitWeeks]);

  const clampedBackWeeks = Math.min(backWeeks, maxBackWeeks);

  /** Last day of the visible window — `end` shifted back by whole weeks. */
  const viewEndKey =
    clampedBackWeeks === 0 ? endKey : toKey(addDays(fromKey(endKey), -DAYS_PER_WEEK * clampedBackWeeks));

  const weeks = useMemo(() => {
    const endDate = fromKey(viewEndKey);
    const firstWeekStart = addDays(addDays(endDate, -endDate.getDay()), -DAYS_PER_WEEK * (fitWeeks - 1));

    // Always a full fitWeeks × 7 matrix — `start` only floors the scrolling
    // (maxBackWeeks), so a container taller than the history pads the top with
    // ordinary zero-count cells rather than rendering a shorter grid.
    const out: string[][] = [];
    let cursor = firstWeekStart;

    while (toKey(cursor) <= viewEndKey) {
      const week: string[] = [];
      for (let i = 0; i < DAYS_PER_WEEK; i++) {
        week.push(toKey(cursor));
        cursor = addDays(cursor, 1);
      }

      out.push(week);
    }

    return out;
  }, [start, viewEndKey, fitWeeks]);

  /** Bounds of the visible matrix — its chronologically first and last cells. */
  const visibleStartKey = weeks[0]?.[0] ?? viewEndKey;
  const visibleEndKey = weeks[weeks.length - 1]?.[DAYS_PER_WEEK - 1] ?? viewEndKey;
  const rowCount = weeks.length;

  /** Weeks in render order — newest first, so "now" sits at the top. */
  const displayWeeks = useMemo(() => [...weeks].reverse(), [weeks]);

  /**
   * Month labels as display-row spans `[start, end)`. Found chronologically
   * (a label where a month's 1st lands, spanning to the next label), then
   * mirrored into the reversed render order.
   */
  const monthLabels = useMemo(() => {
    const labels = new Map<number, string>();

    weeks.forEach((week, i) => {
      const firstOfMonth = week.find((key) => fromKey(key).getDate() === 1);
      if (firstOfMonth) {
        labels.set(i, fromKey(firstOfMonth).toLocaleDateString(undefined, { month: 'short' }));
      }
    });

    // Anchor the chronological start — the display bottom — even when the
    // window doesn't open on a month boundary.
    if (!labels.has(0)) {
      labels.set(0, fromKey(visibleStartKey).toLocaleDateString(undefined, { month: 'short' }));
    }

    const sorted = [...labels.entries()].sort(([a], [b]) => a - b);

    return sorted.map(([row, label], i) => {
      const nextRow = sorted[i + 1]?.[0] ?? rowCount;

      return { start: rowCount - nextRow, end: rowCount - row, label };
    });
  }, [weeks, rowCount, visibleStartKey]);

  // ── Intensity ──

  const counts = useMemo(() => new Map(data.map((d) => [d.date, d.count])), [data]);

  const maxCount = useMemo(() => {
    let max = 0;
    for (const [key, count] of counts) {
      if (key >= visibleStartKey && key <= visibleEndKey && count > max) {
        max = count;
      }
    }

    return max;
  }, [counts, visibleStartKey, visibleEndKey]);

  const levelFor = (count: number): number =>
    count <= 0 || maxCount === 0 ? 0 : Math.max(1, Math.ceil((count / maxCount) * MAX_LEVEL));

  // ── Selection ──

  const [{ selection }, { setSelection }] = useTimelineGridSelection();

  const [dragAnchor, setDragAnchor] = useState<string | null>(null);
  const [dragHead, setDragHead] = useState<string | null>(null);

  // Mirrors dragAnchor so the pointer handlers can stay referentially stable —
  // if they closed over dragAnchor, every memoized cell would re-render per drag step.
  const dragAnchorRef = useRef<string | null>(null);

  // Same referential-stability trick for the selection, read on shift-click.
  const selectionRef = useRef(selection);

  useEffect(() => {
    selectionRef.current = selection;
  });

  const [hovered, setHovered] = useState<{ key: string; rect: DOMRect } | null>(null);

  const handleCellPointerDown = useCallback((key: string, e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    // Touch implicitly captures the pointer, which would keep pointerenter
    // from reaching sibling cells mid-drag.
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // Shift-click extends the existing range instead of starting a new one:
    // it anchors on the endpoint farther from the click, so releasing (or
    // continuing to drag) spans from there to the pointer.
    const current = selectionRef.current;
    const anchor = e.shiftKey && current ? fartherEndpoint(current, key) : key;
    dragAnchorRef.current = anchor;
    setDragAnchor(anchor);
    setDragHead(key);
  }, []);

  const handleCellPointerEnter = useCallback((key: string, e: ReactPointerEvent<HTMLButtonElement>) => {
    setHovered({ key, rect: e.currentTarget.getBoundingClientRect() });
    if (dragAnchorRef.current) {
      setDragHead(key);
    }
  }, []);

  useEffect(() => {
    if (!dragAnchor || !dragHead) {
      return;
    }

    const onPointerUp = () => {
      setSelection(orderRange(dragAnchor, dragHead));
      dragAnchorRef.current = null;
      setDragAnchor(null);
      setDragHead(null);
    };

    window.addEventListener('pointerup', onPointerUp);

    return () => window.removeEventListener('pointerup', onPointerUp);
  }, [dragAnchor, dragHead, setSelection]);

  // Native listener because React registers `onWheel` passively, which makes
  // preventDefault a no-op and would let the page scroll along with the grid.
  useEffect(() => {
    const el = gridAreaRef.current;
    if (!el || maxBackWeeks === 0) {
      return;
    }

    const stepPx = cellSize + CELL_GAP_PX;
    let acc = 0;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Non-pixel delta modes (lines/pages) treat one unit as one week-row.
      acc += e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * stepPx;
      const weeksDelta = Math.trunc(acc / stepPx);
      if (weeksDelta === 0) {
        return;
      }

      acc -= weeksDelta * stepPx;
      // Newest rows sit at the top, so scrolling down (positive delta) moves
      // into the past and up comes back toward `end`.
      setBackWeeks((prev) => Math.min(Math.max(Math.min(prev, maxBackWeeks) + weeksDelta, 0), maxBackWeeks));
      // The grid shifts under a stationary pointer, so the hover rect is stale.
      setHovered(null);
    };

    el.addEventListener('wheel', onWheel, { passive: false });

    return () => el.removeEventListener('wheel', onWheel);
  }, [cellSize, maxBackWeeks]);

  // Ref-forwarded so an inline callback prop doesn't retrigger the emit effect.
  const onTimeRangeChangeRef = useRef(onTimeRangeChange);

  useEffect(() => {
    onTimeRangeChangeRef.current = onTimeRangeChange;
  });

  useEffect(() => {
    if (!measured) {
      return;
    }

    onTimeRangeChangeRef.current?.({ start: visibleStartKey, end: visibleEndKey });
  }, [measured, visibleStartKey, visibleEndKey]);

  const activeRange = dragAnchor && dragHead ? orderRange(dragAnchor, dragHead) : selection;

  // ── Render ──

  return (
    <div className={cn('flex h-full min-h-0 w-fit select-none flex-col gap-2', className)}>
      {/* Weekday header */}
      <div className="flex gap-1.5">
        <div className="w-4 shrink-0" />
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${DAYS_PER_WEEK}, ${cellSize}px)`,
            columnGap: CELL_GAP_PX,
          }}
        >
          {WEEKDAY_LETTERS.map((letter, i) => (
            <span key={i} className="text-center text-[10px] leading-none text-muted-foreground">
              {letter}
            </span>
          ))}
        </div>
      </div>

      {/* Month gutter + cell grid */}
      <div ref={gridAreaRef} className="flex min-h-0 flex-1 gap-1.5">
        {/*
         * Labels read bottom-to-top (vertical-rl flipped 180°). Each one spans
         * from its month's first week-row down to the next label's row and
         * clips, so it can never overlap a neighbor or run past the grid.
         */}
        <div
          className="grid w-4 shrink-0 self-start"
          style={{ gridTemplateRows: `repeat(${rowCount}, ${cellSize}px)`, rowGap: CELL_GAP_PX }}
        >
          {monthLabels.map(({ start, end, label }) => (
            <div
              key={start}
              className="flex items-start justify-end overflow-hidden pr-1"
              style={{ gridRowStart: start + 1, gridRowEnd: end + 1 }}
            >
              <span className="rotate-180 text-[10px] leading-none text-muted-foreground [writing-mode:vertical-rl]">
                {label}
              </span>
            </div>
          ))}
        </div>

        <div
          className="grid touch-none self-start"
          style={{
            gridTemplateRows: `repeat(${rowCount}, ${cellSize}px)`,
            gridTemplateColumns: `repeat(${DAYS_PER_WEEK}, ${cellSize}px)`,
            gap: CELL_GAP_PX,
          }}
          onPointerLeave={() => setHovered(null)}
        >
          {displayWeeks.flat().map((dayKey) => {
            const count = counts.get(dayKey) ?? 0;
            const inRange = activeRange && dayKey >= activeRange.start && dayKey <= activeRange.end;
            const isEndpoint = activeRange && (dayKey === activeRange.start || dayKey === activeRange.end);

            return (
              <GridCell
                key={dayKey}
                dayKey={dayKey}
                count={count}
                level={levelFor(count)}
                selected={Boolean(inRange)}
                endpoint={Boolean(isEndpoint)}
                onCellPointerDown={handleCellPointerDown}
                onCellPointerEnter={handleCellPointerEnter}
              />
            );
          })}
        </div>
      </div>

      {/* Single floating tooltip for whichever cell is hovered */}
      {hovered && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-md bg-primary px-2.5 py-1 text-xs whitespace-nowrap text-primary-foreground shadow-md"
          style={{
            left: hovered.rect.right + 8,
            top: hovered.rect.top + hovered.rect.height / 2,
          }}
        >
          <span className="font-semibold tabular-nums">{counts.get(hovered.key) ?? 0}</span> ·{' '}
          {formatDay(hovered.key)}
        </div>
      )}
    </div>
  );
}
