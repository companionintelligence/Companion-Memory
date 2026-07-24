import { useEffect, useMemo, useRef, useState } from 'react';

import { useQuery } from '@apollo/client';
import { cn } from '@ci/shadcn';
import { useSearchParams } from 'react-router-dom';

import { TimelineGrid } from '@/components/TimelineGrid/TimelineGrid';
import {
  TimelineGridSelectionProvider,
  useTimelineGridSelection,
} from '@/components/TimelineGrid/useTimelineGridSelection';
import type { TimelineGridRange } from '@/components/TimelineGrid/useTimelineGridSelection';
import { gql } from '@/graphql';

// The rollup table only holds days that actually have activity, so an
// effectively-unbounded start fetches the user's whole history in one query —
// the earliest returned bucket then bounds how far back the grid can scroll.
const HISTORY_START = '1970-01-01';

const ACTIVITY_TIMELINE = gql(`
  query ActivityTimeline($start: String!, $end: String!) {
    activityTimeline(start: $start, end: $end) {
      date
      count
    }
  }
`);

// ── `yyyy-MM-dd` day keys ↔ the `from`/`to` ISO URL params ────────────────────

// The grid works in local calendar days while the advanced date filter stores
// full ISO instants, so the rail converts at the boundary using the same
// local-day + start/end-of-day semantics as the toolbar's DateControl.

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}-${m}-${d}`;
}

function dayBoundIso(key: string, bound: 'start' | 'end'): string {
  const [y, m, d] = key.split('-').map(Number);

  return bound === 'start'
    ? new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
    : new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function dayKeyFromIso(value: string): string | null {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : localDayKey(date);
}

/**
 * The grid can only represent a closed range, so open-ended or malformed
 * `from`/`to` pairs read as no selection (the filter itself still applies).
 */
function rangeFromParams(from: string | null, to: string | null): TimelineGridRange | null {
  if (!from || !to) {
    return null;
  }

  const start = dayKeyFromIso(from);
  const end = dayKeyFromIso(to);

  return start && end ? { start, end } : null;
}

function sameRange(a: TimelineGridRange | null, b: TimelineGridRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

// ── Rail ──────────────────────────────────────────────────────────────────────

function RailContent() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ selection }, { setSelection }] = useTimelineGridSelection();

  // Stable for the mount — a midnight rollover mid-session just means the new
  // day appears on the next visit, same as the 15-minute rollup lag.
  const [endKey] = useState(() => localDayKey(new Date()));

  const { data } = useQuery(ACTIVITY_TIMELINE, {
    variables: { start: HISTORY_START, end: endKey },
  });

  const buckets = data?.activityTimeline;
  // Buckets come back ordered by day, so the first one is the scroll bound.
  // Until data arrives (or when there is none) the bound collapses to today,
  // which just disables scrolling into the past.
  const startKey = buckets?.[0]?.date ?? endKey;

  const paramsRange = useMemo(
    () => rangeFromParams(searchParams.get('from'), searchParams.get('to')),
    [searchParams],
  );

  // The last range both sides agreed on. Whichever side has since moved away
  // from it is the one that acted, and decides the sync direction — so an
  // external edit/clear/restore of `from`/`to` re-derives the grid selection,
  // while a fresh drag on the grid writes the params.
  const syncedRangeRef = useRef<TimelineGridRange | null>(null);

  useEffect(() => {
    if (sameRange(selection, paramsRange)) {
      syncedRangeRef.current = selection;

      return;
    }

    if (sameRange(selection, syncedRangeRef.current)) {
      setSelection(paramsRange);
      syncedRangeRef.current = paramsRange;

      return;
    }

    syncedRangeRef.current = selection;

    // The grid has no clear gesture — a null selection only ever mirrors
    // already-cleared params, so there is nothing to write back.
    if (!selection) {
      return;
    }

    // Whole days, matching DateControl's collapsed (no specific time) state.
    // Day-granular comparison above means re-dragging the same days over a
    // params range that carries specific times won't clobber those times.
    setSearchParams((params) => {
      params.set('from', dayBoundIso(selection.start, 'start'));
      params.set('to', dayBoundIso(selection.end, 'end'));

      return params;
    });
  }, [selection, paramsRange, setSelection, setSearchParams]);

  return <TimelineGrid data={buckets} start={startKey} end={endKey} className="min-h-0 flex-1" />;
}

/**
 * Left-hand rail for the Memory list view: the activity heatmap fed by the
 * `activityTimeline` rollup query. Wheel-scrolling the grid moves its visible
 * window through time; dragging a day range applies it as the advanced
 * search's `from`/`to` date filter (and stays in sync when that filter is
 * changed or cleared elsewhere).
 */
export function ActivityTimelineRail({ className }: { className?: string }) {
  return (
    <TimelineGridSelectionProvider args={[]}>
      <div className={cn('flex min-h-0 flex-col px-3 py-2', className)}>
        <RailContent />
      </div>
    </TimelineGridSelectionProvider>
  );
}
