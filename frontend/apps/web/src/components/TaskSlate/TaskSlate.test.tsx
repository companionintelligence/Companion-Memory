import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { groupIntoSections } from '@/pages/PlanPage/taskSections';
import type { PlanTask } from '@/pages/PlanPage/usePlanTasks';
import { renderWithProviders } from '@/test/renderWithProviders';

import { TaskSlateDrawer } from './TaskSlate';

const TODAY = '2026-08-23';

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 't1',
    title: 'Book the dentist',
    status: 'open',
    priority: 3,
    ...overrides,
  };
}

function backlog(tasks: PlanTask[]) {
  return groupIntoSections(tasks, TODAY).filter(
    (section) => section.key === 'proposed' || section.key === 'unscheduled',
  );
}

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const NOOP = { loading: false };

/**
 * The slot you clicked on the calendar. Everything the drawer sends is dated
 * from it, so the mutation assertions below read straight off these numbers.
 */
const SLOT = { instant: new Date(2026, 7, 6, 16, 15), allDay: false };

const CREATE_EVENT = gql(`
  mutation CreateEvent($input: CreateEventInput!) {
    createEvent(input: $input) {
      id
      title
      description
      startTime
      endTime
      eventType
      locationName
    }
  }
`);

/** A create mock that records the input it was called with. */
function createMock(capture: (input: Record<string, unknown>) => void): MockedResponse {
  return {
    request: { query: CREATE_EVENT },
    variableMatcher: (variables: { input: Record<string, unknown> }) => {
      capture(variables.input);

      return true;
    },
    result: {
      data: {
        createEvent: {
          __typename: 'EventType',
          id: 'event-1',
          title: 'Coffee with Sam',
          description: null,
          startTime: new Date(2026, 7, 6, 16, 15).toISOString(),
          endTime: null,
          eventType: null,
          locationName: null,
        },
      },
    },
  } as unknown as MockedResponse;
}

