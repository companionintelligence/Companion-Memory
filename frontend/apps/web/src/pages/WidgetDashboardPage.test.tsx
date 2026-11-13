import { buildWidgetSnapshot } from '@ci/common';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { classTitle } from '@/lib/activityPalette';
import { renderWithProviders } from '@/test/renderWithProviders';

import { WidgetDashboardView } from './WidgetDashboardPage';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const PATHS = { plan: '/plan/tasks', chat: '/chat', forecast: '/forecast', jobs: '/jobs' };

function renderPrediction(systemStatus: string, predictedL0: string, probability: number) {
  const snapshot = buildWidgetSnapshot({
    now: NOW,
    forecast: {
      generatedAt: '2026-11-12T11:00:00.000Z',
      systemStatus,
      stillLearning: false,
      buckets: [
        {
          startTime: '2026-11-12T12:15:00.000Z',
          predictedL0,
          l0Probs: [{ label: predictedL0, probability }],
        },
      ],
    },
    // As WidgetDashboardPage and WidgetSnapshotSync build it.
    predictionLabel: classTitle,
  });

  renderWithProviders(<WidgetDashboardView snapshot={snapshot} prompts={[]} paths={PATHS} />);
}

/**
 * The Prediction card printed what HBPE returns as it is: the class label as
 * its headline ("WORK", "UNKNOWN") and "Forecast status: NIGHTLY:label" while
 * the nightly run was going.
 */
describe('WidgetDashboardView: the Prediction card', () => {
  it('names the predicted activity in the calendar legend words', () => {
    renderPrediction('READY', 'WORK', 0.62);

    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('62% likely')).toBeInTheDocument();
    expect(screen.queryByText('WORK')).not.toBeInTheDocument();
    // READY is the normal state; the card's own "Updated" time already says so.
    expect(screen.queryByText(/Forecast status|READY/)).not.toBeInTheDocument();
  });

  it('uses the legend word, not just a capitalised label', () => {
    renderPrediction('READY', 'ERRAND', 0.7);

    expect(screen.getByText('Errands')).toBeInTheDocument();
    expect(screen.getByText('70% likely')).toBeInTheDocument();
  });

  it('calls an unclassified prediction unsorted, as the calendar does', () => {
    renderPrediction('READY', 'UNKNOWN', 0.97);

    expect(screen.getByText('Unsorted')).toBeInTheDocument();
    expect(screen.queryByText('UNKNOWN')).not.toBeInTheDocument();
  });

  it('says what a running pipeline step is doing instead of printing the step', () => {
    renderPrediction('NIGHTLY:label', 'WORK', 0.5);

    expect(screen.getByText('Labeling new events...')).toBeInTheDocument();
    expect(screen.queryByText(/NIGHTLY/)).not.toBeInTheDocument();
  });

  it('says a new account is waiting for its first model, not COLD_START', () => {
    renderPrediction('COLD_START', 'UNKNOWN', 0.5);

    expect(screen.getByText('Waiting to initialize...')).toBeInTheDocument();
    expect(screen.queryByText(/COLD_START/)).not.toBeInTheDocument();
  });
});
