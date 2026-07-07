import { shiftIso } from '../dateUtil';

import { aggregate, applyScale, formatValue, type DaySample } from './answerMath';

function s(date: string, value: number, coverage = 1): DaySample {
  return { date, value, coverage };
}

describe('aggregate', () => {
  const samples = [s('2026-07-05', 2, 0.5), s('2026-07-07', 5, 1), s('2026-07-06', 3, 0.5)];

  it('returns a null value for an empty window (no fabricated zero)', () => {
    expect(aggregate('sum', [])).toEqual({ value: null, daysWithData: 0, meanCoverage: 0 });
  });

  it('sums, averages, maxes, and picks the latest by date', () => {
    expect(aggregate('sum', samples).value).toBe(10);
    expect(aggregate('avg', samples).value).toBeCloseTo(10 / 3, 5);
    expect(aggregate('max', samples).value).toBe(5);
    expect(aggregate('latest', samples).value).toBe(5); // 2026-07-07 row
  });

  it('counts active (value > 0) days', () => {
    const withZero = [s('2026-07-05', 0), s('2026-07-06', 4), s('2026-07-07', 1)];
    expect(aggregate('active_days', withZero).value).toBe(2);
  });

  it('reports days-with-data and mean coverage', () => {
    const result = aggregate('sum', samples);
    expect(result.daysWithData).toBe(3);
    expect(result.meanCoverage).toBeCloseTo((0.5 + 1 + 0.5) / 3, 5);
  });
});

describe('applyScale', () => {
  it('is identity without a scale and multiplies with one', () => {
    expect(applyScale(50)).toBe(50);
    expect(applyScale(0.5, 100)).toBe(50);
    expect(applyScale(120, 1 / 60)).toBeCloseTo(2, 5);
  });
});

describe('formatValue', () => {
  it('formats each display format', () => {
    expect(formatValue(3.6, 'int')).toBe('4');
    expect(formatValue(1.25, 'float1')).toBe('1.3');
    expect(formatValue(1.5, 'float2')).toBe('1.50');
    expect(formatValue(9.9, 'money')).toBe('9.90');
    expect(formatValue(0.3, 'signed2')).toBe('+0.30');
    expect(formatValue(-0.3, 'signed2')).toBe('-0.30');
  });
});

describe('shiftIso', () => {
  it('shifts calendar dates in UTC, across month boundaries', () => {
    expect(shiftIso('2026-07-07', -6)).toBe('2026-07-01');
    expect(shiftIso('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftIso('2026-07-07', 0)).toBe('2026-07-07');
  });
});
