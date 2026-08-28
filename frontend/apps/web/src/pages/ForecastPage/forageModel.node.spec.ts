import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ForecastBucket } from '@/api/useForecastService';

import {
  COMMIT_MASS,
  branchPick,
  entropy,
  klDivergence,
  normalizeMass,
  pickOpenSlot,
  rankSaccades,
} from './forageModel';

const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function probs(...entries: [string, number][]): ForecastBucket['l0Probs'] {
  return entries.map(([label, probability]) => ({ label, probability }));
}

function bucket(over: Partial<ForecastBucket> = {}): ForecastBucket {
  return {
    bucketIndex: 20,
    startTime: '2026-08-22T10:00:00Z',
    l0Probs: probs(['WORK', 0.5], ['LEISURE', 0.5]),
    l1Probs: [],
    l2Probs: null,
    q10: 0,
    q50: 0.5,
    q90: 1,
    ...over,
  };
}

describe('forageModel', () => {
  it('renormalizes L0 so equal occupancy stays equal', () => {
    expect(normalizeMass(probs(['WORK', 2], ['LEISURE', 2]))).toEqual([
      { label: 'WORK', mass: 0.5 },
      { label: 'LEISURE', mass: 0.5 },
    ]);
  });

  it('entropy is max at a fair coin and zero on a sure call', () => {
    const fair = entropy(normalizeMass(probs(['WORK', 0.5], ['LEISURE', 0.5])));
    const sure = entropy(normalizeMass(probs(['WORK', 1])));

    expect(fair).toBeCloseTo(Math.log(2), 6);
    expect(sure).toBeCloseTo(0, 6);
  });

  it('KL is zero when tomorrow matches that day and large when they disagree', () => {
    const work = normalizeMass(probs(['WORK', 1]));
    const leisure = normalizeMass(probs(['LEISURE', 1]));

    expect(klDivergence(work, work)).toBeCloseTo(0, 6);
    expect(klDivergence(work, leisure)).toBeGreaterThan(10);
  });

  it('does not commit a branch until Forager mass 0.6', () => {
    const open = branchPick(bucket({ l0Probs: probs(['WORK', 0.55], ['LEISURE', 0.45]) }));
    const committed = branchPick(
      bucket({
        l0Probs: probs(['WORK', 0.7], ['LEISURE', 0.3]),
        l1Probs: probs(['standup', 0.8], ['docs', 0.2]),
      }),
    );

    expect(COMMIT_MASS).toBe(0.6);
    expect(open.ready).toBe(false);
    expect(open.branch).toBeNull();
    expect(committed.ready).toBe(true);
    expect(committed.branch).toBe('WORK');
    expect(committed.texture).toBe('standup');
  });

  it('opens on the highest-entropy upcoming slot, not the next clock time', () => {
    const now = Date.parse('2026-08-22T09:00:00Z');
    const sureSoon = bucket({
      bucketIndex: 18,
      startTime: '2026-08-22T09:30:00Z',
      l0Probs: probs(['WORK', 0.95], ['LEISURE', 0.05]),
    });
    const mixedLater = bucket({
      bucketIndex: 22,
      startTime: '2026-08-22T11:00:00Z',
      l0Probs: probs(['WORK', 0.5], ['LEISURE', 0.5]),
    });

    const picked = pickOpenSlot([sureSoon, mixedLater], now);

    expect(picked?.bucketIndex).toBe(22);
  });

  it('ranks a disagreeing history day above a matching one', () => {
    const ranked = rankSaccades(
      [
        {
          date: '2026-08-15',
          buckets: [{ bucketIndex: 20, predictedL0: probs(['WORK', 0.9]), actualL0: 'WORK' }],
        },
        {
          date: '2026-08-16',
          buckets: [{ bucketIndex: 20, predictedL0: probs(['WORK', 0.6]), actualL0: 'LEISURE' }],
        },
      ],
      20,
      probs(['WORK', 0.8], ['LEISURE', 0.2]),
    );

    expect(ranked[0]?.date).toBe('2026-08-16');
    expect(ranked[0]?.kl).toBeGreaterThan(ranked[1]?.kl ?? 0);
  });
});
