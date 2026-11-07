import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

const GET_FORECAST_EXTRAS = gql`
  query GetForecastExtras {
    placeForecast(k: 5) {
      lat
      lng
      visits
      share
      label
      probability
      backoffLevel
    }
    predictionCalibration(limit: 14) {
      basis
      latest {
        l0Top1Acc
        ece
        driftFlag
        modelVersion
      }
    }
    forecastHistory(days: 5) {
      date
      buckets {
        bucketIndex
        predictedL0 {
          label
          probability
        }
        actualL0
      }
    }
  }
`;

interface ForecastExtrasData {
  placeForecast: Array<{
    lat: number;
    lng: number;
    visits: number;
    share: number;
    label: string | null;
    probability: number;
    backoffLevel: string | null;
  }>;
  predictionCalibration: {
    basis: string;
    latest: {
      l0Top1Acc: number | null;
      ece: number | null;
      driftFlag: boolean;
      modelVersion: string | null;
    } | null;
  } | null;
  forecastHistory: Array<{
    date: string;
    buckets: Array<{
      bucketIndex: number;
      predictedL0: Array<{ label: string; probability: number }>;
      actualL0: string | null;
    }>;
  }>;
}

export function useForecastExtras() {
  const { data, loading } = useQuery<ForecastExtrasData>(GET_FORECAST_EXTRAS, { errorPolicy: 'all' });

  return {
    loading,
    places: data?.placeForecast ?? [],
    calibration: data?.predictionCalibration ?? null,
    historyDays: data?.forecastHistory ?? [],
  };
}
