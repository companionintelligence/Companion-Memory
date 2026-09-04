import { useCallback, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import type { ForecastBucket, ForecastResponse } from '@/api/useForecastService';

import { PredictionBand } from './PredictionBand';

/**
 * The band has three request states and they are easy to confuse by eye, which
 * is how the unavailable one shipped as a dead end: it told the user to try
 * again over a request nothing would ever re-issue. Each is a story so the
 * difference stays visible.
 */

// A plausible day rather than noise: asleep overnight, commute, a work block,
// an evening of leisure. The strip colours by dominant L0 and fades by
// confidence, so a flat or random day hides both behaviours.
const DAY: Array<[number, number, string, string]> = [
  [0, 28, 'SLEEP', 'sleep'],
  [28, 32, 'TRANSIT', 'commute'],
  [32, 48, 'WORK', 'focus block'],
  [48, 52, 'ERRAND', 'lunch run'],
  [52, 68, 'WORK', 'meetings'],
  [68, 72, 'TRANSIT', 'commute home'],
  [72, 84, 'LEISURE', 'evening'],
  [84, 96, 'SLEEP', 'sleep'],
];

function buckets(): ForecastBucket[] {
  const out: ForecastBucket[] = [];

  for (const [from, to, l0, l1] of DAY) {
    for (let i = from; i < to; i += 1) {
      // Confidence sags at the edges of each block — that is where the model is
      // genuinely least sure, and it is what the opacity ramp is for.
      const edge = Math.min(i - from, to - 1 - i);
      const probability = Math.min(0.95, 0.55 + edge * 0.08);

      out.push({
        bucketIndex: i,
        startTime: new Date(Date.UTC(2026, 8, 3, 0, i * 15)).toISOString(),
        l0Probs: [
          { label: l0, probability },
          { label: 'LEISURE', probability: 1 - probability },
        ],
        l1Probs: [{ label: l1, probability }],
        l2Probs: null,
        q10: Math.max(0, probability - 0.2),
        q50: probability,
        q90: Math.min(1, probability + 0.1),
      });
    }
  }

  return out;
}

const forecast: ForecastResponse = {
  horizon: '24h',
  generatedAt: '2026-09-02T16:55:37.000Z',
  systemStatus: 'READY',
  modelVersion: 'hmt-int8',
  stillLearning: false,
  pipelineEtaSeconds: null,
  pipelineDetail: null,
  buckets: buckets(),
};

const meta = {
  title: 'Schedule/PredictionBand',
  component: PredictionBand,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PredictionBand>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Resolved: Story = {
  args: {
    forecast,
    loading: false,
    stalled: false,
    showFullForecastLink: true,
    onRetry: () => {},
  },
};

export const Loading: Story = {
  args: {
    forecast: null,
    loading: true,
    stalled: false,
    showFullForecastLink: false,
    onRetry: () => {},
  },
};

export const Unavailable: Story = {
  args: {
    forecast: null,
    loading: false,
    stalled: false,
    showFullForecastLink: false,
    onRetry: () => {},
  },
};

/**
 * The state the fix is about. `ForecastResolver` swallows an HBPE failure and
 * answers null, and `useForecastService` reads a null forecast as "nothing to
 * poll for" and stops polling — so before this prop existed, the band asked the
 * user to try again over a request that would never be made again.
 *
 * Retry here walks the real sequence a recovering HBPE produces: unavailable →
 * loading → resolved.
 */
export const RetryRecovers: Story = {
  args: {
    forecast: null,
    loading: false,
    stalled: false,
    showFullForecastLink: true,
    onRetry: () => {},
  },
  render: function RetryRecovers(args) {
    const [state, setState] = useState<'failed' | 'loading' | 'ready'>('failed');

    const retry = useCallback(() => {
      setState('loading');
      setTimeout(() => setState('ready'), 900);
    }, []);

    return (
      <PredictionBand
        {...args}
        forecast={state === 'ready' ? forecast : null}
        loading={state === 'loading'}
        onRetry={retry}
      />
    );
  },
};
