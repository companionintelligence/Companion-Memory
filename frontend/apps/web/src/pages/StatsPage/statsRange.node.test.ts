import { describe, expect, it } from 'vitest';

import { DEFAULT_STATS_RANGE, rangeToBounds } from './statsRange';

describe('DEFAULT_STATS_RANGE', () => {
  it('is unbounded, matching the all-time tiles on the same page', () => {
    expect(DEFAULT_STATS_RANGE).toBe('all');
    expect(rangeToBounds(DEFAULT_STATS_RANGE)).toEqual({});
  });
});

describe('rangeToBounds', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');

  it('omits bounds for all-time', () => {
    expect(rangeToBounds('all', now)).toEqual({});
  });

  it('walks back 30 and 90 days', () => {
    expect(rangeToBounds('30d', now)).toEqual({
      from: '2026-07-17T12:00:00.000Z',
      to: '2026-08-16T12:00:00.000Z',
    });
    expect(rangeToBounds('90d', now)).toEqual({
      from: '2026-05-18T12:00:00.000Z',
      to: '2026-08-16T12:00:00.000Z',
    });
  });

  it('walks back one year', () => {
    expect(rangeToBounds('1y', now)).toEqual({
      from: '2025-08-16T12:00:00.000Z',
      to: '2026-08-16T12:00:00.000Z',
    });
  });
});
