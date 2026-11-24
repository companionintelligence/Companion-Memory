import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { SpendChart } from './LifeCharts';
import type { SpendRow } from './useStatsService';

function spendRow(overrides: Partial<SpendRow> & { merchant: string }): SpendRow {
  return {
    count: 1,
    totalMinor: 1000,
    avgMinor: 1000,
    currency: 'USD',
    sources: ['venmo'],
    ...overrides,
  };
}

beforeEach(() => {
  // jsdom reports every element as 0x0, which makes recharts' ResponsiveContainer
  // skip rendering its children entirely — there would be nothing to assert on.
  // A plain reassignment (not `vi.spyOn`) survives the config's `restoreMocks: true`.
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      width: 500,
      height: 280,
      top: 0,
      left: 0,
      bottom: 280,
      right: 500,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
});

describe('SpendChart', () => {
  it('says so when there is nothing to show, rather than an empty chart', () => {
    render(<SpendChart rows={[]} />);

    expect(screen.getByText(/No parseable payment amounts in this range/i)).toBeInTheDocument();
  });

  it('draws merchant bars, not a scatter plot, below the 3-row threshold', () => {
    const { container } = render(
      <SpendChart
        rows={[
          spendRow({ merchant: 'Cafe Nero', totalMinor: 2800, count: 4 }),
          spendRow({ merchant: 'Corner Store', totalMinor: 1200, count: 2 }),
        ]}
      />,
    );

    expect(screen.getByText('Cafe Nero')).toBeInTheDocument();
    expect(screen.getByText('Corner Store')).toBeInTheDocument();
    expect(container.querySelector('.recharts-scatter')).not.toBeInTheDocument();
  });

  it('switches to a scatter plot at 3 rows, plotting one point per merchant', () => {
    const rows = [
      spendRow({ merchant: 'Cafe Nero', count: 4, totalMinor: 2800, avgMinor: 700 }),
      spendRow({ merchant: 'Corner Store', count: 2, totalMinor: 1200, avgMinor: 600 }),
      spendRow({ merchant: 'Big Box Warehouse', count: 1, totalMinor: 15999, avgMinor: 15999 }),
    ];

    const { container } = render(<SpendChart rows={rows} />);

    // Neither merchant-bars row label nor its container renders in this branch.
    expect(screen.queryByText('Cafe Nero')).not.toBeInTheDocument();

    const points = container.querySelectorAll('.recharts-scatter-symbol');
    expect(points).toHaveLength(3);

    // Named, labelled axes — "Payments" (frequency) on X, "Amount" on Y — not
    // a chart with no context for what it's showing.
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('converts minor units (cents) to major units for the Y axis, not raw cents', () => {
    // A single very round total makes the resulting tick value predictable:
    // totalMinor 10000 -> $100.00, so at least one Y-axis tick should land on
    // (or straddle) a dollar amount, never a four-digit cent reading like "10000".
    const rows = [
      spendRow({ merchant: 'A', count: 3, totalMinor: 10000, avgMinor: 3333 }),
      spendRow({ merchant: 'B', count: 2, totalMinor: 2000, avgMinor: 1000 }),
      spendRow({ merchant: 'C', count: 5, totalMinor: 5000, avgMinor: 1000 }),
    ];

    render(<SpendChart rows={rows} />);

    // The Y axis is tick-formatted through `formatMinorUnits(Math.round(value * 100))` —
    // every rendered tick is therefore a currency string, and none is a bare
    // multi-digit number (which is what an un-converted cents value would look like).
    const tickTexts = Array.from(document.querySelectorAll('.recharts-yAxis-tick-labels text'))
      .map((el) => el.textContent ?? '')
      .filter(Boolean);

    expect(tickTexts.length).toBeGreaterThan(0);
    tickTexts.forEach((text) => expect(text).toMatch(/^\$[\d,]+\.\d{2}$/));
  });
});
