import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';
import { renderWithProviders } from '@/test/renderWithProviders';

import { SchedulePage } from './SchedulePage';

const h = vi.hoisted(() => ({
  schedule: {} as Record<string, unknown>,
  plan: {} as Record<string, unknown>,
  reschedule: vi.fn(),
  hbpeEnabled: true,
}));

vi.mock('@/api/useScheduleService', () => ({
  useScheduleService: () => h.schedule,
}));

// Defaults ON so the existing rhythm-copy tests exercise the resolved-data
// branches; the off-vs-failed distinction below flips this explicitly.
vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: (flag: string) => (flag === 'hbpe' ? h.hbpeEnabled : true) }),
}));

vi.mock('@/pages/PlanPage/usePlanTasks', () => ({
  usePlanTasks: () => h.plan,
}));

vi.mock('@/api/useRescheduleEvent', () => ({
  useRescheduleEvent: () => h.reschedule,
}));

/**
 * Stand-in for the grid.
 *
 * The page's job here is wiring — which footer copy it chooses, and what it
 * does with a rejected drop — and driving those through real HTML5 drag events
 * would test VerticalCalendar instead. The stub exposes the two callbacks as
 * buttons and renders the footer verbatim.
 */
vi.mock('@/components/HorizonGrid', () => ({
  VerticalCalendar: ({
    footer,
    onDropCandidate,
    onMoveEvent,
  }: {
    footer?: string;
    onDropCandidate: (id: string, at: Date) => void;
    onMoveEvent: (id: string, at: Date) => void;
  }) => (
    <div data-testid="vertical-calendar">
      <button type="button" onClick={() => onDropCandidate('c1', new Date())}>
        stub-drop
      </button>
      <button type="button" onClick={() => onMoveEvent('e1', new Date())}>
        stub-move
      </button>
      <p>{footer}</p>
    </div>
  ),
}));

vi.mock('@/components/TaskSlate', () => {
  type SlateProps = {
    sections: { key: string; tasks: { id: string; title: string }[] }[];
    onDismissProposed: (id: string) => void;
    error?: boolean;
  };

  const Slate = ({ sections, onDismissProposed, error }: SlateProps) => (
    <>
      {error && <p>Could not load your plan. Try again shortly.</p>}
      {sections.flatMap((section) =>
        section.tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            aria-label={`Dismiss ${task.title}`}
            onClick={() => onDismissProposed(task.id)}
          />
        )),
      )}
    </>
  );

  return {
    TaskSlate: Slate,
    // The real drawer is a Sheet; what the page owns is whether it is open, so
    // the stub renders nothing until it is.
    TaskSlateDrawer: ({ open, ...rest }: SlateProps & { open: boolean }) =>
      open ? (
        <div data-testid="slate-drawer">
          <Slate {...rest} />
        </div>
      ) : null,
  };
});

const event = (overrides: Partial<ScheduleEvent> = {}): ScheduleEvent => ({
  id: 'e1',
  title: 'Standup',
  description: null,
  startTime: new Date(2026, 7, 3, 9).toISOString(),
  endTime: new Date(2026, 7, 3, 9, 30).toISOString(),
  isAllDay: false,
  status: 'confirmed',
  category: null,
  locationName: null,
  sourceSystem: null,
  externalSyncStatus: null,
  ...overrides,
});

function setSchedule(over: Record<string, unknown> = {}) {
  h.schedule = {
    events: [event()],
    rhythm: [],
    generatedAt: null,
    rhythmCoversWindow: false,
    loading: false,
    fetching: false,
    error: false,
    refetch: vi.fn(),
    ...over,
  };
}

function setPlan(over: Record<string, unknown> = {}) {
  h.plan = {
    backlog: [],
    backlogCount: 0,
    loading: false,
    error: false,
    placeOnDay: vi.fn().mockResolvedValue(undefined),
    dismissProposed: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  setSchedule();
  setPlan();
  h.reschedule = vi.fn().mockResolvedValue(undefined);
  h.hbpeEnabled = true;
});

afterEach(() => vi.clearAllMocks());

