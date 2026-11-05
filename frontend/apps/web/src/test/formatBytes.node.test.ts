import { BINARY_UNITS, DECIMAL_UNITS, IEC_UNITS, formatBytes } from '@ci/common';
import { describe, expect, it } from 'vitest';

/**
 * The one byte formatter, in each of the shapes the surfaces used to carry
 * their own copy of. Every line here is what that surface printed before.
 */
describe('formatBytes', () => {
  it('writes the drawer shape by default: whole bytes, one decimal above', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(102400)).toBe('100.0 KB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
  });

  it('stops at the last unit it is given', () => {
    expect(formatBytes(1024 ** 5, { units: BINARY_UNITS })).toBe('1024.0 TB');
  });

  it('writes decimal units for the import inbox', () => {
    const decimal = { base: 1000 as const, units: DECIMAL_UNITS.slice(0, 4) };

    expect(formatBytes(12_000, decimal)).toBe('12.0 kB');
    expect(formatBytes(2_400_000_000, decimal)).toBe('2.4 GB');
    expect(formatBytes(42, decimal)).toBe('42 B');
  });

  it("writes the explorer's IEC units with the fraction trimmed", () => {
    const iec = { units: IEC_UNITS, decimals: 2, trimZeros: true };

    expect(formatBytes(1024, iec)).toBe('1 KiB');
    expect(formatBytes(1536, iec)).toBe('1.5 KiB');
    expect(formatBytes(1048576, iec)).toBe('1 MiB');
    expect(formatBytes(1234, { ...iec, decimals: 0 })).toBe('1 KiB');
  });

  it('starts at a unit when asked, as the model catalog does', () => {
    const model = {
      units: ['B', 'KB', 'MB', 'GB'],
      minUnit: 2,
      decimals: (unit: number) => (unit === 3 ? 1 : 0),
    };

    expect(formatBytes(2_583_085_056, model)).toBe('2.4 GB');
    expect(formatBytes(344_437_808, model)).toBe('328 MB');
    expect(formatBytes(12 * 1024 ** 3, model)).toBe('12.0 GB');
    expect(formatBytes(1000, model)).toBe('0 MB');
  });
});
