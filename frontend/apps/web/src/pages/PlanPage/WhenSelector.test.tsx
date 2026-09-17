import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { addLocalDays, localDateOf } from './taskSections';
import { WhenSelector } from './WhenSelector';

describe('WhenSelector', () => {
  it('picks the named day chips relative to the viewer local today', () => {
    const onPick = vi.fn();
    const today = localDateOf(new Date());

    render(<WhenSelector onPick={onPick} />);

    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));
    expect(onPick).toHaveBeenLastCalledWith(today);

    fireEvent.click(screen.getByRole('button', { name: /^tomorrow$/i }));
    expect(onPick).toHaveBeenLastCalledWith(addLocalDays(today, 1));

    fireEvent.click(screen.getByRole('button', { name: /^next week$/i }));
    expect(onPick).toHaveBeenLastCalledWith(addLocalDays(today, 7));
  });

  // Cancel was never clicked anywhere: regressed to a no-op — or worse, to
  // calling onPick — it would have shipped green.
  it('backs out through Cancel without rescheduling anything', () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();

    render(<WhenSelector onPick={onPick} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('omits Cancel when there is nothing to back out of', () => {
    render(<WhenSelector onPick={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  // The calendar input is the only reschedule route that bypasses the chips,
  // so it is the only one that can drift on its own.
  it('picks the exact day typed into the calendar input, unshifted', () => {
    const onPick = vi.fn();

    render(<WhenSelector onPick={onPick} />);

    fireEvent.change(screen.getByLabelText(/pick a day/i), { target: { value: '2099-03-05' } });

    expect(onPick).toHaveBeenCalledWith('2099-03-05');
  });

  // React swallows a change to the value an input already holds, so clearing a
  // never-touched input dispatches nothing and asserts nothing — the day has to
  // be picked first for the empty-value guard to run at all. Clearing a filled
  // date input is also the real gesture: the browser fires the same empty change
  // mid-typing, before a partial date is a date.
  it('ignores a cleared calendar input rather than rescheduling to nothing', () => {
    const onPick = vi.fn();

    render(<WhenSelector onPick={onPick} />);

    const input = screen.getByLabelText(/pick a day/i);

    fireEvent.change(input, { target: { value: '2099-03-05' } });
    fireEvent.change(input, { target: { value: '' } });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('2099-03-05');
  });
});