describe('SchedulePage — what the footer is allowed to claim', () => {
  it('says the rhythm is live only when it covers the window on screen', () => {
    setSchedule({
      generatedAt: '2026-08-05T03:00:00.000Z',
      rhythm: [{ date: '2026-08-05', dow: 'Wed', clusters: [] }],
      rhythmCoversWindow: true,
    });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Pattern rhythm \(HBPE\) from your history, updated/)).toBeInTheDocument();
  });

  it('does not claim freshness for a week the forecast horizon cannot reach', () => {
    // The regression: the forecast resolved (so `generatedAt` was set) but for
    // the wrong seven days, and the footer went on saying "updated <date>" over
    // an empty lane — which reads as "the model knows nothing about you".
    setSchedule({ generatedAt: '2026-08-05T03:00:00.000Z', rhythm: [], rhythmCoversWindow: false });

    renderWithProviders(<SchedulePage />);

    expect(screen.queryByText(/Pattern rhythm \(HBPE\)/)).not.toBeInTheDocument();
    expect(screen.getByText(/only covers the next seven days/)).toBeInTheDocument();
  });

  it('says the layer is off when the hbpe flag is off', () => {
    h.hbpeEnabled = false;
    setSchedule({ generatedAt: null, rhythm: [], rhythmCoversWindow: false });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/HBPE rhythm forecast is off/)).toBeInTheDocument();
  });

  it('says the call failed — not "off" — when the flag is on but the resolver returned nothing', () => {
    // The regression this guards: before the fix, a null `generatedAt` alone
    // decided the "off" copy, so a live flag with a swallowed HBPE failure
    // (ForecastResolver.ts's try/catch) rendered identically to the flag
    // actually being off.
    h.hbpeEnabled = true;
    setSchedule({ generatedAt: null, rhythm: [], rhythmCoversWindow: false });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Couldn't reach the rhythm forecast/)).toBeInTheDocument();
    expect(screen.queryByText(/HBPE rhythm forecast is off/)).not.toBeInTheDocument();
  });
});

describe('SchedulePage — mutations that the server refuses', () => {
  it('tells the user when a placement is rejected', async () => {
    setPlan({ placeOnDay: vi.fn().mockRejectedValue(new Error('slot taken')) });

    renderWithProviders(<SchedulePage />);
    fireEvent.click(screen.getByText('stub-drop'));

    expect(await screen.findByText(/Could not put that on the calendar/)).toBeInTheDocument();
  });

  it('tells the user when a move is rejected', async () => {
    h.reschedule = vi.fn().mockRejectedValue(new Error('read only calendar'));

    renderWithProviders(<SchedulePage />);
    fireEvent.click(screen.getByText('stub-move'));

    expect(await screen.findByText(/Could not move that/)).toBeInTheDocument();
  });

  it('tells the user when dismissing a proposed task is rejected', async () => {
    setPlan({
      backlog: [{ key: 'proposed', tasks: [{ id: 't1', title: 'Book the dentist' }] }],
      backlogCount: 1,
      dismissProposed: vi.fn().mockRejectedValue(new Error('gone')),
    });

    renderWithProviders(<SchedulePage />);
    fireEvent.click(screen.getByLabelText('Dismiss Book the dentist'));

    expect(await screen.findByText(/Could not dismiss that task/)).toBeInTheDocument();
  });

  it('clears the message when the next attempt succeeds', async () => {
    setPlan({ placeOnDay: vi.fn().mockRejectedValue(new Error('slot taken')) });

    renderWithProviders(<SchedulePage />);
    fireEvent.click(screen.getByText('stub-drop'));
    expect(await screen.findByText(/Could not put that on the calendar/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('stub-move'));

    await waitFor(() =>
      expect(screen.queryByText(/Could not put that on the calendar/)).not.toBeInTheDocument(),
    );
  });
});

describe('SchedulePage — failed queries', () => {
  it('keeps the events that resolved when one field errored', () => {
    setSchedule({ error: true, events: [event({ title: 'Standup' })] });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/what is shown may be incomplete/)).toBeInTheDocument();
    // The grid is still on screen rather than replaced wholesale.
    expect(screen.getByText('stub-drop')).toBeInTheDocument();
  });

  it('falls back to the hard error when nothing resolved', () => {
    setSchedule({ error: true, events: [] });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Could not load the schedule/)).toBeInTheDocument();
    expect(screen.queryByText('stub-drop')).not.toBeInTheDocument();
  });

  it('shows the slate as failed rather than empty when the plan list errors', () => {
    setSchedule({ events: [], rhythm: [] });
    setPlan({ error: true });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Could not load your plan/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in Proposed or Unscheduled/)).not.toBeInTheDocument();
    // Not the "connect a calendar" empty state either — nothing is known to be
    // empty when the request that would have said so failed.
    expect(screen.queryByText(/Connect a calendar/)).not.toBeInTheDocument();
  });

  it('still shows the empty state when everything resolved and there is nothing', () => {
    setSchedule({ events: [], rhythm: [] });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Connect a calendar/)).toBeInTheDocument();
  });

  it('keeps the week visible when the calendar is empty but Plan has backlog', () => {
    setSchedule({ events: [], rhythm: [] });
    setPlan({
      backlog: [{ key: 'unscheduled', tasks: [{ id: 't1', title: 'Call the dentist' }] }],
      backlogCount: 1,
    });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByTestId('vertical-calendar')).toBeInTheDocument();
    expect(screen.queryByText(/Connect a calendar/)).not.toBeInTheDocument();
  });
});

