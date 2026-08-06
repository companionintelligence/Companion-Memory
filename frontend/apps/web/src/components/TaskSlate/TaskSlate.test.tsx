import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ScheduleCandidate } from '@/api/useScheduleCandidates';
import { CANDIDATE_DRAG_TYPE, EVENT_DRAG_TYPE, EVENT_EXTERNAL_DRAG_TYPE } from '@/lib/scheduleDrag';

import { TaskSlate } from './TaskSlate';

function candidate(overrides: Partial<ScheduleCandidate> = {}): ScheduleCandidate {
  return {
    id: 'c1',
    title: 'Book the dentist',
    description: null,
    rationale: 'You wrote this down.',
    rationaleSources: [{ kind: 'answer', id: 'a1', note: null }],
    windowStart: new Date(2026, 7, 3).toISOString(),
    windowEnd: new Date(2026, 7, 10).toISOString(),
    timeFlex: 'week',
    durationMinutes: 30,
    l0Class: null,
    fitScore: null,
    status: 'open',
    generator: 'braindump/llm',
    confidence: 0.9,
    ...overrides,
  };
}

/** jsdom has no DragEvent; hand-build one carrying our dataTransfer stub. */
function dragEventOn(
  node: HTMLElement,
  kind: 'dragOver' | 'drop' | 'dragStart' | 'dragEnd',
  types: string[],
  data: Record<string, string> = {},
) {
  const evt = createEvent[kind](node, {
    dataTransfer: {
      types,
      getData: (key: string) => data[key] ?? '',
      setData: () => {},
      dropEffect: '',
      effectAllowed: '',
    },
  });
  fireEvent(node, evt);

  return evt;
}

function panel(container: HTMLElement) {
  return container.querySelector('.rounded-xl') as HTMLElement;
}

const NOOP = { loading: false, onDecline: () => {}, onSnooze: () => {} };

describe('TaskSlate — taking a committed event back off the week', () => {
  it('returns an event dropped on the rail', () => {
    const onReturnEvent = vi.fn();
    const { container } = render(
      <TaskSlate candidates={[candidate()]} {...NOOP} onReturnEvent={onReturnEvent} />,
    );

    dragEventOn(panel(container), 'drop', [EVENT_DRAG_TYPE], {
      [EVENT_DRAG_TYPE]: JSON.stringify({ id: 'event-9', grabOffsetMs: 0 }),
    });

    expect(onReturnEvent).toHaveBeenCalledWith('event-9');
  });

  it('refuses an event a synced calendar owns', () => {
    // There is no candidate behind a mirrored row, so the server would reject
    // it; declining the drop here means the user learns before the gesture ends.
    const onReturnEvent = vi.fn();
    const { container } = render(
      <TaskSlate candidates={[candidate()]} {...NOOP} onReturnEvent={onReturnEvent} />,
    );

    dragEventOn(panel(container), 'drop', [EVENT_DRAG_TYPE, EVENT_EXTERNAL_DRAG_TYPE], {
      [EVENT_DRAG_TYPE]: JSON.stringify({ id: 'event-9', grabOffsetMs: 0, externallyOwned: true }),
    });

    expect(onReturnEvent).not.toHaveBeenCalled();
  });

  it('does not offer to take an externally-owned event, rather than refusing after the drop', () => {
    // getData is blanked during dragover, so returnability rides as a type KEY.
    // Without it the rail would promise "drop to take it off the week" and then
    // silently do nothing — a worse way to find out than never offering.
    const { container } = render(<TaskSlate candidates={[candidate()]} {...NOOP} onReturnEvent={() => {}} />);

    const mine = dragEventOn(panel(container), 'dragOver', [EVENT_DRAG_TYPE]);
    expect(mine.defaultPrevented).toBe(true);

    const theirs = dragEventOn(panel(container), 'dragOver', [EVENT_DRAG_TYPE, EVENT_EXTERNAL_DRAG_TYPE]);
    expect(theirs.defaultPrevented).toBe(false);
  });

  it('ignores a payload that is not ours', () => {
    const onReturnEvent = vi.fn();
    const { container } = render(
      <TaskSlate candidates={[candidate()]} {...NOOP} onReturnEvent={onReturnEvent} />,
    );

    dragEventOn(panel(container), 'drop', [EVENT_DRAG_TYPE], { [EVENT_DRAG_TYPE]: 'not json' });

    expect(onReturnEvent).not.toHaveBeenCalled();
  });

  it('takes no event drops when returning is not wired up', () => {
    const { container } = render(<TaskSlate candidates={[candidate()]} {...NOOP} />);

    expect(() =>
      dragEventOn(panel(container), 'drop', [EVENT_DRAG_TYPE], {
        [EVENT_DRAG_TYPE]: JSON.stringify({ id: 'event-9', grabOffsetMs: 0 }),
      }),
    ).not.toThrow();
  });
});

