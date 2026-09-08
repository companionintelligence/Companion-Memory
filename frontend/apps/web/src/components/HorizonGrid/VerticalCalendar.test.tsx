import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ForecastBucket } from '@/api/useForecastService';
import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';
import { EVENT_DRAG_TYPE } from '@/lib/scheduleDrag';

import { addDays, startOfLocalDay } from './nowNext';
import { VerticalCalendar } from './VerticalCalendar';

const MONDAY = startOfLocalDay(new Date(2026, 7, 3));

function event(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'e1',
    title: 'Standup',
    description: null,
    startTime: new Date(2026, 7, 3, 9, 0).toISOString(),
    endTime: new Date(2026, 7, 3, 9, 30).toISOString(),
    isAllDay: false,
    status: 'confirmed',
    category: 'WORK',
    locationName: null,
    ...overrides,
  };
}

/**
 * A forecast that claims every hour of one local day.
 *
 * Days are keyed by UTC date and a local day straddles two of them, so both
 * are seeded — otherwise the fixture only lights up in whichever timezone the
 * test happens to run in.
 */
function rhythmFor(day: Date, name = 'Morning gym'): RhythmDay[] {
  const clusters = [
    {
      clusterId: 'c1',
      name,
      l0Class: 'EXERCISE',
      pOccur: 0.9,
      scheduled: false,
      daypartProbs: [
        { label: 'night', probability: 0.9 },
        { label: 'morning', probability: 0.9 },
        { label: 'afternoon', probability: 0.9 },
        { label: 'evening', probability: 0.9 },
      ],
    },
  ];

  return [0, 1].map((offset) => ({
    date: new Date(day.getTime() + offset * 86_400_000).toISOString().slice(0, 10),
    dow: 'Mon',
    clusters,
  }));
}

describe('VerticalCalendar', () => {
  it('renders one column per day in the window', () => {
    render(<VerticalCalendar start={MONDAY} days={7} events={[]} rhythm={[]} />);

    expect(screen.getAllByTestId('vertical-day-lane')).toHaveLength(7);
  });

  it('renders a committed event on its day', () => {
    render(<VerticalCalendar start={MONDAY} days={7} events={[event()]} rhythm={[]} />);

    expect(screen.getByRole('listitem', { name: /Standup/ })).toBeInTheDocument();
  });

  it('sits a timed event at its hour rather than stretching the column', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} />);

    const chip = screen.getByRole('listitem', { name: /Standup/ });
    // 09:00 of 1440 minutes = 37.5% down the day.
    expect(chip.style.top).toBe('37.5%');
    expect(Number.parseFloat(chip.style.height)).toBeCloseTo((30 / 1440) * 100, 1);
  });

  it('keeps all-day events out of the hour grid', () => {
    render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[
          event({
            id: 'all',
            title: 'Offsite',
            isAllDay: true,
            startTime: MONDAY.toISOString(),
            endTime: addDays(MONDAY, 1).toISOString(),
          }),
        ]}
        rhythm={[]}
      />,
    );

    const allDay = screen.getByRole('list', { name: /All day on / });
    expect(allDay).toHaveTextContent('Offsite');
    expect(screen.getByTestId('vertical-day-lane').querySelector('[aria-label*="Offsite"]')).toBeNull();
  });

  it('renders an overnight event on both days it touches', () => {
    const overnight = event({
      id: 'flight',
      title: 'Flight → SFO',
      startTime: new Date(2026, 7, 3, 22, 0).toISOString(),
      endTime: new Date(2026, 7, 4, 6, 0).toISOString(),
    });

    render(<VerticalCalendar start={MONDAY} days={2} events={[overnight]} rhythm={[]} />);

    expect(screen.getAllByRole('listitem', { name: /Flight/ })).toHaveLength(2);
  });

  it('gives every chip a focusable handle and a name that carries the tooltip', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} />);

    const chip = screen.getByLabelText(/^Standup,/);
    expect(chip).toHaveAttribute('tabindex', '0');
    expect(chip.getAttribute('aria-label')).toContain('work');
    expect(chip.getAttribute('aria-label')).toMatch(/\d/);
  });

  it('opens the event tooltip in a dialog on tap when hover is unavailable', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('hover: none') || query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} />);

      fireEvent.click(screen.getByLabelText(/^Standup,/));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Standup');
      expect(dialog).toHaveTextContent('work');
    } finally {
      window.matchMedia = original;
    }
  });

  it('does not open a dialog on a pointer that can hover', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} />);

    fireEvent.click(screen.getByLabelText(/^Standup,/));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names an all-day event as such rather than inventing a time', () => {
    render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[
          event({
            title: 'Holiday',
            isAllDay: true,
            startTime: MONDAY.toISOString(),
            endTime: addDays(MONDAY, 1).toISOString(),
          }),
        ]}
        rhythm={[]}
      />,
    );

    expect(screen.getByRole('listitem', { name: /Holiday, all day/ })).toBeInTheDocument();
  });

  it('names the calendar and its day columns', () => {
    render(<VerticalCalendar start={MONDAY} days={7} events={[]} rhythm={[]} />);

    expect(screen.getByRole('group', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem', { name: /August/ })).toHaveLength(7);
    expect(screen.getAllByRole('button', { name: /^Show / })).toHaveLength(7);
  });

  it('omits the weekday header when the grid is a single day', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} />);

    expect(screen.queryByRole('button', { name: /^Show / })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: /All day on / })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: /August/ })).toBeInTheDocument();
  });
});