describe('SchedulePage — week paging', () => {
  it('shows the date range between the arrows and updates it when paging', () => {
    setSchedule({ events: [], rhythm: [] });

    renderWithProviders(<SchedulePage />);

    const heading = () => screen.getByRole('heading', { level: 2 });
    const initial = heading().textContent;

    fireEvent.click(screen.getByLabelText('Next week'));
    expect(heading().textContent).not.toBe(initial);
    expect(screen.queryByText('Today')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to today' }));
    expect(heading().textContent).toBe(initial);
  });

  it('keeps the grid visible on a later week even when that week is empty', () => {
    setSchedule({ events: [], rhythm: [] });

    renderWithProviders(<SchedulePage />);
    fireEvent.click(screen.getByLabelText('Next week'));

    expect(screen.getByText('stub-drop')).toBeInTheDocument();
    expect(screen.queryByText(/Connect a calendar/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing on the calendar this week/)).not.toBeInTheDocument();
  });

  it('sits the week chrome above the calendar grid', () => {
    renderWithProviders(<SchedulePage />);

    const heading = screen.getByRole('heading', { level: 2 });
    const grid = screen.getByTestId('vertical-calendar');

    expect(heading.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('phone layout', () => {
    function setViewport(mobile: boolean) {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    }

    afterEach(() => setViewport(false));

    it('offers one day behind day chips, with no Calendar / Horizon pair to choose from', () => {
      setViewport(true);

      renderWithProviders(<SchedulePage />);

      expect(screen.queryByRole('tablist', { name: 'Schedule layout' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Horizon' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show week' })).not.toBeInTheDocument();
      expect(screen.getByTestId('vertical-calendar')).toBeInTheDocument();
      expect(
        screen.getByRole('tablist', { name: 'Days this week' }).querySelectorAll('[role="tab"]'),
      ).toHaveLength(7);
    });

    it('keeps now and next above the day rather than behind a second view', () => {
      setViewport(true);

      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(startOfToday);
      endOfToday.setHours(23, 59, 0, 0);

      setSchedule({
        events: [
          event({
            title: 'Afternoon review',
            isAllDay: true,
            startTime: startOfToday.toISOString(),
            endTime: endOfToday.toISOString(),
          }),
        ],
      });

      renderWithProviders(<SchedulePage />);

      expect(screen.getByText('Afternoon review')).toBeInTheDocument();
      expect(screen.getByText('stub-drop')).toBeInTheDocument();
    });

    /**
     * The regression the walkthrough hit: Possibilities was stacked under the
     * one column the phone came for, advertising a drag onto a day that is
     * never on screen at the same time as the card.
     */
    it('puts Possibilities behind a drawer instead of under the calendar', () => {
      setViewport(true);
      setPlan({
        backlog: [{ key: 'unscheduled', tasks: [{ id: 't1', title: 'Call the dentist' }] }],
        backlogCount: 1,
      });

      renderWithProviders(<SchedulePage />);

      expect(screen.queryByTestId('slate-drawer')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Dismiss Call the dentist')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Possibilities/ }));

      expect(screen.getByTestId('slate-drawer')).toBeInTheDocument();
      expect(screen.getByLabelText('Dismiss Call the dentist')).toBeInTheDocument();
    });

    it('leaves the slate inline on a desktop, where the drag it offers is real', () => {
      setPlan({
        backlog: [{ key: 'unscheduled', tasks: [{ id: 't1', title: 'Call the dentist' }] }],
        backlogCount: 1,
      });

      renderWithProviders(<SchedulePage />);

      expect(screen.queryByRole('button', { name: /Possibilities/ })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Dismiss Call the dentist')).toBeInTheDocument();
    });
  });

  /**
   * Embedded in Today, this page contributes content and no chrome.
   *
   * The positioning assertion is the one that would fail silently in the
   * browser rather than in CI: LoadingPage is `absolute inset-0 z-10`, so an
   * unpositioned wrapper sends it to the host's PageContent, and the schedule's
   * spinner covers the brief stacked below it.
   */
  describe('embedded', () => {
    it('leaves the document title to the host', () => {
      document.title = 'set by the host';

      renderWithProviders(<SchedulePage embedded />);
      expect(document.title).toBe('set by the host');

      cleanup();

      renderWithProviders(<SchedulePage />);
      expect(document.title).toContain('Schedule');
    });

    it('anchors its own overlays instead of the host page', () => {
      setSchedule({ fetching: true, events: [], rhythm: [] });

      const { container } = renderWithProviders(<SchedulePage embedded />);
      const surface = container.querySelector('.min-h-60');

      expect(surface).not.toBeNull();
      expect(surface).toHaveClass('relative');
    });

    it('still renders the week itself', () => {
      renderWithProviders(<SchedulePage embedded />);

      expect(screen.getByText('stub-drop')).toBeInTheDocument();
    });
  });
});

describe('SchedulePage — one schedule, not two views of it', () => {
  it('draws the calendar with no layout to pick', () => {
    renderWithProviders(<SchedulePage />);

    expect(screen.getByTestId('vertical-calendar')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Schedule layout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Horizon' })).not.toBeInTheDocument();
  });
});

/**
 * Activity / Source is two readings of the same marks. With one class and one
 * source on screen both readings are the same picture, so the control and its
 * legend are chrome for a question nothing is asking — which is what an empty
 * week showed a legend for.
 */
describe('SchedulePage — colour mode only once colour means something', () => {
  it('says nothing about colour on an empty week', () => {
    setSchedule({ events: [], rhythm: [] });

    renderWithProviders(<SchedulePage />);

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });

  it('stays quiet when the week holds a single kind of thing', () => {
    setSchedule({ events: [event({ title: 'Standup' })] });

    renderWithProviders(<SchedulePage />);

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('offers the toggle, with a key, once there is more than one', () => {
    setSchedule({ events: [event({ title: 'Standup' }), event({ id: 'e2', title: 'Gym session' })] });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Activity' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(screen.getByText('exercise')).toBeInTheDocument();
  });

  it('counts what the rhythm predicts, not only what is committed', () => {
    setSchedule({
      events: [event({ title: 'Standup' })],
      rhythm: [
        {
          date: '2026-08-05',
          dow: 'Wed',
          clusters: [
            {
              clusterId: 'c1',
              name: 'Morning gym',
              l0Class: 'EXERCISE',
              pOccur: 0.9,
              scheduled: false,
              daypartProbs: [{ label: 'morning', probability: 0.8 }],
            },
          ],
        },
      ],
    });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });
});
