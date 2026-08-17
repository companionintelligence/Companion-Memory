import { describe, expect, it } from 'vitest';

import { inferRollingDatePreset, resolveDatePreset } from './datePresets';

const NOW = new Date('2026-08-08T15:30:00.000Z');

describe('resolveDatePreset', () => {
  it('covers yesterday as a single local calendar day', () => {
    const { from, to } = resolveDatePreset('yesterday', NOW);
    const fromDate = new Date(from);
    const toDate = new Date(to);

    expect(fromDate.getDate()).toBe(toDate.getDate());
    expect(fromDate.getMonth()).toBe(toDate.getMonth());
    expect(fromDate.getHours()).toBe(0);
    expect(toDate.getHours()).toBe(23);
  });

  it('covers one-year-ago as the same local calendar day last year', () => {
    const { from, to } = resolveDatePreset('one-year-ago', NOW);
    const fromDate = new Date(from);
    const toDate = new Date(to);

    expect(fromDate.getFullYear()).toBe(NOW.getFullYear() - 1);
    expect(fromDate.getMonth()).toBe(NOW.getMonth());
    expect(fromDate.getDate()).toBe(toDate.getDate());
  });

  it('round-trips through inferRollingDatePreset', () => {
    for (const preset of ['yesterday', 'last-week', 'last-month', 'one-year-ago'] as const) {
      const resolved = resolveDatePreset(preset, NOW);

      expect(inferRollingDatePreset(resolved.from, resolved.to, NOW)).toBe(preset);
    }
  });
});
