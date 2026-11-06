import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import type { ProbabilityEntry } from './useForecastService';

// Refresh hourly — recurrence profiles only change on the nightly pipeline, so
// there is nothing to poll aggressively for (unlike the 24h histogram's
// bootstrap progress).
const REFRESH_INTERVAL_MS = 60 * 60_000;

const GET_WEEK_AHEAD = gql(`
  query GetWeekAhead {
    weekForecast {
      horizon
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
    dueForecast {
      generatedAt
      due {
        clusterId
        name
        l0Class
        lastSeen
        daysSinceLast
        medianIntervalDays
        dueInDays
        window
        overdue
        scheduledDate
        confidence
      }
    }
  }
`);

export interface WeekForecastCluster {
  clusterId: string;
  name: string;
  l0Class: string;
  pOccur: number;
  scheduled: boolean;
  daypartProbs: ProbabilityEntry[];
}

export interface WeekForecastDay {
  date: string;
  dow: string;
  clusters: WeekForecastCluster[];
}

export interface WeekForecast {
  horizon: string;
  generatedAt: string;
  days: WeekForecastDay[];
}

export interface DueItem {
  clusterId: string;
  name: string;
  l0Class: string;
  lastSeen: string;
  daysSinceLast: number;
  medianIntervalDays: number;
  dueInDays: number;
  window: number[];
  overdue: boolean;
  scheduledDate: string | null;
  confidence: number;
}

export interface DueForecast {
  generatedAt: string;
  due: DueItem[];
}

export function useWeekAheadService() {
  const { data, previousData, loading, error } = useQuery<{
    weekForecast: WeekForecast | null;
    dueForecast: DueForecast | null;
  }>(GET_WEEK_AHEAD, {
    errorPolicy: 'all',
    pollInterval: REFRESH_INTERVAL_MS,
  });

  // Fall back to the last successful response so a transient poll error never
  // unmounts the card.
  const week = data?.weekForecast ?? previousData?.weekForecast ?? null;
  const due = data?.dueForecast ?? previousData?.dueForecast ?? null;

  return { week, due, loading, error } as const;
}
