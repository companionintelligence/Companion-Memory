import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForecastResponse } from '@/api/useForecastService';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PredictionBand } from './PredictionBand';

const strip = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('@/components/ForecastStrip', () => ({
  ForecastStrip: (props: Record<string, unknown>) => {
    strip.render(props);

    return <div role="img" aria-label="24-hour behavioral forecast strip" />;
  },
}));

const forecast: ForecastResponse = {
  horizon: '24h',
  generatedAt: '2026-09-02T16:55:37.000Z',
  systemStatus: 'READY',
  modelVersion: 'hmt-int8',
  stillLearning: false,
  pipelineEtaSeconds: null,
  pipelineDetail: null,
  buckets: [
    {
      bucketIndex: 0,
      startTime: '2026-09-03T00:00:00.000Z',
      l0Probs: [{ label: 'SLEEP', probability: 0.9 }],
      l1Probs: [{ label: 'sleep', probability: 0.8 }],
      l2Probs: null,
      q10: 0.1,
      q50: 0.9,
      q90: 0.99,
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('PredictionBand', () => {
  it('passes the HBPE histogram and model metadata through to the inspectable strip', () => {
    renderWithProviders(
      <PredictionBand
        forecast={forecast}
        loading={false}
        stalled={false}
        showFullForecastLink
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: "Tomorrow's prediction band" })).toBeInTheDocument();
    expect(screen.getByText(/96 quarter-hour bins directly from HBPE/)).toBeInTheDocument();
    expect(strip.render).toHaveBeenCalledWith(
      expect.objectContaining({
        buckets: forecast.buckets,
        generatedAt: forecast.generatedAt,
        systemStatus: forecast.systemStatus,
        modelVersion: forecast.modelVersion,
      }),
    );
    expect(screen.getByRole('link', { name: 'Open full forecast' })).toHaveAttribute('href', '/forecast');
  });

  it('does not advertise a route disabled by the Forecast feature flag', () => {
    renderWithProviders(
      <PredictionBand
        forecast={forecast}
        loading={false}
        stalled={false}
        showFullForecastLink={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Open full forecast' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '24-hour behavioral forecast strip' })).toBeInTheDocument();
  });

  it('keeps initial loading visible without hiding the calendar behind an overlay', () => {
    renderWithProviders(
      <PredictionBand
        forecast={null}
        loading
        stalled={false}
        showFullForecastLink={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading the prediction band');
    expect(strip.render).not.toHaveBeenCalled();
  });

  it('makes an unavailable HBPE response explicit instead of silently removing the band', () => {
    renderWithProviders(
      <PredictionBand
        forecast={null}
        loading={false}
        stalled={false}
        showFullForecastLink={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reach HBPE");
    expect(strip.render).not.toHaveBeenCalled();
  });

  it('offers a retry that re-issues the query, and shows the strip once it succeeds', () => {
    // The regression: the copy said "try again shortly" over a request nothing
    // would ever re-issue. `ForecastResolver.ts` swallows an HBPE error and
    // answers null, and `useForecastService` reads a null forecast as "nothing
    // to poll for" and stops polling — so without a control here the band is
    // stuck until the user leaves the page and comes back.
    const onRetry = vi.fn();
    const { rerender } = renderWithProviders(
      <PredictionBand
        forecast={null}
        loading={false}
        stalled={false}
        showFullForecastLink={false}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <PredictionBand
        forecast={forecast}
        loading={false}
        stalled={false}
        showFullForecastLink={false}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('img', { name: '24-hour behavioral forecast strip' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retires the polite live region instead of re-roling it as an alert', () => {
    // A single node whose `role` flipped between 'status' and 'alert' asked the
    // screen reader to reinterpret a region it was already watching, and left
    // whether the change is announced at all up to the AT. The two states are
    // separate elements so one is removed and the other introduced.
    const { rerender } = renderWithProviders(
      <PredictionBand
        forecast={null}
        loading
        stalled={false}
        showFullForecastLink={false}
        onRetry={vi.fn()}
      />,
    );

    const loadingRegion = screen.getByRole('status');

    rerender(
      <PredictionBand
        forecast={null}
        loading={false}
        stalled={false}
        showFullForecastLink={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toBe(loadingRegion);
  });
});
