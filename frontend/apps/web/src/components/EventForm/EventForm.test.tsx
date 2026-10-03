import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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

    expect(screen.getByLabelText('Starts')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Starts')).toHaveClass(PLAIN_BOX_ON_TOUCH);
    expect(screen.getByLabelText('Ends')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Ends')).toHaveClass(PLAIN_BOX_ON_TOUCH);

    const clocks = screen.getAllByLabelText('At');

    expect(clocks).toHaveLength(2);

    for (const clock of clocks) {
      expect(clock).toHaveAttribute('type', 'time');
      expect(clock).toHaveClass(PLAIN_BOX_ON_TOUCH);
    }
  });

  it('keeps the dates plain when all-day takes the clocks away', () => {
    renderForm({ isAllDay: true });

    expect(screen.queryAllByLabelText('At')).toHaveLength(0);
    expect(screen.getByLabelText('Starts')).toHaveClass(PLAIN_BOX_ON_TOUCH);
    expect(screen.getByLabelText('Ends')).toHaveClass(PLAIN_BOX_ON_TOUCH);
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
