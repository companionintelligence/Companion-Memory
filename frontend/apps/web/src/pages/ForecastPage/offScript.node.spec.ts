import { describe, expect, it } from 'vitest';

import { offScriptFromHistory, offScriptLine } from './offScriptLine';

describe('offScriptLine', () => {
  it('stays quiet until miss rate or drift is real', () => {
    expect(
      offScriptLine({ weekday: 'Thursday', eveningOrNight: true, scored: 2, missed: 2, drift: false }),
    ).toBeNull();
    expect(
      offScriptLine({ weekday: 'Thursday', eveningOrNight: true, scored: 10, missed: 1, drift: false }),
    ).toBeNull();
    expect(
      offScriptLine({ weekday: 'Thursday', eveningOrNight: true, scored: 10, missed: 4, drift: false }),
    ).toBe('Tonight does not look like your usual Thursday.');
    expect(
      offScriptLine({ weekday: 'Friday', eveningOrNight: false, scored: 0, missed: 0, drift: true }),
    ).toBe('Today does not look like your usual Friday.');
  });

  it('reads history misses without exposing KL numbers', () => {
    const history = [
      {
        date: '2026-07-14',
        buckets: Array.from({ length: 8 }, (_, i) => ({
          bucketIndex: i,
          predictedL0: [{ label: 'WORK', probability: 0.9 }],
          actualL0: 'LEISURE',
        })),
      },
    ];

    expect(
      offScriptFromHistory({ historyDays: history, weekday: 'Tuesday', hour: 20, drift: false }),
    ).toBe('Tonight does not look like your usual Tuesday.');
  });
});
