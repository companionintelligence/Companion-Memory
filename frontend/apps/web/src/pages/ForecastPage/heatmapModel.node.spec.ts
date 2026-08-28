import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  HEATMAP_COLUMNS,
  bucketInstant,
  buildForecastRow,
  buildHeatmapRows,
  buildHistoryCells,
  dominantEntry,
  formatClock,
  formatRowLabel,
  localColumn,
  tallyDivergence,
  utcDateKey,
  type ForecastBucketLike,
  type HistoryBucketLike,
  type HistoryDayLike,
} from './heatmapModel';

const ORIGINAL_TZ = process.env.TZ;

/** These derivations are all UTC→local, so every case pins the zone explicitly. */
function useZone(tz: string) {
  process.env.TZ = tz;
}

beforeEach(() => useZone('UTC'));
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function probs(...entries: [string, number][]) {
  return entries.map(([label, probability]) => ({ label, probability }));
}

function bucket(over: Partial<HistoryBucketLike> = {}): HistoryBucketLike {
  return {
    bucketIndex: 18, // 09:00Z
    predictedL0: probs(['WORK', 0.8], ['LEISURE', 0.2]),
    actualL0: 'WORK',
    ...over,
  };
}

function day(over: Partial<HistoryDayLike> = {}): HistoryDayLike {
  return { date: '2026-07-14', buckets: [bucket()], ...over };
}

describe('dominantEntry', () => {
  it('returns the highest-probability entry', () => {
    expect(dominantEntry(probs(['WORK', 0.2], ['SLEEP', 0.7], ['SOCIAL', 0.1]))).toEqual({
      label: 'SLEEP',
      probability: 0.7,
    });
  });

  it('returns null for an empty distribution', () => {
    expect(dominantEntry([])).toBeNull();
  });
});

describe('bucketInstant', () => {
  it('reconstructs the UTC instant from the logged date and bucket index', () => {
    expect(bucketInstant('2026-07-14', 0)?.toISOString()).toBe('2026-07-14T00:00:00.000Z');
    expect(bucketInstant('2026-07-14', 18)?.toISOString()).toBe('2026-07-14T09:00:00.000Z');
    expect(bucketInstant('2026-07-14', 47)?.toISOString()).toBe('2026-07-14T23:30:00.000Z');
  });

  it('rejects malformed dates and out-of-range indices', () => {
    expect(bucketInstant('not-a-date', 0)).toBeNull();
    expect(bucketInstant('2026-7-4', 0)).toBeNull();
    expect(bucketInstant('2026-07-14', -1)).toBeNull();
    expect(bucketInstant('2026-07-14', 48)).toBeNull();
    expect(bucketInstant('2026-07-14', 1.5)).toBeNull();
  });
});

describe('localColumn', () => {
  it('maps an instant to its local half-hour column', () => {
    expect(localColumn('2026-07-14T00:00:00Z')).toBe(0);
    expect(localColumn('2026-07-14T09:30:00Z')).toBe(19);
    expect(localColumn('2026-07-14T23:59:00Z')).toBe(47);
  });

  it('shifts with the viewer zone rather than the logged UTC slot', () => {
    useZone('America/Los_Angeles'); // UTC-7 in July
    expect(localColumn('2026-07-14T00:00:00Z')).toBe(34); // 17:00 local
    expect(localColumn('2026-07-14T14:00:00Z')).toBe(14); // 07:00 local
  });

  it('returns null for unparseable input', () => {
    expect(localColumn('')).toBeNull();
    expect(localColumn('not-a-date')).toBeNull();
    expect(localColumn(null)).toBeNull();
  });
});

describe('buildHistoryCells', () => {
  it('always returns 48 slots', () => {
    expect(buildHistoryCells({ date: '2026-07-14', buckets: [] })).toHaveLength(HEATMAP_COLUMNS);
    expect(buildHistoryCells({ date: 'garbage', buckets: [bucket()] }).filter(Boolean)).toHaveLength(0);
  });

  it('renders a matching actual at full opacity without divergence', () => {
    expect(buildHistoryCells(day())[18]).toMatchObject({
      kind: 'actual',
      colorLabel: 'WORK',
      opacity: 1,
      divergent: false,
      predictedDominant: 'WORK',
    });
  });

  it('flags divergence when the actual disagrees with the predicted dominant', () => {
    expect(buildHistoryCells(day({ buckets: [bucket({ actualL0: 'LEISURE' })] }))[18]).toMatchObject({
      kind: 'actual',
      colorLabel: 'LEISURE',
      predictedDominant: 'WORK',
      divergent: true,
    });
  });

  it('does not flag a case-or-whitespace difference as a miss', () => {
    expect(buildHistoryCells(day({ buckets: [bucket({ actualL0: ' work ' })] }))[18]?.divergent).toBe(false);
  });

  it('flags a miss between two labels the palette does not recognise', () => {
    // normalizeClass would fold both into UNKNOWN and hide this.
    const cells = buildHistoryCells(
      day({ buckets: [bucket({ predictedL0: probs(['CHORES', 0.9]), actualL0: 'GAMING' })] }),
    );

    expect(cells[18]?.divergent).toBe(true);
  });

  it('falls back to the prediction at confidence opacity when the actual is missing', () => {
    expect(buildHistoryCells(day({ buckets: [bucket({ actualL0: null })] }))[18]).toMatchObject({
      kind: 'predicted',
      colorLabel: 'WORK',
      opacity: 0.8,
      divergent: false,
    });
  });

  it('clamps a barely-confident prediction into the visible range', () => {
    const cells = buildHistoryCells(
      day({ buckets: [bucket({ actualL0: null, predictedL0: probs(['ERRAND', 0.02]) })] }),
    );

    expect(cells[18]?.opacity).toBe(0.2);
  });

  it('leaves slots with neither an actual nor a prediction empty', () => {
    expect(buildHistoryCells(day({ buckets: [bucket({ actualL0: null, predictedL0: [] })] }))[18]).toBeNull();
  });

  it('places the row by local clock, not by the logged UTC slot', () => {
    useZone('America/Los_Angeles');
    const cells = buildHistoryCells(day());

    expect(cells[18]).toBeNull();
    expect(cells[4]).toMatchObject({ colorLabel: 'WORK', kind: 'actual' }); // 02:00 local
  });

  it('keeps the earlier bucket when two land in the same column', () => {
    const cells = buildHistoryCells(
      day({
        buckets: [
          bucket({ bucketIndex: 18, actualL0: 'WORK' }),
          bucket({ bucketIndex: 18, actualL0: 'SLEEP' }),
        ],
      }),
    );

    expect(cells[18]?.actualL0).toBe('WORK');
  });
});

