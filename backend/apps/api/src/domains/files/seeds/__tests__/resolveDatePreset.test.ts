import { resolveDatePreset, resolveSavedSearchDateRange } from '../resolveDatePreset';

const NOW = new Date('2026-08-16T15:30:00.000Z');

describe('resolveDatePreset', () => {
  it('covers one-year-ago as the same local calendar day last year', () => {
    const { startTime, endTime } = resolveDatePreset('one-year-ago', NOW);
    const from = new Date(startTime);
    const to = new Date(endTime);

    expect(from.getFullYear()).toBe(NOW.getFullYear() - 1);
    expect(from.getMonth()).toBe(NOW.getMonth());
    expect(from.getDate()).toBe(to.getDate());
    expect(from.getHours()).toBe(0);
    expect(to.getHours()).toBe(23);
  });
});

describe('resolveSavedSearchDateRange', () => {
  it('prefers a rolling datePreset over stored start/end', () => {
    const range = resolveSavedSearchDateRange(
      {
        datePreset: 'last-week',
        startTime: '2000-01-01T00:00:00.000Z',
        endTime: '2000-01-02T00:00:00.000Z',
      },
      NOW,
    );

    expect(range.startTime).not.toBe('2000-01-01T00:00:00.000Z');
    expect(range.endTime).toBeDefined();
  });

  it('passes custom start/end through when no rolling preset is set', () => {
    expect(
      resolveSavedSearchDateRange({
        startTime: '2024-01-01T00:00:00.000Z',
        endTime: '2024-12-31T00:00:00.000Z',
      }),
    ).toEqual({
      startTime: '2024-01-01T00:00:00.000Z',
      endTime: '2024-12-31T00:00:00.000Z',
    });
  });
});
