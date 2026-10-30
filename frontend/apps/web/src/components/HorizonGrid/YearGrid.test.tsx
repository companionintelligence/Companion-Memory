import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { calendarWindow } from './calendarWindow';
import { YearGrid } from './YearGrid';

const LA = 'America/Los_Angeles';
const window = calendarWindow('year', new Date('2026-10-15T19:00:00.000Z'), LA);

describe('YearGrid', () => {
  it('draws twelve months, each day a way into its own view', () => {
    const onOpenDay = vi.fn();
    const onOpenMonth = vi.fn();

    render(<YearGrid window={window} timeZone={LA} onOpenDay={onOpenDay} onOpenMonth={onOpenMonth} />);

    const months = screen.getAllByRole('region');
    expect(months).toHaveLength(12);
    expect(months[0]).toHaveAccessibleName('January 2026');

    fireEvent.click(within(months[1]).getByRole('button', { name: 'Open Saturday, February 28' }));
    expect(onOpenDay.mock.calls[0][0].toISOString()).toBe('2026-02-28T08:00:00.000Z');

    fireEvent.click(within(months[11]).getByRole('button', { name: 'December' }));
    expect(onOpenMonth.mock.calls[0][0].toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });
});
