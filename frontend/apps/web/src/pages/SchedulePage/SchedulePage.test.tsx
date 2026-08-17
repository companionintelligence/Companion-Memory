import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';
import { renderWithProviders } from '@/test/renderWithProviders';

import { SchedulePage } from './SchedulePage';

const h = vi.hoisted(() => ({
  schedule: {} as Record<string, unknown>,
  candidates: {} as Record<string, unknown>,
  reschedule: vi.fn(),
}));

vi.mock('@/api/useScheduleService', () => ({
  useScheduleService: () => h.schedule,
}));

vi.mock('@/api/useScheduleCandidates', () => ({
  useScheduleCandidates: () => h.candidates,
}));

vi.mock('@/api/useRescheduleEvent', () => ({
  useRescheduleEvent: () => h.reschedule,
}));

/**
 * Stand-in for the grid.
 *
 * The page's job here is wiring — which footer copy it chooses, and what it
 * does with a rejected drop — and driving those through real HTML5 drag events
 * would test HorizonGrid instead. The stub exposes the two callbacks as
 * buttons and renders the footer verbatim.
 */
vi.mock('@/components/HorizonGrid', () => ({
  HorizonGrid: ({
    footer,
    onDropCandidate,
    onMoveEvent,
  }: {
    footer?: string;
    onDropCandidate: (id: string, at: Date) => void;
    onMoveEvent: (id: string, at: Date) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onDropCandidate('c1', new Date())}>
        stub-drop
      </button>
      <button type="button" onClick={() => onMoveEvent('e1', new Date())}>
        stub-move
      </button>
      <p>{footer}</p>
    </div>
  ),
  // SchedulePage mounts this above the week; keep it inert.
  TodayStoryTimeline: () => null,
}));

vi.mock('@/components/TaskSlate', () => ({
  TaskSlate: ({
    candidates,
    onDecline,
    error,
  }: {
    candidates: { id: string; title: string }[];
    onDecline: (id: string, reason: string) => void;
    error?: boolean;
  }) => (
    <>
      {error && <p>Could not load your suggestions. Try again shortly.</p>}
      {candidates.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          aria-label={`Dismiss ${candidate.title}`}
          onClick={() => onDecline(candidate.id, 'not_now')}
        />
      ))}
    </>
  ),
}));

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

function setCandidates(over: Record<string, unknown> = {}) {
  h.candidates = {
    candidates: [],
    loading: false,
    error: false,
    accept: vi.fn().mockResolvedValue(undefined),
    decline: vi.fn().mockResolvedValue(undefined),
    snooze: vi.fn().mockResolvedValue(undefined),
    breakDown: vi.fn().mockResolvedValue(0),
    returnEvent: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  setSchedule();
  setCandidates();
  h.reschedule = vi.fn().mockResolvedValue(undefined);
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

  it('says the layer is unavailable when the forecast resolver returned nothing', () => {
    setSchedule({ generatedAt: null, rhythm: [], rhythmCoversWindow: false });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/HBPE rhythm forecast is off/)).toBeInTheDocument();
  });
});

describe('SchedulePage — mutations that the server refuses', () => {
  it('tells the user when a placement is rejected', async () => {
    // Previously `void accept(...)` with no catch: an unhandled rejection, and
    // on screen nothing at all — the card just stayed on the rail.
    setCandidates({ accept: vi.fn().mockRejectedValue(new Error('slot taken')) });

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

  it('tells the user when dismissing a suggestion is rejected', async () => {
    const candidate = {
      id: 'c1',
      title: 'Book the dentist',
      description: null,
      rationale: 'You wrote this down.',
      rationaleSources: [],
      windowStart: new Date(2026, 7, 3).toISOString(),
      windowEnd: new Date(2026, 7, 10).toISOString(),
      timeFlex: 'week',
      durationMinutes: null,
      l0Class: null,
      fitScore: null,
      status: 'open',
      generator: null,
      confidence: null,
    };

    setCandidates({
      candidates: [candidate],
      decline: vi.fn().mockRejectedValue(new Error('gone')),
    });

    renderWithProviders(<SchedulePage />);
    fireEvent.click(screen.getByLabelText('Dismiss Book the dentist'));

    expect(await screen.findByText(/Could not dismiss that suggestion/)).toBeInTheDocument();
  });

  it('clears the message when the next attempt succeeds', async () => {
    setCandidates({ accept: vi.fn().mockRejectedValue(new Error('slot taken')) });

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

  it('shows the slate as failed rather than empty when candidates error', () => {
    setSchedule({ events: [], rhythm: [] });
    setCandidates({ error: true });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Could not load your suggestions/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing waiting yet/)).not.toBeInTheDocument();
    // Not the "connect a calendar" empty state either — nothing is known to be
    // empty when the request that would have said so failed.
    expect(screen.queryByText(/Connect a calendar/)).not.toBeInTheDocument();
  });

  it('still shows the empty state when everything resolved and there is nothing', () => {
    setSchedule({ events: [], rhythm: [] });

    renderWithProviders(<SchedulePage />);

    expect(screen.getByText(/Connect a calendar/)).toBeInTheDocument();
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
    expect(screen.getByText(/Nothing on the calendar this week/)).toBeInTheDocument();
  });
});