describe('TaskSlate — dragging a card away to dismiss it', () => {
  function startCardDrag(container: HTMLElement) {
    const card = container.querySelector('li[draggable]') as HTMLElement;
    dragEventOn(card, 'dragStart', [CANDIDATE_DRAG_TYPE]);

    return card;
  }

  it('offers the dismiss zone only while a card is in flight', () => {
    const { container } = render(<TaskSlate candidates={[candidate()]} {...NOOP} />);

    expect(screen.queryByText('drop to dismiss')).not.toBeInTheDocument();

    const card = startCardDrag(container);
    expect(screen.getByText('drop to dismiss')).toBeInTheDocument();

    // However the drag ends, the zone goes away — it must not strand on screen.
    dragEventOn(card, 'dragEnd', [CANDIDATE_DRAG_TYPE]);
    expect(screen.queryByText('drop to dismiss')).not.toBeInTheDocument();
  });

  it('declines the card dropped on it', () => {
    const onDecline = vi.fn();
    const { container } = render(
      <TaskSlate candidates={[candidate({ id: 'c7' })]} {...NOOP} onDecline={onDecline} />,
    );

    startCardDrag(container);
    const zone = screen.getByText('drop to dismiss').closest('div') as HTMLElement;

    dragEventOn(zone, 'drop', [CANDIDATE_DRAG_TYPE], { [CANDIDATE_DRAG_TYPE]: 'c7' });

    // `not_now` rather than `never`: the user dragged it away, they did not say
    // they never want to see it again. That is what the ✕ is for.
    expect(onDecline).toHaveBeenCalledWith('c7', 'not_now');
  });

  it('ignores a drop carrying no candidate', () => {
    const onDecline = vi.fn();
    const { container } = render(<TaskSlate candidates={[candidate()]} {...NOOP} onDecline={onDecline} />);

    startCardDrag(container);
    const zone = screen.getByText('drop to dismiss').closest('div') as HTMLElement;

    dragEventOn(zone, 'drop', [CANDIDATE_DRAG_TYPE], { [CANDIDATE_DRAG_TYPE]: '' });

    expect(onDecline).not.toHaveBeenCalled();
  });
});

describe('TaskSlate — the header hint', () => {
  it('tells you what to do with the cards that are there', () => {
    render(<TaskSlate candidates={[candidate()]} {...NOOP} />);

    expect(screen.getByText('drag one onto a day below')).toBeInTheDocument();
  });

  it('says nothing at all when the rail is empty', () => {
    // The slot is an affordance hint. It used to fall back to "unplaced" — a
    // noun describing the zero cards that are not there, sitting where an
    // instruction belongs. The empty-state paragraph is what explains an empty
    // rail.
    render(<TaskSlate candidates={[]} {...NOOP} />);

    expect(screen.queryByText('unplaced')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing waiting yet/)).toBeInTheDocument();
  });

  it('aligns the empty state to the top of the row, not its centre', () => {
    // `self-center` centred the copy against the whole compose column (textarea
    // plus the button beneath it), dropping it below the placeholder it reads
    // next to — and centred it horizontally once the row stacks on mobile.
    render(<TaskSlate candidates={[]} {...NOOP} />);

    const empty = screen.getByText(/Nothing waiting yet/);

    expect(empty.className).toContain('self-start');
    expect(empty.className).not.toContain('self-center');
  });
});
