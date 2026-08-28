import { render, screen } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ForecastBucket } from '@/api/useForecastService';

import {
  BranchTexturePanel,
  DivergenceHeatmapPanel,
  OccupancyHonestyPanel,
  SaccadePanel,
} from './ForecastPanels';

const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function probs(...entries: [string, number][]) {
  return entries.map(([label, probability]) => ({ label, probability }));
}

const history = [
  {
    date: '2026-07-13',
    buckets: [
      { bucketIndex: 18, predictedL0: probs(['WORK', 0.8]), actualL0: 'WORK' },
      { bucketIndex: 20, predictedL0: probs(['WORK', 0.7]), actualL0: 'LEISURE' },
      { bucketIndex: 22, predictedL0: probs(['WORK', 0.6]), actualL0: null },
    ],
  },
  {
    date: '2026-07-14',
    buckets: [{ bucketIndex: 18, predictedL0: probs(['SLEEP', 0.9]), actualL0: 'SOCIAL' }],
  },
];

const forecastBuckets = [
  {
    bucketIndex: 0,
    startTime: '2026-07-15T00:00:00Z',
    l0Probs: probs(['SLEEP', 0.9]),
    l1Probs: [],
    l2Probs: null,
    q10: 0,
    q50: 0.9,
    q90: 1,
  },
] as ForecastBucket[];

describe('OccupancyHonestyPanel', () => {
  it('says occupancy is unweighted', () => {
    render(<OccupancyHonestyPanel />);

    expect(screen.getByTestId('occupancy-honesty')).toHaveTextContent('Every label counts as one');
    expect(screen.getByText(/Duration never/)).toBeInTheDocument();
  });
});

describe('BranchTexturePanel', () => {
  it('opens on the mixed slot and withholds the commit', () => {
    const now = Date.parse('2026-07-15T00:00:00Z');
    render(
      <BranchTexturePanel
        nowMs={now}
        buckets={[
          {
            ...forecastBuckets[0],
            bucketIndex: 0,
            startTime: '2026-07-15T01:00:00Z',
            l0Probs: probs(['SLEEP', 0.95], ['WORK', 0.05]),
          },
          {
            ...forecastBuckets[0],
            bucketIndex: 20,
            startTime: '2026-07-15T10:00:00Z',
            l0Probs: probs(['WORK', 0.5], ['LEISURE', 0.5]),
            l1Probs: probs(['standup', 0.6], ['docs', 0.4]),
          },
        ]}
      />,
    );

    expect(screen.getByTestId('branch-texture')).toHaveTextContent('not ready');
    expect(screen.getByText('standup')).toBeInTheDocument();
  });
});

describe('SaccadePanel', () => {
  it('ranks the disagreeing day first', () => {
    const now = Date.parse('2026-07-15T00:00:00Z');
    render(
      <SaccadePanel
        nowMs={now}
        buckets={[
          {
            ...forecastBuckets[0],
            bucketIndex: 18,
            startTime: '2026-07-15T09:00:00Z',
            l0Probs: probs(['WORK', 0.8], ['LEISURE', 0.2]),
          },
        ]}
        historyDays={history}
      />,
    );

    const rows = screen.getByTestId('saccade-panel').textContent ?? '';
    expect(rows.indexOf('Tue 7/14')).toBeLessThan(rows.indexOf('Mon 7/13'));
  });
});

describe('DivergenceHeatmapPanel', () => {
  it('rings only the half-hours the model got wrong', () => {
    render(<DivergenceHeatmapPanel historyDays={history} buckets={forecastBuckets} />);

    expect(screen.getAllByTestId('heatmap-cell-divergent')).toHaveLength(2);
    expect(screen.getByText('Missed 2 of 3 scored half-hours (67%).')).toBeInTheDocument();
  });

  it('names the miss in the cell title so hovering explains it', () => {
    render(<DivergenceHeatmapPanel historyDays={history} buckets={[]} />);

    const [miss] = screen.getAllByTestId('heatmap-cell-divergent');

    expect(miss.getAttribute('title')).toContain('predicted WORK (70%), actually LEISURE — missed');
  });

  it('draws a row per logged day plus the day ahead, with a seam between them', () => {
    render(<DivergenceHeatmapPanel historyDays={history} buckets={forecastBuckets} />);

    expect(screen.getByText('Mon 7/13')).toBeInTheDocument();
    expect(screen.getByText('Tue 7/14')).toBeInTheDocument();
    expect(screen.getByText('Wed 7/15')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('omits the seam when there is nothing ahead to separate', () => {
    render(<DivergenceHeatmapPanel historyDays={history} buckets={[]} />);

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.queryByText('Wed 7/15')).not.toBeInTheDocument();
  });

  it('says so plainly when no day has been scored yet', () => {
    render(
      <DivergenceHeatmapPanel
        historyDays={[
          { date: '2026-07-14', buckets: [{ bucketIndex: 18, predictedL0: probs(['WORK', 0.8]) }] },
        ]}
        buckets={[]}
      />,
    );

    expect(screen.queryAllByTestId('heatmap-cell-divergent')).toHaveLength(0);
    expect(
      screen.getByText(/No half-hours scored yet — rings appear once the nightly actuals backfill/),
    ).toBeInTheDocument();
  });

  it('renders nothing at all before the engine has logged anything', () => {
    const { container } = render(<DivergenceHeatmapPanel historyDays={[]} buckets={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
