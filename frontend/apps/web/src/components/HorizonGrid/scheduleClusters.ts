import type { ScheduleEvent } from '@/api/useScheduleService';

/**
 * How the day row folds dense capture piles without growing without bound.
 *
 * Browser visits land as dozens of short ticks. Transitive overlap merging
 * ("A overlaps B overlaps C…") used to paint one bar across the whole day —
 * instead we bucket micros by start time into short windows, and draw each
 * clump as a compact chip. Expanding a day reveals the underlying singles.
 */

/** Below this share of the day a chip is a tick, not a block that can hold a title. */
export const NARROW_SPAN_PCT = 7;

/**
 * Bucket width for folding micros (~30 minutes of the day).
 * Visits in the same window become one stack chip.
 */
export const CLUSTER_BUCKET_PCT = (30 / (24 * 60)) * 100;

/** Painted width of a stack chip — a marker, not a duration bar. */
export const CLUSTER_CHIP_WIDTH_PCT = 2.2;

/** Cap for a lone micro/browser chip so a bad endTime cannot bar the day. */
export const MICRO_CHIP_MAX_WIDTH_PCT = 2.8;

/** Visible lanes in the collapsed day row (scrolls internally past this). */
export const MAX_VISIBLE_LANES = 8;

/** Visible lanes after the user expands a day. */
export const MAX_EXPANDED_LANES = 18;

export const LANE_HEIGHT_PX = 28;
export const LANE_GAP_PX = 2;

function lanesHeight(count: number): number {
  return count * LANE_HEIGHT_PX + Math.max(0, count - 1) * LANE_GAP_PX;
}

/** Collapsed max height of the committed lane stack. */
export const DAY_LANES_MAX_HEIGHT_PX = lanesHeight(MAX_VISIBLE_LANES);

/** Expanded max height — still capped so one day cannot own the page. */
export const DAY_LANES_EXPANDED_MAX_HEIGHT_PX = lanesHeight(MAX_EXPANDED_LANES);

const LANE_EPSILON_PCT = 1e-9;

export interface EventSpan {
  event: ScheduleEvent;
  leftPct: number;
  widthPct: number;
  continuesFrom: boolean;
  continuesTo: boolean;
}

export type PackedItem =
  | { kind: 'single'; span: EventSpan; leftPct: number; widthPct: number }
  | {
      kind: 'cluster';
      spans: EventSpan[];
      leftPct: number;
      widthPct: number;
      continuesFrom: boolean;
      continuesTo: boolean;
    };

/** Capture / browser ticks — the pile that blows day height. */
export function isBrowserCapture(event: ScheduleEvent): boolean {
  const system = (event.sourceSystem ?? '').toLowerCase();

  return system.includes('browser') || system.includes('extension');
}

/**
 * Short ticks and browser captures are foldable; calendar blocks stay solo so a
 * meeting never disappears into a "+40 visits" stack.
 */
export function isMicroSpan(span: EventSpan): boolean {
  if (span.event.isAllDay) {
    return false;
  }

  return span.widthPct < NARROW_SPAN_PCT || isBrowserCapture(span.event);
}

/** Visual width for a lone micro — never a day-spanning bar. */
export function cappedMicroWidth(span: EventSpan): number {
  return Math.min(span.widthPct, MICRO_CHIP_MAX_WIDTH_PCT);
}

function singleItem(span: EventSpan): Extract<PackedItem, { kind: 'single' }> {
  if (isMicroSpan(span)) {
    const widthPct = cappedMicroWidth(span);

    return {
      kind: 'single',
      span: { ...span, widthPct },
      leftPct: span.leftPct,
      widthPct,
    };
  }

  return { kind: 'single', span, leftPct: span.leftPct, widthPct: span.widthPct };
}

/**
 * Merge micros whose starts fall within a short window of the clump's first
 * start. Meetings stay solo. Unlike transitive overlap merging, a day-long
 * chain of hourly ticks becomes many small clumps — each chip is a fixed
 * marker, never the union of the whole day.
 */
export function foldMicroClusters(spans: readonly EventSpan[]): PackedItem[] {
  const sorted = [...spans].sort((a, b) => a.leftPct - b.leftPct || a.widthPct - b.widthPct);
  const items: PackedItem[] = [];
  let open: EventSpan[] | null = null;
  let openLeft = 0;

  const flush = () => {
    if (!open) {
      return;
    }

    if (open.length === 1) {
      items.push(singleItem(open[0]));
    } else {
      items.push({
        kind: 'cluster',
        spans: open,
        leftPct: openLeft,
        widthPct: CLUSTER_CHIP_WIDTH_PCT,
        continuesFrom: false,
        continuesTo: false,
      });
    }

    open = null;
  };

  for (const span of sorted) {
    if (!isMicroSpan(span)) {
      flush();
      items.push(singleItem(span));
      continue;
    }

    if (!open) {
      open = [span];
      openLeft = span.leftPct;
      continue;
    }

    // Join only while still near the clump's anchor start — not via a chain of
    // edge-overlaps that can crawl across the whole day.
    if (span.leftPct - openLeft <= CLUSTER_BUCKET_PCT + LANE_EPSILON_PCT) {
      open.push(span);
    } else {
      flush();
      open = [span];
      openLeft = span.leftPct;
    }
  }

  flush();

  return items;
}

/**
 * Expanded day: every event as its own chip (micros still width-capped) so the
 * user can see what the stacks were hiding.
 */
export function unpackToSingles(spans: readonly EventSpan[]): PackedItem[] {
  return [...spans].map(singleItem).sort((a, b) => a.leftPct - b.leftPct || a.widthPct - b.widthPct);
}

/**
 * Lowest free lane per packed item (same greedy sweep as classic chip packing).
 */
export function packItemLanes(items: readonly PackedItem[]): number[] {
  const laneEnds: number[] = [];

  return items.map((item) => {
    const right = item.leftPct + item.widthPct;
    const lane = laneEnds.findIndex((end) => end <= item.leftPct + LANE_EPSILON_PCT);

    if (lane === -1) {
      laneEnds.push(right);

      return laneEnds.length - 1;
    }

    laneEnds[lane] = Math.max(laneEnds[lane], right);

    return lane;
  });
}

export function stackHeightPx(laneCount: number): number {
  return lanesHeight(Math.max(1, laneCount));
}