describe('VerticalCalendar — empty-slot selection', () => {
  function stubLaneHeight(lane: HTMLElement, height = 1440, top = 0) {
    lane.getBoundingClientRect = () =>
      ({ height, top, bottom: top + height, width: 100, left: 0, right: 100 }) as DOMRect;
  }

  it('reports the snapped time when an empty hour is clicked', () => {
    const onSelectSlot = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} onSelectSlot={onSelectSlot} />,
    );
    const lane = container.querySelector('[data-testid="vertical-day-lane"]') as HTMLElement;
    stubLaneHeight(lane);

    fireEvent.click(lane, { clientY: 720 });

    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const slot = onSelectSlot.mock.calls[0][0];
    expect(slot.allDay).toBe(false);
    expect(slot.instant.getHours()).toBe(12);
    expect(slot.instant.getMinutes()).toBe(0);
  });

  it('does not select a slot when an existing event is clicked', () => {
    const onSelectSlot = vi.fn();
    render(
      <VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} onSelectSlot={onSelectSlot} />,
    );

    fireEvent.click(screen.getByLabelText(/^Standup,/));

    expect(onSelectSlot).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('draws the selection line on the clicked hour', () => {
    render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[]}
        rhythm={[]}
        selectedSlot={{ instant: new Date(2026, 7, 3, 16, 15), allDay: false }}
      />,
    );

    expect(screen.getByTestId('slot-marker')).toBeInTheDocument();
  });

  it('selects all-day when the all-day row is clicked', () => {
    const onSelectSlot = vi.fn();
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} onSelectSlot={onSelectSlot} />);

    fireEvent.click(screen.getByTestId('vertical-all-day'));

    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const slot = onSelectSlot.mock.calls[0][0];
    expect(slot.allDay).toBe(true);
    expect(slot.instant.getTime()).toBe(MONDAY.getTime());
  });
});

/**
 * Predicted colour lives in the day column, behind committed chips — not as a
 * gutter of boxes to the left of the hours.
 */
