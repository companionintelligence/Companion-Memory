import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';
import {
  cancelSchedulePointerDrag,
  endSchedulePointerDrag,
  startSchedulePointerDrag,
} from '@/lib/schedulePointerDrag';

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

/**
 * Pattern rhythm used to be a wash painted behind the day column, where it read
 * as a highlight on whatever chip sat over it and had no name at all. It is now
 * a strip on the time axis: same reading, somewhere it can be read.
 */
describe('VerticalCalendar — the rhythm strip', () => {
  it('sits left of the hours instead of behind the day', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={rhythmFor(MONDAY)} />);

    const strip = screen.getByTestId('vertical-rhythm-strip');
    const lane = screen.getByTestId('vertical-day-lane');

    expect(strip.children).toHaveLength(96);
    expect(strip.compareDocumentPosition(lane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing paints the forecast inside the column any more.
    expect(lane.querySelector('[style*="--primary"]')).toBeNull();
  });

  it('names what the day usually holds, so the cells are not the only telling', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={rhythmFor(MONDAY)} />);

    expect(screen.getByRole('img', { name: /Morning gym/ })).toBeInTheDocument();
  });

  it('claims nothing when there is no established pattern', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('vertical-rhythm-strip')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shimmers empty cells while Predict is still running', () => {
    render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} pipelineRunning />);

    const strip = screen.getByTestId('vertical-rhythm-strip');

    expect(screen.getByRole('img', { name: /still being built/i })).toBeInTheDocument();
    expect(strip.querySelectorAll('.rhythm-cell-waiting')).toHaveLength(96);
  });

  it('does not shimmer when the day already has a pattern', () => {
    render(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={rhythmFor(MONDAY)} pipelineRunning />,
    );

    expect(screen.getByTestId('vertical-rhythm-strip').querySelectorAll('.rhythm-cell-waiting')).toHaveLength(
      0,
    );
    expect(screen.getByRole('img', { name: /Morning gym/ })).toBeInTheDocument();
  });

  it('draws every day its own pattern, not one strip for the whole week', () => {
    const thursday = addDays(MONDAY, 3);

    const { rerender } = render(
      <VerticalCalendar start={MONDAY} days={7} events={[]} rhythm={rhythmFor(thursday)} />,
    );

    const withPattern = () =>
      screen
        .getAllByTestId('vertical-rhythm-strip')
        .filter((strip) => strip.getAttribute('role') === 'img');

    // Thursday's data lights up its own strip without anything being selected.
    expect(withPattern().length).toBeGreaterThan(0);

    // Selecting a different day used to move the single shared strip's focus.
    // Each day now draws its own pattern regardless, so selection changes nothing.
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
});

