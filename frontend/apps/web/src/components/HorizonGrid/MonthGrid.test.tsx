import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';

import { calendarWindow } from './calendarWindow';
import { MonthGrid } from './MonthGrid';

const LA = 'America/Los_Angeles';
const window = calendarWindow('month', new Date('2026-10-15T19:00:00.000Z'), LA, 0);

function event(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'e1',
    title: 'Standup',
    description: null,
    startTime: '2026-10-15T16:00:00.000Z',
    endTime: '2026-10-15T16:30:00.000Z',
    isAllDay: false,
    status: 'confirmed',
    category: null,
    eventType: 'meeting',
    taskId: null,
    seriesMasterId: null,
    locationName: null,
    sourceSystem: 'google',
    externalSyncStatus: null,
    metadata: null,
    ...overrides,
  } as ScheduleEvent;
}

describe('MonthGrid', () => {
  it('draws every day of the grid with the month named', () => {
    render(<MonthGrid window={window} events={[]} timeZone={LA} />);

    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    expect(screen.getAllByTestId('month-day-cell')).toHaveLength(35);
    expect(screen.getByRole('gridcell', { name: 'Sunday, September 27' })).toBeInTheDocument();
  });

  it('lists what is on a day and folds the rest into "+N more"', () => {
    const onOpenDay = vi.fn();
    const events = ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      event({ id, title: `Event ${id}`, startTime: `2026-10-15T1${index}:00:00.000Z`, endTime: null }),
    );

    render(<MonthGrid window={window} events={events} timeZone={LA} onOpenDay={onOpenDay} />);

    const cell = screen.getByRole('gridcell', { name: 'Thursday, October 15' });
    expect(within(cell).getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(within(cell).getByRole('button', { name: '+2 more' }));
    expect(onOpenDay).toHaveBeenCalledTimes(1);
    expect(onOpenDay.mock.calls[0][0].toISOString()).toBe('2026-10-15T07:00:00.000Z');
  });

  it('selects the day as an all-day slot on a cell tap, but not through a chip or the number', () => {
    const onSelectSlot = vi.fn();
    const onOpenDay = vi.fn();

    render(
      <MonthGrid
        window={window}
        events={[event()]}
        timeZone={LA}
        onSelectSlot={onSelectSlot}
        onOpenDay={onOpenDay}
      />,
    );

    const cell = screen.getByRole('gridcell', { name: 'Thursday, October 15' });
    fireEvent.click(cell);
    expect(onSelectSlot).toHaveBeenCalledWith({
      instant: new Date('2026-10-15T07:00:00.000Z'),
      allDay: true,
    });

    fireEvent.click(within(cell).getByRole('listitem'));
    fireEvent.click(within(cell).getByRole('button', { name: 'Open Thursday, October 15' }));
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    expect(onOpenDay).toHaveBeenCalledTimes(1);
  });
});
