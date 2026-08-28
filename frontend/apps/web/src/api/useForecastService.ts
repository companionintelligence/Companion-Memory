import { useEffect, useRef, useState } from 'react';

import { gql, useQuery } from '@apollo/client';

// How long to keep polling a non-READY forecast before giving up and showing an
// actionable empty state. The timer resets whenever the status *or* item
// progress advances, so genuine work (training can take about an hour) keeps
// polling; only a status that stays stuck this long stops.
const COLD_START_POLL_LIMIT_MS = 3 * 60_000; // stuck on COLD_START → likely no data / nothing running
const PROGRESS_POLL_LIMIT_MS = 2 * 60 * 60_000; // a BOOTSTRAP/NIGHTLY step that never advances

const GET_FORECAST = gql(`
  query GetForecast($horizon: String) {
    forecast(horizon: $horizon) {
      horizon
      generatedAt
      systemStatus
      modelVersion
      stillLearning
      pipelineEtaSeconds
      pipelineDetail
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
  modelVersion?: string | null;
  stillLearning?: boolean;
  pipelineEtaSeconds?: number | null;
  pipelineDetail?: string | null;
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

  // `stalled` = we stopped polling because the engine stayed non-READY too long
  // (e.g. HBPE is unhealthy / has no data). Lets the UI show a CTA instead of
  // spinning the 5s poll forever.
  const [stalled, setStalled] = useState(false);
  const pollStartRef = useRef<number | null>(null);
  const lastProgressKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const status = forecast?.systemStatus ?? null;
    const progressKey = status ? `${status}|${forecast?.pipelineDetail ?? ''}` : null;

    if (!forecast || status === 'READY') {
      pollStartRef.current = null;
      lastProgressKeyRef.current = null;
      setStalled(false);
      stopPolling();

      return;
    }

    const now = Date.now();
    // Reset the clock whenever the step or item count advances.
    if (progressKey !== lastProgressKeyRef.current) {
      lastProgressKeyRef.current = progressKey;
      pollStartRef.current = now;
    }

    const limit = status === 'COLD_START' ? COLD_START_POLL_LIMIT_MS : PROGRESS_POLL_LIMIT_MS;
    if (now - (pollStartRef.current ?? now) >= limit) {
      setStalled(true);
      stopPolling();
    } else {
      setStalled(false);
      startPolling(5000);
    }
  }, [forecast, startPolling, stopPolling]);

  return [{ data: forecast, loading, error, stalled }, { refetch: () => refetch({ horizon }) }] as const;
}