describe('TaskSlateDrawer — Plan backlog', () => {
  afterEach(() => setViewport(false));

  it('stays shut until it is asked for', () => {
    renderWithProviders(
      <TaskSlateDrawer
        open={false}
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([task({ status: 'proposed' })])}
        {...NOOP}
      />,
    );

    expect(screen.queryByText('Book the dentist')).not.toBeInTheDocument();
  });

  it('shows Proposed and Unscheduled from the same bucketing as Plan, one at a time', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'p1', title: 'Try this', status: 'proposed' }),
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    expect(await screen.findByRole('tab', { name: /^proposed/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Try this')).toBeInTheDocument();
    expect(screen.queryByText('Call Mum')).not.toBeInTheDocument();
    expect(screen.queryByText(/scheduled on calendar/i)).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /unscheduled/i }), { button: 0 });

    expect(await screen.findByText('Call Mum')).toBeInTheDocument();
    expect(screen.queryByText('Try this')).not.toBeInTheDocument();
  });

  it('does not put scheduled or done work on the rail', () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({
            id: 's1',
            title: 'Already placed',
            scheduledFor: '2026-08-24',
            placedOnCalendar: true,
            dueAt: '2026-08-24T17:00:00.000Z',
          }),
          task({ id: 'd1', title: 'Finished', status: 'done' }),
        ])}
        {...NOOP}
      />,
    );

    expect(screen.queryByText('Already placed')).not.toBeInTheDocument();
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing in Proposed or Unscheduled/)).toBeInTheDocument();
  });

  /**
   * ═══ WHAT THIS USED TO DO ═══
   * Cards carried a whole drag subsystem — `draggable` + `dragstart` on a
   * mouse, a hold-to-drag pointer protocol and a six-dot handle on touch. #2529
   * replaced dropping a card on a day with clicking an empty slot, and nothing
   * has rendered a draggable card since.
   */
  it('lists the backlog as click-to-place cards, with no drag affordance at all', async () => {
    const onPlace = vi.fn();

    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([task({ id: 'p1', title: 'Try this', status: 'proposed' })])}
        {...NOOP}
        onPlace={onPlace}
      />,
    );

    const card = (await screen.findByRole('button', { name: /Add Try this at this time/ })) as HTMLElement;

    expect(card).not.toHaveAttribute('draggable');
    expect(
      screen.queryByRole('button', { name: /drag try this onto the calendar/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/drag/i)).not.toBeInTheDocument();

    fireEvent.click(card);
    expect(onPlace).toHaveBeenCalledWith('p1');
  });

  it('offers dismiss only on proposed cards', async () => {
    const onDismissProposed = vi.fn();

    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'p1', title: 'Try this', status: 'proposed' }),
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' }),
        ])}
        {...NOOP}
        onDismissProposed={onDismissProposed}
      />,
    );

    fireEvent.click(await screen.findByLabelText('Dismiss Try this'));
    expect(onDismissProposed).toHaveBeenCalledWith('p1');

    fireEvent.mouseDown(screen.getByRole('tab', { name: /unscheduled/i }), { button: 0 });

    expect(await screen.findByText('Call Mum')).toBeInTheDocument();
    expect(screen.queryByLabelText('Dismiss Call Mum')).not.toBeInTheDocument();
  });

  /**
   * ═══ WHAT THIS TEST USED TO CHECK ═══
   * That the slate borrowed the Plan board's subtree-aware `section.count`, so
   * both surfaces printed the same number. They did — over lists of different
   * lengths. The board renders every child nested under its root; this rail
   * renders roots only, so "3" sat above a single card. A badge answers for
   * the surface it is on: the slate counts what it lists, and the subtree work
   * it does not list is named rather than silently folded into the badge.
   */
  it('counts the cards it lists, not the subtree hidden behind them', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'u1', title: 'Plan the trip', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'u2', title: 'Book flights', parentId: 'u1', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'u3', title: 'Renew passport', parentId: 'u1', dueAt: '2026-08-20T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    const tab = await screen.findByRole('tab', { name: /unscheduled/i });

    expect(within(tab).getByText('1')).toBeInTheDocument();
    expect(within(tab).queryByText('3')).not.toBeInTheDocument();
    // The two children are overdue-carrying work on the board, not on this
    // list — so the tab claims no overdue of its own.
    expect(within(tab).queryByText(/overdue/i)).not.toBeInTheDocument();

    // One card, and the hidden pair accounted for where the reader can see it.
    expect(screen.getByText('Plan the trip')).toBeInTheDocument();
    expect(screen.queryByText('Book flights')).not.toBeInTheDocument();
    expect(screen.getByText(/Plan nests 2 subtasks under these/)).toBeInTheDocument();
    expect(screen.getByText(/1 overdue/)).toBeInTheDocument();
  });

  /**
   * The disclosure is sized by `section.count - section.tasks.length`, and
   * `count` spans the whole subtree at every status — a `Section` hands this
   * rail the subtree's size, never its rows, so a ticked-off child cannot be
   * subtracted out from here. It therefore has to say what it spans: a rail
   * called Possibilities that reports "1 nested subtask" over a finished one
   * is claiming work that nobody has left to do.
   */
  it('does not sell a finished subtask as outstanding nested work', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'u1', title: 'Plan the trip', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'u2', title: 'Book flights', parentId: 'u1', status: 'done' }),
        ])}
        {...NOOP}
      />,
    );

    expect(await screen.findByText('Plan the trip')).toBeInTheDocument();
    expect(screen.queryByText(/1 nested subtask, on Plan/)).not.toBeInTheDocument();
    expect(screen.getByText(/Plan nests 1 subtask under these, done or not/)).toBeInTheDocument();
    // Nothing here is overdue, and the done child must not make it look so.
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  /**
   * The overdue hint is a badge like any other: it has to describe the cards
   * under it. Counting the subtree put "2 overdue" above a single overdue
   * card, with the second overdue row nested inside an upcoming one.
   */
  it('warns about overdue cards it shows, and names nested overdue separately', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'u1', title: 'Plan the trip', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'u2', title: 'Renew passport', parentId: 'u1', dueAt: '2026-08-20T17:00:00.000Z' }),
          task({ id: 'o1', title: 'Pay the bill', dueAt: '2026-08-20T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    const tab = await screen.findByRole('tab', { name: /unscheduled/i });

    expect(within(tab).getByText('2')).toBeInTheDocument();
    expect(within(tab).getByText('1 overdue')).toBeInTheDocument();
    expect(within(tab).queryByText('2 overdue')).not.toBeInTheDocument();

    const overdueLane = screen.getByRole('heading', { name: /^overdue/i });

    expect(within(overdueLane).getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/Plan nests 1 subtask under these/)).toBeInTheDocument();
  });

  /**
   * Proposed has no Overdue lane at all (`LANE_ORDER.proposed`), so the lane
   * lookup in `listedInSlate` falls through to `?? 0` and every overdue row the
   * section counts is, by construction, a hidden child. Nothing on this tab may
   * claim overdue of its own — a proposed root is never overdue itself — but the
   * child still has to be named somewhere, and the nested line is that place.
   */
  it('keeps a proposed root free of an overdue badge and names the overdue child instead', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'p1', title: 'Try this', status: 'proposed' }),
          task({ id: 'p2', title: 'Renew passport', parentId: 'p1', dueAt: '2026-08-20T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    const tab = await screen.findByRole('tab', { name: /^proposed/i });

    expect(within(tab).getByText('1')).toBeInTheDocument();
    expect(within(tab).queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^overdue/i })).not.toBeInTheDocument();

    expect(screen.getByText(/Plan nests 1 subtask under these, done or not/)).toBeInTheDocument();
    expect(screen.getByText(/· 1 overdue/)).toBeInTheDocument();
  });

  /**
   * The empty copy is a claim about the rail, so it has to follow what the rail
   * lists. `section.count` is subtree-aware and this surface renders roots only,
   * so counting it would open a tab strip over a column with no cards in it and
   * swallow the "nothing waiting" line that belongs there.
   */
  it('calls a section with no roots empty, however big its subtree count is', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={[
          { key: 'unscheduled', label: 'Unscheduled', lanes: [], tasks: [], count: 2, overdueCount: 1 },
        ]}
        {...NOOP}
      />,
    );

    expect(await screen.findByText(/Nothing in Proposed or Unscheduled/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  /** Lane headings carry the same kind of number, so they answer the same way. */
  it('sizes each lane heading by the cards in that lane', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'u1', title: 'Plan the trip', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'u2', title: 'Book flights', parentId: 'u1', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'u3', title: 'Call Mum', dueAt: '2026-08-26T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    const upcoming = await screen.findByRole('heading', { name: /^upcoming/i });

    expect(within(upcoming).getByText('2')).toBeInTheDocument();
    expect(within(upcoming).queryByText('3')).not.toBeInTheDocument();
  });

  it('lists overdue after upcoming instead of pinning it to the column foot', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={backlog([
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'o1', title: 'Pay the bill', dueAt: '2026-08-20T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    const upcoming = await screen.findByRole('heading', { name: /^upcoming/i });
    const overdue = screen.getByRole('heading', { name: /^overdue/i });

    expect(upcoming.compareDocumentPosition(overdue) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(overdue.parentElement).not.toHaveClass('mt-auto');
  });
});

describe('TaskSlateDrawer — failed and loading fetches', () => {
  afterEach(() => setViewport(false));

  it('says the plan failed rather than that there is nothing waiting', async () => {
    renderWithProviders(
      <TaskSlateDrawer open onOpenChange={() => {}} slot={SLOT} sections={[]} loading={false} error />,
    );

    expect(await screen.findByText(/Could not load your plan/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in Proposed or Unscheduled/)).not.toBeInTheDocument();
  });

  it('says it is loading only while there is nothing to show yet', async () => {
    renderWithProviders(<TaskSlateDrawer open onOpenChange={() => {}} slot={SLOT} sections={[]} loading />);

    expect(await screen.findByText(/Loading your plan/)).toBeInTheDocument();
  });

  it('does not tell an empty drawer to drop anything on a day', async () => {
    renderWithProviders(<TaskSlateDrawer open onOpenChange={() => {}} slot={SLOT} sections={[]} {...NOOP} />);

    expect(await screen.findByText(/Nothing in Proposed or Unscheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/drop onto a day/)).not.toBeInTheDocument();
  });

  it('shows the labeled empty prediction when HBPE has nothing to say', async () => {
    renderWithProviders(<TaskSlateDrawer open onOpenChange={() => {}} slot={SLOT} sections={[]} {...NOOP} />);

    expect(await screen.findByText('No predictions available')).toBeInTheDocument();
  });
});

/**
 * "New event" writes straight to ci.events from the slot the user pointed at.
 * The whole point of the flow is that the time comes from the calendar rather
 * than from a date picker, so what reaches the mutation is the assertion that
 * matters — a timezone or field-name slip here creates a silently wrong event.
 */
describe('TaskSlateDrawer — composing an event on the slot', () => {
  afterEach(() => setViewport(false));

  function compose(mocks: MockedResponse[], onCreated = vi.fn()) {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        slot={SLOT}
        sections={[]}
        {...NOOP}
        onCreated={onCreated}
      />,
      { mocks },
    );

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));

    return { onCreated };
  }

  it('opens the event form in the drawer', () => {
    compose([]);

    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('sends the clicked slot as the start, tells the caller to refetch, and closes the form', async () => {
    const inputs: Record<string, unknown>[] = [];
    const { onCreated } = compose([createMock((input) => inputs.push(input))]);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Coffee with Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      title: 'Coffee with Sam',
      startTime: new Date(2026, 7, 6, 16, 15).toISOString(),
      endTime: new Date(2026, 7, 6, 17, 15).toISOString(),
      isAllDay: false,
      durationMinutes: 60,
    });
    // Blank means "no kind", which is what keeps a hand-made event on the
    // Schedule (CalendarEventService.findInRange serves NULL event_type).
    expect(inputs[0].eventType).toBeUndefined();

    // Back to the two ways in, with nothing left in the box.
    await waitFor(() => expect(screen.queryByLabelText('Title')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'New event' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });

  it('never reaches the network with an untitled draft', async () => {
    const sent = vi.fn();
    const { onCreated } = compose([createMock(sent)]);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(/give the event a title/i)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('surfaces a rejected write instead of hanging on "Adding…"', async () => {
    const { onCreated } = compose([
      {
        request: { query: CREATE_EVENT },
        variableMatcher: () => true,
        error: new Error('calendar is read only'),
      } as unknown as MockedResponse,
    ]);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Coffee with Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/read only/i);
    expect(onCreated).not.toHaveBeenCalled();
    // The typing survives, and the form is usable again rather than stuck.
    expect(screen.getByLabelText('Title')).toHaveValue('Coffee with Sam');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  /**
   * ═══ WHAT THIS TEST USED TO CHECK ═══
   * That the alert was gone right after Cancel — which it always was, because
   * the alert only renders inside the composer. `submitError` itself survived,
   * so the very next "New event" re-mounted an empty form under the rejection
   * from an attempt the user had already abandoned. The name said the case was
   * covered; the assertions never reached it.
   */
  it('does not re-raise the abandoned error when the composer is reopened after Cancel', async () => {
    compose([
      {
        request: { query: CREATE_EVENT },
        variableMatcher: () => true,
        error: new Error('calendar is read only'),
      } as unknown as MockedResponse,
    ]);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Coffee with Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));

    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/read only/i)).not.toBeInTheDocument();
  });

  it('does not re-raise an abandoned validation complaint either', () => {
    compose([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/give the event a title/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New event' }));

    expect(screen.queryByText(/give the event a title/i)).not.toBeInTheDocument();
  });
});
