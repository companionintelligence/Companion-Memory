import { describe, expect, it } from 'vitest';

import type { ForecastBucket } from '@/api/useForecastService';

import { deriveNextUp } from './deriveNextUp';

/** Fixed reference instant: a Tuesday at 13:00 local. */
const NOW = new Date(2026, 6, 7, 13, 0, 0);

interface BucketSpec {
  /** Offset in buckets (30min units) from NOW for this bucket's startTime. */
  offset: number;
  l0?: Array<[string, number]>;
  l1?: Array<[string, number]>;
}

function bucket({ offset, l0 = [], l1 = [] }: BucketSpec, index: number): ForecastBucket {
  return {
    bucketIndex: index,
    startTime: new Date(NOW.getTime() + offset * 30 * 60_000).toISOString(),
    l0Probs: l0.map(([label, probability]) => ({ label, probability })),
    l1Probs: l1.map(([label, probability]) => ({ label, probability })),
    l2Probs: null,
    q10: 0,
    q50: 0.5,
    q90: 1,
  };
}

function buckets(specs: BucketSpec[]): ForecastBucket[] {
  return specs.map(bucket);
}

describe('deriveNextUp', () => {
  it('merges consecutive buckets sharing a dominant class into one segment', () => {
    const { segments } = deriveNextUp(
      buckets([
        { offset: 0, l0: [['WORK', 0.8]] },
        { offset: 1, l0: [['WORK', 0.6]] },
        { offset: 2, l0: [['ERRAND', 0.5]] },
      ]),
      NOW,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].l0).toBe('WORK');
    expect(segments[0].meanProb).toBeCloseTo(0.7);
    expect(segments[0].end.getTime() - segments[0].start.getTime()).toBe(60 * 60_000);
    expect(segments[1].l0).toBe('ERRAND');
  });

  it('splits segments when buckets are not contiguous, even for the same class', () => {
    const { segments } = deriveNextUp(
      buckets([
        { offset: 0, l0: [['WORK', 0.8]] },
        { offset: 3, l0: [['WORK', 0.8]] },
      ]),
      NOW,
    );

    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.l0)).toEqual(['WORK', 'WORK']);
  });

  it('excludes buckets that ended before now, keeps the one in progress', () => {
    // 13:10 — ten minutes into the offset-0 bucket [13:00, 13:30).
    const midBucket = new Date(NOW.getTime() + 10 * 60_000);

    const { segments } = deriveNextUp(
      buckets([
        { offset: -3, l0: [['SLEEP', 0.9]] }, // ended in the past
        { offset: -1, l0: [['WORK', 0.9]] }, // [12:30, 13:00) — ended at 13:00
        { offset: 0, l0: [['WORK', 0.9]] }, // [13:00, 13:30) — in progress at 13:10
        { offset: 1, l0: [['WORK', 0.9]] },
      ]),
      midBucket,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].l0).toBe('WORK');
    expect(segments[0].start.getTime()).toBe(NOW.getTime());
  });

  it('drops UNKNOWN-dominant and below-floor segments', () => {
    const { segments } = deriveNextUp(
      buckets([
        { offset: 0, l0: [['UNKNOWN', 0.9]] },
        { offset: 1, l0: [['WORK', 0.1]] }, // below the 0.15 noise floor
        { offset: 2, l0: [['SOCIAL', 0.6]] },
      ]),
      NOW,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].l0).toBe('SOCIAL');
  });

  it('ignores gap-fill buckets with no probabilities and unparseable start times', () => {
    const withGarbage = [
      ...buckets([{ offset: 0, l0: [['LEISURE', 0.7]] }]),
      { ...bucket({ offset: 1, l0: [] }, 98), startTime: '' },
      { ...bucket({ offset: 2, l0: [['WORK', 0.7]] }, 99), startTime: 'not-a-date' },
    ];

    const { segments } = deriveNextUp(withGarbage, NOW);

    expect(segments).toHaveLength(1);
    expect(segments[0].l0).toBe('LEISURE');
  });

  it('picks the strongest L1 context across the whole segment', () => {
    const { segments } = deriveNextUp(
      buckets([
        { offset: 0, l0: [['WORK', 0.8]], l1: [['Code Review', 0.4]] },
        { offset: 1, l0: [['WORK', 0.8]], l1: [['Deep Focus', 0.7]] },
        { offset: 2, l0: [['WORK', 0.8]], l1: [['Standup', 0.2]] },
      ]),
      NOW,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].topContext).toEqual({ name: 'Deep Focus', prob: 0.7 });
  });

  it('caps the list at maxSegments within the horizon', () => {
    const alternating = buckets(
      Array.from({ length: 12 }, (_, i) => ({
        offset: i,
        l0: [[i % 2 === 0 ? 'WORK' : 'SOCIAL', 0.8]] as Array<[string, number]>,
      })),
    );

    const { segments } = deriveNextUp(alternating, NOW, { maxSegments: 3 });

    expect(segments).toHaveLength(3);
  });

  it('limits segments to the horizon window after the first upcoming bucket', () => {
    const { segments } = deriveNextUp(
      buckets([
        { offset: 0, l0: [['WORK', 0.8]] },
        { offset: 20, l0: [['SOCIAL', 0.8]] }, // 10h out — beyond the 8h horizon
      ]),
      NOW,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].l0).toBe('WORK');
  });

  it('reports mode today when the window overlaps the current local day', () => {
    const { mode } = deriveNextUp(buckets([{ offset: 0, l0: [['WORK', 0.8]] }]), NOW);

    expect(mode).toBe('today');
  });

  it('reports mode upcoming when the window is a future day (tomorrow forecast)', () => {
    const tomorrowMorning = 36; // NOW 13:00 + 18h = 07:00 next day

    const { mode, segments } = deriveNextUp(
      buckets([
        { offset: tomorrowMorning, l0: [['EXERCISE', 0.7]] },
        { offset: tomorrowMorning + 1, l0: [['WORK', 0.7]] },
      ]),
      NOW,
    );

    expect(segments.length).toBeGreaterThan(0);
    expect(mode).toBe('upcoming');
  });

  it('returns empty segments for an entirely-past (stale) window', () => {
    const { segments } = deriveNextUp(
      buckets([
        { offset: -10, l0: [['WORK', 0.9]] },
        { offset: -9, l0: [['WORK', 0.9]] },
      ]),
      NOW,
    );

    expect(segments).toHaveLength(0);
  });
});