describe('VerticalCalendar — dropping a slate candidate', () => {
  function stubLaneHeights(container: HTMLElement, height = 1440, top = 0) {
    for (const lane of container.querySelectorAll('[data-testid="vertical-day-lane"]')) {
      (lane as HTMLElement).getBoundingClientRect = () =>
        ({ height, top, bottom: top + height, width: 100, left: 0, right: 100 }) as DOMRect;
    }
  }

  function dataTransfer(candidateId: string | null) {
    return {
      types: candidateId === null ? [] : ['application/x-ci-candidate'],
      getData: () => candidateId ?? '',
      setData: () => {},
      dropEffect: '',
      effectAllowed: '',
    };
  }

  function lanes(container: HTMLElement) {
    return [...container.querySelectorAll('[data-testid="vertical-day-lane"]')] as HTMLElement[];
  }

  function dropAt(lane: HTMLElement, clientY: number, candidateId: string | null) {
    const evt = createEvent.drop(lane, { dataTransfer: dataTransfer(candidateId) });
    Object.defineProperty(evt, 'clientY', { value: clientY });
    fireEvent(lane, evt);
  }

  it('reports the day and time the card was dropped on', () => {
    const onDrop = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={7} events={[]} rhythm={[]} onDropCandidate={onDrop} />,
    );
    stubLaneHeights(container);

    // Wednesday (third column), halfway down → midday.
    dropAt(lanes(container)[2], 720, 'cand-7');

    expect(onDrop).toHaveBeenCalledTimes(1);
    const [id, at] = onDrop.mock.calls[0];
    expect(id).toBe('cand-7');
    expect(at.getDate()).toBe(addDays(MONDAY, 2).getDate());
    expect(at.getHours()).toBe(12);
  });

  it('places the card where it was dropped, not at the start of the day', () => {
    const onDrop = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} onDropCandidate={onDrop} />,
    );
    stubLaneHeights(container);

    // 75% down → 18:00.
    dropAt(lanes(container)[0], 1080, 'cand-1');

    expect(onDrop.mock.calls[0][1].getHours()).toBe(18);
  });

  it('moves a committed event to the column and time it was dragged to', () => {
    const onMove = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={7} events={[event()]} rhythm={[]} onMoveEvent={onMove} />,
    );
    stubLaneHeights(container);

    const evt = createEvent.drop(lanes(container)[3], {
      dataTransfer: {
        types: ['application/x-ci-event'],
        getData: () => JSON.stringify({ id: 'e1', grabOffsetMs: 0 }),
        setData: () => {},
        dropEffect: '',
        effectAllowed: '',
      },
    });
    Object.defineProperty(evt, 'clientY', { value: 720 });
    fireEvent(lanes(container)[3], evt);

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

  it('accepts no drops at all when the grid is read-only', () => {
    const { container } = render(<VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} />);
    stubLaneHeights(container);

    expect(() => dropAt(lanes(container)[0], 720, 'cand-1')).not.toThrow();
  });
});

describe('VerticalCalendar — pointer drop from Possibilities', () => {
  const originalFromPoint = document.elementFromPoint;
  const originalFromPoints = document.elementsFromPoint;

  afterEach(() => {
    cancelSchedulePointerDrag();
    document.elementFromPoint = originalFromPoint;
    document.elementsFromPoint = originalFromPoints;
  });

  it('places a held card at the time under the finger', () => {
    const onDrop = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[]} rhythm={[]} onDropCandidate={onDrop} />,
    );

    const lane = container.querySelector('[data-schedule-drop-axis="y"]') as HTMLElement;
    lane.getBoundingClientRect = () =>
      ({
        height: 1440,
        top: 0,
        bottom: 1440,
        width: 100,
        left: 0,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    document.elementFromPoint = () => lane;

    act(() => {
      startSchedulePointerDrag({ kind: 'candidate', id: 'cand-1', title: 'Call Mum' }, 50, 720);
      endSchedulePointerDrag(50, 720);
    });

    expect(onDrop).toHaveBeenCalledTimes(1);
    const [id, at] = onDrop.mock.calls[0];
    expect(id).toBe('cand-1');
    expect(at.getHours()).toBe(12);
  });

  it('still places the card when the finger is over an event chip or a covering ghost', () => {
    const onDrop = vi.fn();
    const { container } = render(
      <VerticalCalendar start={MONDAY} days={1} events={[event()]} rhythm={[]} onDropCandidate={onDrop} />,
    );

    const lane = container.querySelector('[data-schedule-drop-axis="y"]') as HTMLElement;
    const chip = container.querySelector('[data-schedule-chip]') as HTMLElement;
    const ghost = document.createElement('div');
    lane.getBoundingClientRect = () =>
      ({
        height: 1440,
        top: 0,
        bottom: 1440,
        width: 100,
        left: 0,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    document.elementsFromPoint = () => [ghost, chip];
    document.elementFromPoint = () => ghost;

    act(() => {
      startSchedulePointerDrag({ kind: 'candidate', id: 'cand-1', title: 'Call Mum' }, 50, 720);
      endSchedulePointerDrag(50, 720);
    });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toBe('cand-1');
    expect(onDrop.mock.calls[0][1].getHours()).toBe(12);
  });
});
