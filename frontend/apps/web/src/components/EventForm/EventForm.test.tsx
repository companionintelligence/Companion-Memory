import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlaceLookupResult } from '@/api/usePlaceLookup';

import { emptyEventDraft, type EventDraft } from './eventDraft';
import { EventForm } from './EventForm';

const PLAIN_BOX_ON_TOUCH = 'pointer-coarse:appearance-none';

function renderForm(overrides: Partial<EventDraft> = {}) {
  return render(<EventForm value={{ ...emptyEventDraft(), ...overrides }} onChange={() => {}} />);
}

// ═══ STARTS / ENDS USED TO RUN UNDER THE CLOCK BESIDE THEM ON iOS ═══
//
// WebKit sizes a native date or time control's `width: 100%` as the CONTENT box
// and adds its padding and border on top, whatever `box-sizing` says: on an
// iPhone the Starts input measured 214pt inside a 186pt cell and the At input
// 164pt inside a 136pt one. The date ran under the clock, and the clock ran off
// the right edge of the row. `min-w-0` and the flex cell cannot help — the box
// model is what overflows. Dropping the native appearance on touch devices makes
// both an ordinary border-box input again, and the native picker still opens.
//
// jsdom lays nothing out, so this pins the class that decides it.
describe('EventForm — native date and time controls on a touch device', () => {
  it('gives the Starts and Ends dates and both clocks a plain box', () => {
    renderForm();

    expect(screen.getByLabelText('Starts at')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Starts at')).toHaveClass(PLAIN_BOX_ON_TOUCH);
    expect(screen.getByLabelText('Ends at')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Ends at')).toHaveClass(PLAIN_BOX_ON_TOUCH);

    const clocks = [screen.getByLabelText('Start time'), screen.getByLabelText('End time')];

    for (const clock of clocks) {
      expect(clock).toHaveAttribute('type', 'time');
      expect(clock).toHaveClass(PLAIN_BOX_ON_TOUCH);
    }
  });

  it('keeps the dates plain when all-day takes the clocks away', () => {
    renderForm({ isAllDay: true });

    expect(screen.queryByLabelText('Start time')).toBeNull();
    expect(screen.queryByLabelText('End time')).toBeNull();
    expect(screen.getByLabelText('Starts at')).toHaveClass(PLAIN_BOX_ON_TOUCH);
    expect(screen.getByLabelText('Ends at')).toHaveClass(PLAIN_BOX_ON_TOUCH);
  });

  // The fix is for the native pickers only: a text, number or textarea field
  // has no such quirk and keeps its own appearance.
  it('leaves every other field alone', () => {
    renderForm();

    for (const label of ['Title', 'Kind', 'Category', 'Place', 'Latitude', 'Longitude', 'Description']) {
      expect(screen.getByLabelText(label)).not.toHaveClass(PLAIN_BOX_ON_TOUCH);
    }
  });
});

describe('EventForm — looking a place up', () => {
  it('shows no Look up without a lookup to call', () => {
    renderForm({ locationName: 'Ferry Building' });

    expect(screen.queryByRole('button', { name: /Look up/ })).not.toBeInTheDocument();
  });

  it('fills both coordinates from the match and names it, once there is a name to look up', async () => {
    const onChange = vi.fn();
    const lookupPlace = vi.fn().mockResolvedValue({
      status: 'ok',
      latitude: 37.7955,
      longitude: -122.3937,
      address: '1 Ferry Building, San Francisco',
      approximate: false,
    });
    const { rerender } = render(
      <EventForm value={emptyEventDraft()} onChange={onChange} lookupPlace={lookupPlace} />,
    );

    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();

    const draft = { ...emptyEventDraft(), locationName: 'Ferry Building' };
    rerender(<EventForm value={draft} onChange={onChange} lookupPlace={lookupPlace} />);
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Matched 1 Ferry Building/));
    expect(lookupPlace).toHaveBeenCalledWith('Ferry Building');
    expect(onChange).toHaveBeenCalledWith({ ...draft, latitude: '37.7955', longitude: '-122.3937' });
  });

  it('leaves the coordinates alone when the match is only the area around the name', async () => {
    // What the provider answered for a café: the middle of the city, at APPROXIMATE confidence.
    const onChange = vi.fn();
    const lookupPlace = vi.fn().mockResolvedValue({
      status: 'ok',
      latitude: 37.7749295,
      longitude: -122.4194155,
      address: 'San Francisco, CA, USA',
      approximate: true,
    });
    const draft = { ...emptyEventDraft(), locationName: 'Blue Bottle Coffee, San Francisco' };
    render(<EventForm value={draft} onChange={onChange} lookupPlace={lookupPlace} />);

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /Only found San Francisco, CA, USA, not that exact place, so the coordinates were not filled in/,
      ),
    );
    expect(onChange).not.toHaveBeenCalled();

    // Still one click away for someone who does mean the city.
    fireEvent.click(screen.getByRole('button', { name: 'use this area' }));

    expect(onChange).toHaveBeenCalledWith({ ...draft, latitude: '37.7749295', longitude: '-122.4194155' });
    expect(screen.getByRole('status')).toHaveTextContent(/Matched San Francisco, CA, USA/);
  });

  // The geocode throttle is shared with the import pipeline, so an answer can
  // arrive seconds after the click. The form stays editable meanwhile.
  it('keeps what was typed elsewhere while the lookup was out', async () => {
    let answer!: (result: PlaceLookupResult) => void;
    const lookupPlace = vi.fn(
      () =>
        new Promise<PlaceLookupResult>((resolve) => {
          answer = resolve;
        }),
    );
    const onChange = vi.fn();
    const draft = { ...emptyEventDraft(), locationName: 'Ferry Building' };
    const { rerender } = render(<EventForm value={draft} onChange={onChange} lookupPlace={lookupPlace} />);

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    const typed = { ...draft, title: 'Lunch with Ana' };
    rerender(<EventForm value={typed} onChange={onChange} lookupPlace={lookupPlace} />);
    await act(async () =>
      answer({
        status: 'ok',
        latitude: 37.7955,
        longitude: -122.3937,
        address: '1 Ferry Building, San Francisco',
        approximate: false,
      }),
    );

    expect(onChange).toHaveBeenCalledWith({ ...typed, latitude: '37.7955', longitude: '-122.3937' });
  });

  it('drops an answer for a name that is no longer in the box', async () => {
    let answer!: (result: PlaceLookupResult) => void;
    const lookupPlace = vi.fn(
      () =>
        new Promise<PlaceLookupResult>((resolve) => {
          answer = resolve;
        }),
    );
    const onChange = vi.fn();
    const draft = { ...emptyEventDraft(), locationName: 'Blue Bottle Coffee, San Francisco' };
    const { rerender } = render(<EventForm value={draft} onChange={onChange} lookupPlace={lookupPlace} />);

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    rerender(
      <EventForm
        value={{ ...draft, locationName: 'Ferry Building' }}
        onChange={onChange}
        lookupPlace={lookupPlace}
      />,
    );
    await act(async () =>
      answer({
        status: 'ok',
        latitude: 37.7749295,
        longitude: -122.4194155,
        address: 'San Francisco, CA, USA',
        approximate: true,
      }),
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeEnabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes the "use this area" offer away when the caller swaps in a new draft', async () => {
    const lookupPlace = vi.fn().mockResolvedValue({
      status: 'ok',
      latitude: 37.7749295,
      longitude: -122.4194155,
      address: '',
      approximate: true,
    });
    const onChange = vi.fn();
    const draft = { ...emptyEventDraft(), locationName: 'Blue Bottle Coffee, San Francisco' };
    const { rerender } = render(<EventForm value={draft} onChange={onChange} lookupPlace={lookupPlace} />);

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Only found the area around it,/),
    );

    // What TaskSlate does when the slot moves: a fresh draft, Place blank.
    rerender(<EventForm value={emptyEventDraft()} onChange={onChange} lookupPlace={lookupPlace} />);

    expect(screen.queryByRole('button', { name: 'use this area' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says when nothing matched, when lookups are not set up, and when the lookup itself failed', async () => {
    const draft = { ...emptyEventDraft(), locationName: 'Nowhere' };
    const lookupPlace = vi
      .fn()
      .mockResolvedValueOnce({ status: 'none' })
      .mockResolvedValueOnce({ status: 'unconfigured' })
      .mockResolvedValueOnce({ status: 'error' });
    const onChange = vi.fn();
    render(<EventForm value={draft} onChange={onChange} lookupPlace={lookupPlace} />);

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/No match/));

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/isn't set up on this appliance/),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Could not look that up/));
    expect(onChange).not.toHaveBeenCalled();
  });
});