describe('VerticalCalendar — the rhythm wash', () => {
  it('paints inside the day column, behind committed time', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={rhythmFor(MONDAY)} />);

    const wash = screen.getByTestId('vertical-rhythm-wash');
    const lane = screen.getByTestId('vertical-day-lane');
    const chip = screen.getByRole('listitem', { name: /Standup/ });

    expect(lane.contains(wash)).toBe(true);
    expect(wash.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('vertical-rhythm-strip')).not.toBeInTheDocument();
  });

  it('names what the day usually holds, so the cells are not the only telling', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={rhythmFor(MONDAY)} />);

    expect(screen.getByRole('img', { name: /Morning gym/ })).toBeInTheDocument();
  });

  it('claims nothing when there is no established pattern', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('vertical-rhythm-wash')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shimmers empty cells while Predict is still running', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} pipelineRunning />);

    const wash = screen.getByTestId('vertical-rhythm-wash');

    expect(screen.getByRole('img', { name: /still being built/i })).toBeInTheDocument();
    expect(wash.querySelectorAll('.rhythm-cell-waiting')).toHaveLength(96);
  });

  it('names every waiting wash for its own day rather than seven times the same', () => {
    render(<VerticalCalendar start={MONDAY} days={7} events={[]} rhythm={[]} pipelineRunning />);

    const washes = screen.getAllByTestId('vertical-rhythm-wash');
    const names = washes.map((wash) => wash.getAttribute('aria-label'));

    expect(washes).toHaveLength(7);
    expect(washes.every((wash) => wash.getAttribute('role') === 'img')).toBe(true);
    expect(names.every((name) => /still being built/i.test(name ?? ''))).toBe(true);
    expect(new Set(names).size).toBe(7);
    expect(
      screen.getByRole('img', { name: /^Predicted rhythm for Monday: still being built/ }),
    ).toBeInTheDocument();
  });

  it('does not shimmer when the day already has a pattern', () => {
    render(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={rhythmFor(MONDAY)} pipelineRunning />,
    );

    expect(screen.getByTestId('vertical-rhythm-wash').querySelectorAll('.rhythm-cell-waiting')).toHaveLength(
      0,
    );
    expect(screen.getByRole('img', { name: /Morning gym/ })).toBeInTheDocument();
  });

  it('draws every day its own pattern, not one wash for the whole week', () => {
    const thursday = addDays(MONDAY, 3);

    const { rerender } = render(
      <VerticalCalendar start={MONDAY} days={7} events={[]} rhythm={rhythmFor(thursday)} />,
    );

    const withPattern = () =>
      screen.getAllByTestId('vertical-rhythm-wash').filter((wash) => wash.getAttribute('role') === 'img');

    expect(withPattern().length).toBeGreaterThan(0);

    const before = withPattern().length;
    rerender(
      <VerticalCalendar
        start={MONDAY}
        days={7}
        events={[]}
        rhythm={rhythmFor(thursday)}
        selectedDay={MONDAY}
      />,
    );

    expect(withPattern().length).toBe(before);
  });

  function occupancyAt(day: Date, hour: number, label = 'WORK'): ForecastBucket[] {
    const at = new Date(day);
    at.setHours(hour, 0, 0, 0);

    return [
      {
        bucketIndex: hour * 4,
        startTime: at.toISOString(),
        l0Probs: [{ label, probability: 0.85 }],
        l1Probs: [{ label: 'focus block', probability: 0.7 }],
        l2Probs: null,
        q10: 0.6,
        q50: 0.85,
        q90: 0.95,
      },
    ];
  }

  it('paints occupancy bins on the day they fall on, not a second strip above the grid', () => {
    render(
      <VerticalCalendar start={MONDAY} days={2} events={[]} rhythm={[]} occupancy={occupancyAt(MONDAY, 9)} />,
    );

    const washes = screen.getAllByTestId('vertical-rhythm-wash');

    expect(washes).toHaveLength(2);
    expect(washes[0]).toHaveAttribute('aria-label', expect.stringMatching(/occupancy/i));
    expect(washes[0].querySelectorAll('[data-testid="occupancy-bin"]')).toHaveLength(1);
    expect(washes[1].querySelectorAll('[data-testid="occupancy-bin"]')).toHaveLength(0);
    expect(screen.queryByText(/Tomorrow's prediction band/)).not.toBeInTheDocument();
  });

  it('lets occupancy override climate on the day the histogram covers', () => {
    const { container } = render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[]}
        rhythm={rhythmFor(MONDAY)}
        occupancy={occupancyAt(MONDAY, 9, 'WORK')}
        colorMode="type"
      />,
    );

    const occupancyBin = screen.getByTestId('occupancy-bin') as HTMLElement;

    expect(occupancyBin.style.backgroundColor).toBe('var(--activity-1)');
    // Climate-only EXERCISE would have painted every cell --activity-2.
    expect(
      [...container.querySelectorAll('[data-testid="vertical-rhythm-wash"] [style*="opacity"]')].some(
        (cell) => (cell as HTMLElement).style.backgroundColor === 'var(--activity-2)',
      ),
    ).toBe(false);
  });
});