describe('buildForecastRow', () => {
  const forecastBuckets: ForecastBucketLike[] = [
    { bucketIndex: 0, startTime: '2026-07-15T00:00:00Z', l0Probs: probs(['SLEEP', 0.9]) },
    { bucketIndex: 30, startTime: '2026-07-15T15:00:00Z', l0Probs: probs(['WORK', 0.6], ['SOCIAL', 0.4]) },
  ];

  it('keys the row by the horizon start, not by the bucket instant', () => {
    const row = buildForecastRow(forecastBuckets);

    expect(row).toMatchObject({ key: '2026-07-15', kind: 'ahead' });
    expect(row?.cells[0]).toMatchObject({ colorLabel: 'SLEEP', opacity: 0.9, kind: 'predicted' });
    expect(row?.cells[30]).toMatchObject({ colorLabel: 'WORK', opacity: 0.6 });
    expect(row?.cells.filter(Boolean)).toHaveLength(2);
  });

  it('still keys by the horizon start when the local day differs', () => {
    useZone('America/Los_Angeles');
    const row = buildForecastRow(forecastBuckets);

    expect(row?.key).toBe('2026-07-15');
    expect(row?.cells[34]).toMatchObject({ colorLabel: 'SLEEP' }); // 17:00 local
  });

  it('returns null when nothing is drawable', () => {
    expect(buildForecastRow([])).toBeNull();
    expect(buildForecastRow([{ bucketIndex: 0, startTime: '', l0Probs: probs(['WORK', 1]) }])).toBeNull();
    expect(buildForecastRow([{ bucketIndex: 0, startTime: '2026-07-15T00:00:00Z', l0Probs: [] }])).toBeNull();
  });
});

describe('buildHeatmapRows', () => {
  const history: HistoryDayLike[] = [
    { date: '2026-07-14', buckets: [bucket()] },
    { date: '2026-07-12', buckets: [bucket({ actualL0: 'SLEEP' })] },
  ];
  const ahead: ForecastBucketLike[] = [
    { bucketIndex: 0, startTime: '2026-07-15T00:00:00Z', l0Probs: probs(['SLEEP', 0.9]) },
  ];

  it('orders past days oldest-first and appends the day ahead', () => {
    const rows = buildHeatmapRows(history, ahead);

    expect(rows.map((row) => row.key)).toEqual(['2026-07-12', '2026-07-14', '2026-07-15']);
    expect(rows.map((row) => row.kind)).toEqual(['past', 'past', 'ahead']);
  });

  it('drops a forecast row for a day already present in the log', () => {
    const rows = buildHeatmapRows([...history, { date: '2026-07-15', buckets: [bucket()] }], ahead);

    expect(rows.map((row) => row.key)).toEqual(['2026-07-12', '2026-07-14', '2026-07-15']);
    expect(rows[2].kind).toBe('past');
  });

  it('skips days whose date key is unusable', () => {
    expect(buildHeatmapRows([{ date: 'nope', buckets: [bucket()] }], []).map((r) => r.key)).toEqual([]);
  });

  it('renders history alone when the engine has no forecast', () => {
    expect(buildHeatmapRows(history, []).map((row) => row.kind)).toEqual(['past', 'past']);
  });
});

describe('tallyDivergence', () => {
  it('counts only scored slots, and misses within them', () => {
    const rows = buildHeatmapRows(
      [
        {
          date: '2026-07-14',
          buckets: [
            bucket({ bucketIndex: 10, actualL0: 'WORK' }), // hit
            bucket({ bucketIndex: 12, actualL0: 'SLEEP' }), // miss
            bucket({ bucketIndex: 14, actualL0: null }), // not scored yet
          ],
        },
      ],
      [{ bucketIndex: 0, startTime: '2026-07-15T00:00:00Z', l0Probs: probs(['SLEEP', 0.9]) }],
    );

    expect(tallyDivergence(rows)).toEqual({ scored: 2, missed: 1 });
  });

  it('is zero for a grid with no backfilled actuals', () => {
    expect(tallyDivergence(buildHeatmapRows([], []))).toEqual({ scored: 0, missed: 0 });
  });
});

describe('formatting helpers', () => {
  it('labels a row from its date key', () => {
    expect(formatRowLabel('2026-07-14')).toBe('Tue 7/14');
    expect(formatRowLabel('garbage')).toBe('garbage');
  });

  it('formats a column clock label', () => {
    expect(formatClock(0)).toMatch(/12[:.]00/);
    expect(formatClock(9 * 60 + 30)).toMatch(/9[:.]30/);
  });

  it('derives the UTC date key from an instant', () => {
    useZone('America/Los_Angeles');
    expect(utcDateKey('2026-07-15T00:00:00Z')).toBe('2026-07-15');
    expect(utcDateKey('not-a-date')).toBeNull();
  });
});
