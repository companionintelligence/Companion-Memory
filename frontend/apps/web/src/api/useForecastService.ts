import { gql, useQuery } from '@apollo/client';

const GET_FORECAST = gql(`
  query GetForecast($horizon: String) {
    forecast(horizon: $horizon) {
      horizon
      generatedAt
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
  buckets: ForecastBucket[];
}

export function useForecastService(horizon = '24h') {
  const { data, loading, error, refetch } = useQuery<{ forecast: ForecastResponse | null }>(GET_FORECAST, {
    variables: { horizon },
  });

  return [{ data: data?.forecast ?? null, loading, error }, { refetch: () => refetch({ horizon }) }] as const;
}