/**
 * Dragging a chip to another hour is the MOUSE gesture — HTML5 drag-and-drop.
 * Placing a Possibilities card by dragging it here was retired with #2529 (the
 * empty-slot click replaced it), so a candidate payload has no producer and no
 * longer has a branch here either.
 */
describe('VerticalCalendar — moving a committed event by drag', () => {
  function stubLaneHeights(container: HTMLElement, height = 1440, top = 0) {
    for (const lane of container.querySelectorAll('[data-testid="vertical-day-lane"]')) {
      (lane as HTMLElement).getBoundingClientRect = () =>
        ({ height, top, bottom: top + height, width: 100, left: 0, right: 100 }) as DOMRect;
    }
  }

  function eventTransfer(payload: string | null) {
    return {
      types: payload === null ? [] : [EVENT_DRAG_TYPE],
      getData: () => payload ?? '',
      setData: () => {},
      dropEffect: '',
      effectAllowed: '',
    };
  }

  function lanes(container: HTMLElement) {
    return [...container.querySelectorAll('[data-testid="vertical-day-lane"]')] as HTMLElement[];
  }

  function dropAt(lane: HTMLElement, clientY: number, payload: string | null) {
    const evt = createEvent.drop(lane, { dataTransfer: eventTransfer(payload) });
    Object.defineProperty(evt, 'clientY', { value: clientY });
    fireEvent(lane, evt);
  }

  function dragOverAt(lane: HTMLElement, clientY: number) {
    const evt = createEvent.dragOver(lane, { dataTransfer: eventTransfer('{}') });
    Object.defineProperty(evt, 'clientY', { value: clientY });
    fireEvent(lane, evt);
  }

  // jsdom has no DragEvent, so createEvent falls back to plain Event and drops
  // the `relatedTarget` init — it has to be planted on the instance.
  function dragLeaveTowards(lane: HTMLElement, relatedTarget: Node | null) {
    const evt = createEvent.dragLeave(lane, { dataTransfer: eventTransfer(null) });
    Object.defineProperty(evt, 'relatedTarget', { value: relatedTarget });
    fireEvent(lane, evt);
  }

  it('moves a committed event to the column and time it was dragged to', () => {
    const onMove = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={7} events={[event()]} rhythm={[]} onMoveEvent={onMove} />,
    );
    stubLaneHeights(container);

    dropAt(lanes(container)[3], 720, JSON.stringify({ id: 'e1', grabOffsetMs: 0 }));

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, at] = onMove.mock.calls[0];
    expect(id).toBe('e1');
    expect(at.getDate()).toBe(addDays(MONDAY, 3).getDate());
    expect(at.getHours()).toBe(12);
  });

  it('makes event chips draggable only when moving is wired up', () => {
    const { container: fixed } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} />,
    );
    expect(fixed.querySelector('[draggable="true"]')).toBeNull();

    const { container: movable } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} onMoveEvent={() => {}} />,
    );
    expect(movable.querySelector('[draggable="true"]')).not.toBeNull();
  });

  /**
   * ═══ WHAT THIS USED TO DO ═══
   * Stamp a third `application/x-ci-event-external` key on every drag of a
   * synced chip, for a drag-to-unschedule rail that was never built. Nothing
   * has ever read it (or the matching `externallyOwned` payload field).
   */
  it('carries only the payload a drop actually reads', () => {
    render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[event({ sourceSystem: 'google_calendar' })]}
        rhythm={[]}
        onMoveEvent={() => {}}
      />,
    );

    const chip = screen.getByLabelText(/^Standup,/);
    const data: Record<string, string> = {};
    const evt = createEvent.dragStart(chip, {
      dataTransfer: {
        setData: (key: string, value: string) => {
          data[key] = value;
        },
        getData: () => '',
        types: [],
        effectAllowed: '',
      },
    });
    fireEvent(chip, evt);

    expect(Object.keys(data).sort()).toEqual([EVENT_DRAG_TYPE, 'text/plain'].sort());
    expect(JSON.parse(data[EVENT_DRAG_TYPE])).toEqual({ id: 'e1', grabOffsetMs: expect.any(Number) });
  });

  it('accepts no drops at all when the grid is read-only', () => {
    const { container } = render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} />);
    stubLaneHeights(container);

    expect(() =>
      dropAt(lanes(container)[0], 720, JSON.stringify({ id: 'e1', grabOffsetMs: 0 })),
    ).not.toThrow();
  });

  /**
   * ═══ WHAT THIS USED TO DO ═══
   * Clear the marker on any dragleave. dragenter/dragover bubble up from the
   * chips inside the lane, so dragging across a day that already held an event
   * made the slot line and its time label flicker.
   */
  it('keeps the drop marker while the drag crosses a chip inside the same lane', () => {
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} onMoveEvent={() => {}} />,
    );
    stubLaneHeights(container);

    const lane = lanes(container)[0];
    const chip = lane.querySelector('[data-schedule-chip]') as HTMLElement;

    dragOverAt(lane, 720);
    expect(screen.getByTestId('slot-marker')).toBeInTheDocument();

    dragLeaveTowards(lane, chip);
    expect(screen.getByTestId('slot-marker')).toBeInTheDocument();

    dragLeaveTowards(lane, document.body);
    expect(screen.queryByTestId('slot-marker')).not.toBeInTheDocument();
  });
});

