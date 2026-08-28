import { gql, useQuery } from '@apollo/client';

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
        driftFlag
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

export function useForecastExtras() {
  const { data, loading } = useQuery(GET_FORECAST_EXTRAS, { errorPolicy: 'all' });

  return {
    loading,
    places: data?.placeForecast ?? [],
    calibration: data?.predictionCalibration ?? null,
    historyDays: data?.forecastHistory ?? [],
  };
}
