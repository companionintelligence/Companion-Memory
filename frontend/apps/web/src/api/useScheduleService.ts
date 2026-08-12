import { useCallback, useMemo } from 'react';

import { gql, NetworkStatus, useQuery } from '@apollo/client';

import type { ProbabilityEntry } from './useForecastService';

// Committed time changes when a connector syncs, not second-to-second; the
// rhythm layer only moves on the nightly pipeline. Hourly is plenty.
const REFRESH_INTERVAL_MS = 60 * 60_000;

/**
 * The key HorizonGrid looks the rhythm lane up by.
 *
 * It keys on UTC dates rather than local ones because a daypart is a UTC band,
 * so the window's membership test has to be phrased in the same terms — a local
 * day touches up to two UTC dates.
 */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const GET_SCHEDULE = gql(`
  query GetSchedule($from: DateTime!, $to: DateTime!) {
    eventsInRange(from: $from, to: $to) {
      id
      title
      description
      startTime
      endTime
      isAllDay
      status
      category
      locationName
      sourceSystem
      externalSyncStatus
      metadata
    }
    weekForecast(includeToday: true) {
      generatedAt
      days {
        date
        dow
        clusters {
          clusterId
          name
          l0Class
          pOccur
          scheduled
          daypartProbs { label probability }
        }
      }
    }
  }
`);

/** A committed event — something that is actually on the calendar. */
export interface ScheduleEvent {
  id: string;
  title: string;
  /**
   * The event's own text. Worth showing because a title is often a bare
   * category word ("Action", "Goal") inherited from whatever produced it, while
   * the description carries what the thing actually is.
   */
  description: string | null;
  startTime: string;
  endTime: string | null;
  isAllDay: boolean;
  status: string;
  category: string | null;
  locationName: string | null;
  /** Connector this came from, or null when it was created here. */
  sourceSystem?: string | null;
  /** 'pending' once a local move has drifted ahead of that source. */
  externalSyncStatus?: string | null;
  /**
   * Capture metadata. Browser visits stash the page URL at `metadata.url`;
   * the schedule surface reads that to open the original page from a chip.
   */
  metadata?: Record<string, unknown> | null;
}

export interface RhythmCluster {
  clusterId: string;
  name: string;
  l0Class: string;
  pOccur: number;
  scheduled: boolean;
  daypartProbs: ProbabilityEntry[];
}

export interface RhythmDay {
  date: string;
  dow: string;
  clusters: RhythmCluster[];
}

interface ScheduleResult {
  events: ScheduleEvent[];
  /** Only the forecast days the drawn window can actually use. */
  rhythm: RhythmDay[];
  generatedAt: string | null;
  /**
   * Whether the rhythm layer describes the window being drawn.
   *
   * `weekForecast` takes no date arguments — it is always "the seven days from
   * today" — so paging to another week leaves the lane with nothing to draw.
   * Callers key their copy off this so the page cannot announce a live,
   * freshly-generated layer over an empty lane, which reads as "the model knows
   * nothing about you" rather than "this view cannot ask for that week".
   */
  rhythmCoversWindow: boolean;
  loading: boolean;
  /** True while a new window is being fetched (including week paging). */
  fetching: boolean;
  error: boolean;
  /** Re-read committed time — call after something is placed on the grid. */
  refetch: () => void;
}

interface QueryData {
  eventsInRange?: ScheduleEvent[] | null;
  weekForecast?: { generatedAt: string; days: RhythmDay[] } | null;
}

/**
 * The schedule surface's two data layers.
 *
 * `events` is committed fact; `rhythm` is the HBPE occurrence climate. They are
 * fetched together but never merged — the whole point of the page is that the
 * user can tell them apart. The rhythm layer is nullable by design: the forecast
 * resolver returns null when the `hbpe` flag is off or the engine is cold, and
 * the page still has something true to show without it.
 */
export function useScheduleService(from: Date, to: Date): ScheduleResult {
  const { data, loading, error, refetch, networkStatus } = useQuery<QueryData>(GET_SCHEDULE, {
    variables: { from: from.toISOString(), to: to.toISOString() },
    pollInterval: REFRESH_INTERVAL_MS,
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    // The two layers resolve independently, so a forecast that THROWS must not
    // take committed time down with it. The default 'none' discards the whole
    // payload the moment any field errors, which is exactly the case the
    // docstring above claims this hook survives; 'all' keeps whatever resolved
    // and reports the failure alongside it.
    errorPolicy: 'all',
  });

  const forecast = data?.weekForecast ?? null;
  const fromMs = from.getTime();
  const toMs = to.getTime();

  // The forecast is not window-scoped, so what comes back is keyed to the seven
  // days from today whatever was asked for. Days outside the window would just
  // miss every lookup in the grid and leave the lane blank — drop them here,
  // where the page can also be told about it, rather than let it fail silently.
  const rhythm = useMemo(() => {
    if (!forecast) {
      return [];
    }

    const first = utcDateKey(new Date(fromMs));
    const last = utcDateKey(new Date(toMs - 1));

    return forecast.days.filter((day) => day.date >= first && day.date <= last);
  }, [forecast, fromMs, toMs]);

  // The horizon runs forward from today, so it can only describe the window the
  // present moment falls in. Partial overlap (the tail of the previous window,
  // in a timezone west of UTC) still renders what it legitimately covers, but
  // does not count as coverage.
  const now = Date.now();
  const rhythmCoversWindow = rhythm.length > 0 && now >= fromMs && now < toMs;

  // Stable identity: this is handed to useScheduleCandidates as `onPlaced` and
  // to useRescheduleEvent as `onMoved`, both of which list it in useCallback
  // deps — a fresh arrow every render would churn every handler below it.
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);

  const fetching =
    networkStatus === NetworkStatus.setVariables || (networkStatus === NetworkStatus.loading && data == null);

  return {
    events: data?.eventsInRange ?? [],
    rhythm,
    generatedAt: forecast?.generatedAt ?? null,
    rhythmCoversWindow,
    loading,
    fetching,
    error: Boolean(error),
    refetch: reload,
  };
}
