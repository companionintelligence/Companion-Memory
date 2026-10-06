import { describe, expect, it } from 'vitest';

import type { ForecastBucket, ForecastResponse } from '@/api/useForecastService';
import { classColor, normalizeClass } from '@/lib/activityPalette';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ForecastStrip } from './ForecastStrip';

/**
 * The strip paints `predictedL0` rather than argmax(l0Probs). The two differ on
 * purpose — see `displayL0` — so these fix the distinction rather than the
 * colours, which belong to the shared palette.
 *
 * The tooltip's "Showing <class>" line is not covered here: it lives inside a
 * Radix Tooltip.Content that only mounts on a real hover, and driving that in
 * jsdom needs pointer-event plumbing brittle enough to be worse than no test.
 */

function bucket(overrides: Partial<ForecastBucket> = {}): ForecastBucket {
  return {
    bucketIndex: 0,
    startTime: '2026-09-03T00:00:00.000Z',
    l0Probs: [
      { label: 'UNKNOWN', probability: 0.84 },
      { label: 'EXERCISE', probability: 0.16 },
    ],
    l1Probs: [],
    l2Probs: null,
    q10: 0.1,
    q50: 0.9,
    q90: 0.99,
    ...overrides,
  };
}

function renderStrip(buckets: ForecastBucket[]) {
  const forecast: Pick<ForecastResponse, 'generatedAt' | 'systemStatus' | 'modelVersion'> = {
    generatedAt: '2026-09-02T16:55:37.000Z',
    systemStatus: 'READY',
    modelVersion: 'logit',
  };

  return renderWithProviders(
    <ForecastStrip
      buckets={buckets}
      generatedAt={forecast.generatedAt}
      systemStatus={forecast.systemStatus}
      stalled={false}
      stillLearning={false}
      modelVersion={forecast.modelVersion}
      pipelineEtaSeconds={null}
      pipelineDetail={null}
    />,
  );
}

function slotColors(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[style*="background-color"]')).map(
    (el) => el.style.backgroundColor,
  );
}

describe('ForecastStrip class selection', () => {
  it('paints the class HBPE chose, not the most probable one', () => {
    // The posterior prefers UNKNOWN 0.84; the server's floored prior correction
    // promoted EXERCISE. The strip must follow the server.
    const { container } = renderStrip([bucket({ predictedL0: 'EXERCISE' })]);

    expect(slotColors(container)).toContain(classColor(normalizeClass('EXERCISE')));
  });

  it('falls back to the most probable class when HBPE does not send one', () => {
    // An HBPE predating predictedL0 must render exactly as it used to.
    const { container } = renderStrip([bucket({ predictedL0: null })]);

    expect(slotColors(container)).toContain(classColor(normalizeClass('UNKNOWN')));
  });

  it('treats an absent field the same as an explicit null', () => {
    const withoutField = bucket();
    delete (withoutField as Partial<ForecastBucket>).predictedL0;
    const { container } = renderStrip([withoutField]);

    expect(slotColors(container)).toContain(classColor(normalizeClass('UNKNOWN')));
  });
});
