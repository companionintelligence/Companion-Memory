import { describe, expect, it } from 'vitest';

import { formatAmount, formatMinor } from './money';

/**
 * Assertions here avoid pinning the host's default locale: `Intl` puts the
 * symbol on either side and groups with either `,` or `.` depending on it. What
 * must hold everywhere is the MAGNITUDE — which is the whole reason this module
 * exists — and that the currency is the row's own, not a dollar.
 */
describe('formatMinor', () => {
  it('divides a two-exponent currency by 100', () => {
    const formatted = formatMinor(1299, 'USD');

    expect(formatted).toMatch(/12[.,]99/);
    expect(formatted).toContain('$');
  });

  it('does NOT divide a currency with no minor unit — 1299 JPY is ¥1299, not ¥12.99', () => {
    // The bug this module was written to prevent: a hardcoded `/100` renders
    // every yen amount two orders of magnitude too small.
    const formatted = formatMinor(1299, 'JPY');

    expect(formatted).not.toMatch(/12[.,]99/);
    expect(formatted).toMatch(/1[.,\u00a0\u202f]?299/);
  });

  it('KRW has no minor unit either', () => {
    expect(formatMinor(50000, 'KRW')).toMatch(/50[.,\u00a0\u202f]?000/);
  });

  it('honours a three-exponent currency (Tunisian dinar) rather than assuming two', () => {
    // 1299 millimes is 1.299 TND. A `/100` would have said 12.99.
    const formatted = formatMinor(1299, 'TND');

    expect(formatted).toMatch(/1[.,]299/);
    expect(formatted).not.toMatch(/12[.,]99/);
  });

  it('renders a zero amount rather than treating it as absent', () => {
    // `0` is falsy; the guard has to be a null check or a free thing shows no
    // price at all.
    expect(formatMinor(0, 'USD')).toMatch(/0[.,]00/);
  });

  it('falls back to USD when the row carries an amount but no currency code', () => {
    expect(formatMinor(1299, null)).toContain('$');
    expect(formatMinor(1299, '  ')).toContain('$');
  });

  it('normalizes a lowercase code instead of throwing on it', () => {
    expect(formatMinor(1299, 'eur')).toContain('€');
  });

  it('spells out an unparseable code beside a plain amount rather than blanking the row', () => {
    expect(formatMinor(1299, 'not a currency')).toBe('12.99 NOT A CURRENCY');
  });

  it('returns null when there is nothing to show', () => {
    expect(formatMinor(null, 'USD')).toBeNull();
    expect(formatMinor(undefined, 'USD')).toBeNull();
    expect(formatMinor(Number.NaN, 'USD')).toBeNull();
    expect(formatMinor(Number.POSITIVE_INFINITY, 'USD')).toBeNull();
  });
});

describe('formatAmount', () => {
  it('takes MAJOR units — 120 EUR is €120, not €1.20', () => {
    // `ItemType.purchasePrice` / `currentValue` are Float majors, unlike the
    // receipt plane's integer minors.
    const formatted = formatAmount(120, 'EUR');

    expect(formatted).toMatch(/120[.,]00/);
    expect(formatted).toContain('€');
  });

  it('does not turn a JPY major into a fraction', () => {
    expect(formatAmount(1299, 'JPY')).toMatch(/1[.,\u00a0\u202f]?299/);
  });

  it('keeps the cents on a fractional amount', () => {
    expect(formatAmount(19.5, 'USD')).toMatch(/19[.,]50/);
  });

  it('falls back to USD with no code', () => {
    expect(formatAmount(120)).toContain('$');
  });

  it('spells out an unparseable code rather than blanking the row', () => {
    expect(formatAmount(120, 'dollars')).toBe('120 DOLLARS');
  });

  it('returns null when there is no amount', () => {
    expect(formatAmount(null, 'USD')).toBeNull();
    expect(formatAmount(undefined)).toBeNull();
    expect(formatAmount(Number.NaN, 'USD')).toBeNull();
  });

  it('renders a zero value rather than dropping it', () => {
    expect(formatAmount(0, 'USD')).toMatch(/0[.,]00/);
  });
});
