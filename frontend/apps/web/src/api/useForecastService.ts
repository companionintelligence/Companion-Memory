import { useEffect } from 'react';

import { gql, useQuery } from '@apollo/client';

const GET_FORECAST = gql(`
  query GetForecast($horizon: String) {
    forecast(horizon: $horizon) {
      horizon
      generatedAt
      systemStatus
      buckets {
        bucketIndex
        startTime
        l0Probs { label probability }
        l1Probs { label probability }
        l2Probs { label probability }
        q10
        q50
        q90
      }
    }
  }
`);

export interface ProbabilityEntry {
  label: string;
  probability: number;
}

export interface ForecastBucket {
  bucketIndex: number;
  startTime: string;
  l0Probs: ProbabilityEntry[];
  l1Probs: ProbabilityEntry[];
  l2Probs: ProbabilityEntry[] | null;
  q10: number;
  q50: number;
  q90: number;
}

export interface ForecastResponse {
  horizon: string;
  generatedAt: string;
  systemStatus: string;
  buckets: ForecastBucket[];
}

export function useForecastService(horizon = '24h') {
  const { data, previousData, loading, error, refetch, startPolling, stopPolling } = useQuery<{
    forecast: ForecastResponse | null;
  }>(GET_FORECAST, {
    variables: { horizon },
    // errorPolicy 'all' keeps previousData populated when a poll errors, so a
    // transient /histogram failure doesn't unmount the strip.
    errorPolicy: 'all',
    notifyOnNetworkStatusChange: true,
  });

  // Fall back to the last successful response when the current poll returned
  // null (resolver swallowed an HBPE error) — avoids flicker.
  const forecast = data?.forecast ?? previousData?.forecast ?? null;

  useEffect(() => {
    if (forecast && forecast.systemStatus !== 'READY') {
      startPolling(5000);
    } else {
      stopPolling();
    }
  }, [forecast, startPolling, stopPolling]);

  return [{ data: forecast, loading, error }, { refetch: () => refetch({ horizon }) }] as const;
}
