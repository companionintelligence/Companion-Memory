import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ForecastPage } from './ForecastPage';

const h = vi.hoisted(() => ({
  forecast: { data: null as unknown, loading: false, error: undefined as unknown, stalled: false },
  hbpeEnabled: true,
  extras: {
    loading: false,
    places: [] as unknown[],
    calibration: null as unknown,
    historyDays: [] as unknown[],
  },
}));

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();

  return {
    ...actual,
    useForecastService: () => [h.forecast, { refetch: vi.fn() }],
    useWeekAheadService: () => ({ week: null, due: [] }),
  };
});

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: (flag: string) => (flag === 'hbpe' ? h.hbpeEnabled : true) }),
}));

// Isolates the page from Apollo entirely — the extras panel is not on screen
// in either branch under test here.
vi.mock('./useForecastExtras', () => ({
  useForecastExtras: () => h.extras,
}));

beforeEach(() => {
  h.hbpeEnabled = true;
  h.forecast = { data: null, loading: false, error: undefined, stalled: false };
  h.extras = { loading: false, places: [], calibration: null, historyDays: [] };
});

describe('ForecastPage — off vs unreachable', () => {
  it('says the forecast is off when the hbpe flag is off', () => {
    h.hbpeEnabled = false;

    renderWithProviders(<ForecastPage />);

    expect(screen.getByText('Forecast is off for this workspace.')).toBeInTheDocument();
  });

  it('says the call failed — not "off" — when the flag is on but the query returned nothing', () => {
    // The regression this guards: before the fix, `!forecast` alone drove this
    // copy regardless of the flag, so a live flag with a swallowed HBPE
    // failure (ForecastResolver.ts's try/catch returns null on any thrown
    // error) rendered the same "Add → Predict" copy as a hard-off workspace —
    // and told the user to do something that would not fix a downed sidecar.
    h.hbpeEnabled = true;
    h.forecast = { data: null, loading: false, error: undefined, stalled: false };

    renderWithProviders(<ForecastPage />);

    expect(screen.getByText(/Couldn't reach the forecasting service/)).toBeInTheDocument();
    expect(screen.queryByText('Forecast is off for this workspace.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Add → Predict/)).not.toBeInTheDocument();
  });

  it('mounts CalibrationPanel and DivergenceHeatmapPanel when forecast and calibration/history data are present', () => {
    h.forecast = {
      data: {
        generatedAt: '2026-10-20T08:00:00Z',
        systemStatus: 'READY',
        stillLearning: false,
        modelVersion: 'hmt',
        pipelineEtaSeconds: null,
        pipelineDetail: null,
        buckets: [
          {
            bucketIndex: 0,
            startTime: '2026-10-20T00:00:00Z',
            l0Probs: [{ label: 'SLEEP', probability: 0.9 }],
            l1Probs: [],
            l2Probs: null,
            q10: 0,
            q50: 0.9,
            q90: 1,
          },
        ],
      },
      loading: false,
      error: undefined,
      stalled: false,
    };
    h.extras = {
      loading: false,
      places: [],
      calibration: {
        basis: '14-day rolling',
        latest: {
          l0Top1Acc: 0.82,
          ece: 0.041,
          driftFlag: false,
          modelVersion: 'hmt',
        },
      },
      historyDays: [
        {
          date: '2026-10-19',
          buckets: [
            {
              bucketIndex: 18,
              predictedL0: [{ label: 'WORK', probability: 0.8 }],
              actualL0: 'LEISURE',
            },
          ],
        },
      ],
    };

    renderWithProviders(<ForecastPage />);

    expect(screen.getByText('Forecast trust')).toBeInTheDocument();
    expect(screen.getByText('Top-1 match: 82%')).toBeInTheDocument();
    expect(screen.getByText('Where it was wrong')).toBeInTheDocument();
  });
});
