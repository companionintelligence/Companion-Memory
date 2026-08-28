import type { ForecastBucket, WeekForecastResponse } from '@ci/domains/predictions';

import { buildOccupancyTree, mergeGuess } from '../branchialOccupancy';

function bucket(over: Partial<ForecastBucket> = {}): ForecastBucket {
  return {
    bucket_index: 20,
    start_time: '2026-08-22T10:00:00Z',
    l0_probs: { WORK: 0.7, LEISURE: 0.3 },
    l1_probs: { standup: 0.6, docs: 0.4 },
    l2_probs: null,
    q10: 0,
    q50: 0.7,
    q90: 1,
    ...over,
  };
}

describe('buildOccupancyTree', () => {
  it('groups remaining histogram buckets into dayparts with L1 permutations', () => {
    const tree = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [
        bucket({ start_time: '2026-08-22T10:00:00Z', bucket_index: 20 }),
        bucket({
          start_time: '2026-08-22T15:00:00Z',
          bucket_index: 30,
          l0_probs: { LEISURE: 0.8, WORK: 0.2 },
          l1_probs: { walk: 0.9 },
        }),
      ],
    });

    expect(tree.steps.map((step) => step.id)).toEqual(['morning', 'afternoon']);
    expect(tree.steps[0]?.branches[0]?.title).toBe('WORK');
    expect(tree.steps[0]?.branches[0]?.permutations[0]?.title).toBe('standup');
    expect(tree.steps[1]?.branches[0]?.title).toBe('LEISURE');
    expect(tree.guessed).toBe(false);
  });

  it('drops dayparts that have already elapsed', () => {
    const tree = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T13:00:00Z'),
      buckets: [bucket({ start_time: '2026-08-22T10:00:00Z' })],
    });

    expect(tree.steps).toEqual([]);
  });

  it('returns no steps for UNKNOWN, low-mass, or junk names', () => {
    const tree = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [
        bucket({
          l0_probs: { UNKNOWN: 1 },
          l1_probs: { Ransom: 0.9, Riot: 0.8, Drs: 0.7 },
        }),
      ],
    });

    expect(tree.steps).toEqual([]);
  });

  it('returns no steps while still learning or not READY', () => {
    const args = {
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [bucket()],
    };

    expect(buildOccupancyTree({ ...args, stillLearning: true }).steps).toEqual([]);
    expect(buildOccupancyTree({ ...args, ready: false }).steps).toEqual([]);
  });

  it('does not dump future week-ahead clusters onto the occupancy spine', () => {
    const week: WeekForecastResponse = {
      horizon: '7d',
      generated_at: '2026-08-22T00:00:00Z',
      days: [
        {
          date: '2026-08-23',
          dow: 'Sunday',
          clusters: [
            {
              cluster_id: 'beach',
              name: 'beach trip',
              l0_class: 'LEISURE',
              p_occur: 0.6,
              daypart_probs: { morning: 0.7 },
            },
          ],
        },
      ],
    };

    const tree = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [bucket()],
      week,
    });

    expect(tree.steps.map((step) => step.id)).toEqual(['morning']);
    expect(tree.steps.some((step) => step.id === '2026-08-23')).toBe(false);
  });

  it('injects a booked calendar cluster into the remaining day', () => {
    const week: WeekForecastResponse = {
      horizon: '7d',
      generated_at: '2026-08-22T00:00:00Z',
      days: [
        {
          date: '2026-08-22',
          dow: 'Saturday',
          clusters: [
            {
              cluster_id: 'dentist',
              name: 'Dentist',
              l0_class: 'ERRAND',
              p_occur: 0.05,
              scheduled: true,
              daypart_probs: { morning: 0.9 },
            },
          ],
        },
      ],
    };

    const tree = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [],
      week,
    });

    expect(tree.steps[0]?.id).toBe('morning');
    expect(tree.steps[0]?.branches[0]?.title).toBe('Dentist');
    expect(tree.steps[0]?.branches[0]?.why).toBe('On your calendar.');
  });
});

describe('mergeGuess', () => {
  it('keeps occupancy step ids and overlays LLM titles', () => {
    const occupancy = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [bucket()],
    });
    const merged = mergeGuess(occupancy, {
      question: 'Where is Saturday going',
      guessed: true,
      steps: [
        {
          id: 'morning',
          label: 'Morning',
          startTime: occupancy.steps[0].startTime,
          branches: [
            {
              id: 'morning:beach',
              title: 'beach with Jerry',
              l0: 'LEISURE',
              mass: 0.55,
              why: 'Jerry texted about surf.',
              permutations: [{ id: 'jerry', title: 'Jerry', mass: 0.8 }],
            },
          ],
        },
      ],
    });

    expect(merged.guessed).toBe(true);
    expect(merged.steps[0]?.id).toBe('morning');
    expect(merged.steps[0]?.branches[0]?.title).toBe('beach with Jerry');
    expect(merged.steps[0]?.branches[0]?.permutations[0]?.title).toBe('Jerry');
  });

  it('does not let the model fill UNKNOWN over a gated occupancy title', () => {
    const occupancy = buildOccupancyTree({
      timezone: 'UTC',
      now: new Date('2026-08-22T09:00:00Z'),
      buckets: [bucket()],
    });
    const merged = mergeGuess(occupancy, {
      question: 'next',
      guessed: true,
      steps: [
        {
          id: 'morning',
          label: 'Morning',
          startTime: occupancy.steps[0].startTime,
          branches: [
            {
              id: 'morning:x',
              title: 'UNKNOWN',
              l0: 'UNKNOWN',
              mass: 1,
              why: '',
              permutations: [{ id: 'Riot', title: 'Riot', mass: 0.9 }],
            },
          ],
        },
      ],
    });

    expect(merged.steps[0]?.branches[0]?.title).toBe('WORK');
    expect(merged.steps[0]?.branches[0]?.l0).toBe('WORK');
    expect(merged.steps[0]?.branches[0]?.permutations[0]?.title).toBe('standup');
  });
});