/**
 * HTML5 drag never fires on touch, so on a coarse pointer the chip's dialog is
 * the only handle a phone has on a placed event. It used to be read-only.
 */
describe('VerticalCalendar — moving an event without a drag', () => {
  function withCoarsePointer(run: () => void) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('hover: none') || query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      run();
    } finally {
      window.matchMedia = original;
    }
  }

  it('reschedules from the tap dialog through the same callback the drop uses', async () => {
    const onMove = vi.fn();

    withCoarsePointer(() => {
      render(
        <VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} onMoveEvent={onMove} />,
      );

      fireEvent.click(screen.getByLabelText(/^Standup,/));

      const dialog = screen.getByRole('dialog');
      // Pre-filled with where the event already is, so a move is one field.
      expect(within(dialog).getByLabelText('Move to date')).toHaveValue('2026-08-03');
      expect(within(dialog).getByLabelText('Move to time')).toHaveValue('09:00');

      fireEvent.change(within(dialog).getByLabelText('Move to date'), { target: { value: '2026-08-05' } });
      fireEvent.change(within(dialog).getByLabelText('Move to time'), { target: { value: '14:30' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    });

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, at] = onMove.mock.calls[0];
    expect(id).toBe('e1');
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(7);
    expect(at.getDate()).toBe(5);
    expect(at.getHours()).toBe(14);
    expect(at.getMinutes()).toBe(30);
  });

  it('offers no move on a read-only grid', () => {
    withCoarsePointer(() => {
      render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} />);

      fireEvent.click(screen.getByLabelText(/^Standup,/));

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).queryByRole('button', { name: 'Move' })).not.toBeInTheDocument();
    });
  });

  /**
   * `(hover: none), (pointer: coarse)` is a claim about the pointer, not about
   * whether a finger will be used. A touchscreen laptop answers false to both,
   * so gating the dialog on that query left hybrid devices with no reschedule
   * at all: HTML5 drag still does not fire from a finger, and the only other
   * route was hidden. Wherever there is something to do, a click reaches it.
   */
  it('offers the dialog on a pointer that reports hover, so a hybrid device is not stranded', () => {
    const onMove = vi.fn();

    render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} onMoveEvent={onMove} />);

    fireEvent.click(screen.getByLabelText(/^Standup,/));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Move to time'), { target: { value: '11:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][1].getHours()).toBe(11);
  });

  /**
   * The all-day row sits outside the hour grid, so no drop can ever land there
   * and the chip's peek carried no actions on any device — an all-day event was
   * unmovable from this surface, full stop.
   */
  it('moves an all-day event, which no drop can reach', () => {
    const onMove = vi.fn();

    render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[
          event({
            id: 'all',
            title: 'Offsite',
            isAllDay: true,
            startTime: MONDAY.toISOString(),
            endTime: addDays(MONDAY, 1).toISOString(),
          }),
        ]}
        rhythm={[]}
        onMoveEvent={onMove}
      />,
    );

    fireEvent.click(screen.getByRole('listitem', { name: /^Offsite, all day/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Move to date')).toHaveValue('2026-08-03');
    // An all-day event has no clock to move, so it is not offered one.
    expect(within(dialog).queryByLabelText('Move to time')).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Move to date'), { target: { value: '2026-08-07' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, at] = onMove.mock.calls[0];
    expect(id).toBe('all');
    expect(at.getDate()).toBe(7);
    expect(at.getHours()).toBe(0);
  });

  /**
   * A folded event has no chip of its own to grab or to tap, so on a busy day
   * the cluster was a dead end: read the list, and that was all.
   */
  it('moves an event folded into a micro-cluster', () => {
    const onMove = vi.fn();
    const tick = (id: string, title: string, minute: number) =>
      event({
        id,
        title,
        sourceSystem: 'ci-browser-extension',
        startTime: new Date(2026, 7, 3, 9, minute).toISOString(),
        endTime: new Date(2026, 7, 3, 9, minute + 5).toISOString(),
      });

    render(
      <VerticalCalendar
        start={MONDAY}
        days={1}
        events={[tick('m1', 'Tab one', 0), tick('m2', 'Tab two', 10)]}
        rhythm={[]}
        onMoveEvent={onMove}
      />,
    );

    fireEvent.click(screen.getByRole('listitem', { name: '2 overlapping activities' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Move Tab two to date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(within(dialog).getByLabelText('Move Tab two to time'), { target: { value: '14:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Tab two' }));

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, at] = onMove.mock.calls[0];
    expect(id).toBe('m2');
    expect(at.getDate()).toBe(5);
    expect(at.getHours()).toBe(14);
    expect(at.getMinutes()).toBe(30);
  });
});

/**
 * The toggle upstream was only ever proved as far as the legend and a stubbed
 * prop hand-off, so a `colorMode` that arrived here and went no further — never
 * reaching `eventColor` or the rhythm cells — would have shipped green.
 */
describe('VerticalCalendar — colorMode reaches the ink', () => {
  // EXERCISE is --activity-2; google_calendar takes source slot 1, --activity-1.
  // Two readings of one event that must not resolve to the same colour.
  const gym = event({ id: 'g1', title: 'Gym session', category: null, sourceSystem: 'google_calendar' });

  function litRhythmCell(container: HTMLElement): HTMLElement {
    const cell = container.querySelector(
      '[data-testid="vertical-rhythm-wash"] [style*="opacity"]',
    ) as HTMLElement | null;

    expect(cell).not.toBeNull();

    return cell as HTMLElement;
  }

  it('colours the chip by activity class in type mode and by connector in source mode', () => {
    const { container, rerender } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[gym]} rhythm={[]} colorMode="type" />,
    );

    expect(screen.getByLabelText(/^Gym session,/).style.borderLeftColor).toBe('var(--activity-2)');

    rerender(<VerticalCalendar start={MONDAY} days={1} events={[gym]} rhythm={[]} colorMode="source" />);

    expect(screen.getByLabelText(/^Gym session,/).style.borderLeftColor).toBe('var(--activity-1)');
    expect(container.querySelector('[style*="--activity-2"]')).toBeNull();
  });

  it('paints the rhythm strip by class in type mode and drops to the theme hue in source mode', () => {
    // A prediction came from no calendar, so source mode has nothing to say
    // about it and must not invent an answer.
    const { container, rerender } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={rhythmFor(MONDAY)} colorMode="type" />,
    );

    expect(litRhythmCell(container).style.backgroundColor).toBe('var(--activity-2)');

    rerender(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={rhythmFor(MONDAY)} colorMode="source" />,
    );

    expect(litRhythmCell(container).style.backgroundColor).toBe('var(--primary)');
  });
});
