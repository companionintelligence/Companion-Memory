import { useQuery } from '@apollo/client/react';
import { buildWidgetSnapshot, fetchJson } from '@ci/common';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classTitle } from '@/lib/activityPalette';
import { renderWithProviders } from '@/test/renderWithProviders';

import WidgetDashboardPage, { WidgetDashboardView } from './WidgetDashboardPage';

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, fetchJson: vi.fn(), usePageTitle: () => {} };
});

// The three other cards go through Apollo, which carries the token itself; only
// the Jobs card's REST request is under test here.
vi.mock('@apollo/client/react', async (orig) => ({
  ...(await orig<typeof import('@apollo/client/react')>()),
  useQuery: vi.fn(),
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => true }),
}));

// The real `useSessionAuth` runs on top of this, so a web JWT session and the
// native shell (an API key, no JWT) both go through the code the page uses.
const authState = vi.hoisted(() => ({
  authToken: 'test-token' as string | null,
  authenticated: true,
  expired: false,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [authState, {}] }));

const mockedFetchJson = vi.mocked(fetchJson);

// One object for every render: a fresh `data` each time would re-stamp the
// Plan card's time on every render and hide what the last test checks.
const TASKS = { data: { tasks: { edges: [] } } };
const NO_DATA = { data: undefined };

beforeEach(() => {
  vi.mocked(useQuery).mockImplementation(((query: { definitions: Array<{ name?: { value: string } }> }) =>
    query.definitions[0]?.name?.value === 'WidgetBoardTasks'
      ? TASKS
      : NO_DATA) as unknown as typeof useQuery);
  mockedFetchJson.mockResolvedValue({
    summary: { pending: 2, active: 1, failed: 1, deadLettered: 1, completed: 44 },
  });
});

afterEach(() => {
  authState.authToken = 'test-token';
  authState.authenticated = true;
  vi.useRealTimers();
});

function clockLabel(at: Date): string {
  return `Updated ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

describe('WidgetDashboardPage Jobs card', () => {
  it("asks for the queue with the session's token and shows it", async () => {
    renderWithProviders(<WidgetDashboardPage />);

    expect(await screen.findByText('44')).toBeInTheDocument();
    expect(screen.getByText('needs attention')).toBeInTheDocument();
    expect(screen.queryByText('Queue health appears after a successful sync.')).not.toBeInTheDocument();
    expect(mockedFetchJson).toHaveBeenCalledWith('/api/jobs/dashboard', {
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('asks without a bearer on native, where fetchJson adds the API key', async () => {
    authState.authToken = null;

    renderWithProviders(<WidgetDashboardPage />);

    expect(await screen.findByText('44')).toBeInTheDocument();
    expect(mockedFetchJson).toHaveBeenCalledWith('/api/jobs/dashboard', { headers: {} });
  });

  it('waits for a session before asking, then asks once there is one', async () => {
    authState.authToken = null;
    authState.authenticated = false;

    const { rerender } = renderWithProviders(<WidgetDashboardPage />);

    expect(screen.getByText('Queue health appears after a successful sync.')).toBeInTheDocument();
    expect(mockedFetchJson).not.toHaveBeenCalled();

    authState.authToken = 'test-token';
    authState.authenticated = true;
    rerender(<WidgetDashboardPage />);

    expect(await screen.findByText('44')).toBeInTheDocument();
    expect(mockedFetchJson).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when the session token is rotated', async () => {
    const { rerender } = renderWithProviders(<WidgetDashboardPage />);

    expect(await screen.findByText('44')).toBeInTheDocument();

    authState.authToken = 'rotated-token';
    rerender(<WidgetDashboardPage />);

    // The effect would have run inside `rerender`'s act, so the count is final here.
    expect(mockedFetchJson).toHaveBeenCalledTimes(1);
  });

  it("leaves the Plan card's time alone when the Jobs card updates", async () => {
    const loadedAt = new Date(2026, 10, 13, 9, 0);
    const jobsAt = new Date(2026, 10, 13, 9, 7);
    let answer: (value: unknown) => void = () => {};

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(loadedAt);
    mockedFetchJson.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    renderWithProviders(<WidgetDashboardPage />);

    vi.setSystemTime(jobsAt);
    answer({ summary: { pending: 0, active: 0, failed: 0, deadLettered: 0, completed: 44 } });

    expect(await screen.findByText('44')).toBeInTheDocument();
    // Plan was loaded at 9:00 and Jobs at 9:07; Stats has no data in this test.
    expect(screen.getAllByText(clockLabel(loadedAt))).toHaveLength(1);
    expect(screen.getByText(clockLabel(jobsAt))).toBeInTheDocument();
  });
});

const NOW = new Date('2026-11-12T12:00:00.000Z');
const PATHS = { plan: '/plan/tasks', chat: '/chat', forecast: '/forecast', jobs: '/jobs' };

function renderPrediction(systemStatus: string, predictedL0: string, probability: number) {
  const snapshot = buildWidgetSnapshot({
    now: NOW,
    forecast: {
      generatedAt: '2026-11-12T11:00:00.000Z',
      systemStatus,
      stillLearning: false,
      buckets: [
        {
          startTime: '2026-11-12T12:15:00.000Z',
          predictedL0,
          l0Probs: [{ label: predictedL0, probability }],
        },
      ],
    },
    // As WidgetDashboardPage and WidgetSnapshotSync build it.
    predictionLabel: classTitle,
  });

  renderWithProviders(<WidgetDashboardView snapshot={snapshot} prompts={[]} paths={PATHS} />);
}

/**
 * The Prediction card printed what HBPE returns as it is: the class label as
 * its headline ("WORK", "UNKNOWN") and "Forecast status: NIGHTLY:label" while
 * the nightly run was going.
 */
describe('WidgetDashboardView: the Prediction card', () => {
  it('names the predicted activity in the calendar legend words', () => {
    renderPrediction('READY', 'WORK', 0.62);

    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('62% likely')).toBeInTheDocument();
    expect(screen.queryByText('WORK')).not.toBeInTheDocument();
    // READY is the normal state; the card's own "Updated" time already says so.
    expect(screen.queryByText(/Forecast status|READY/)).not.toBeInTheDocument();
  });

  it('uses the legend word, not just a capitalised label', () => {
    renderPrediction('READY', 'ERRAND', 0.7);

    expect(screen.getByText('Errands')).toBeInTheDocument();
    expect(screen.getByText('70% likely')).toBeInTheDocument();
  });

  it('calls an unclassified prediction unsorted, as the calendar does', () => {
    renderPrediction('READY', 'UNKNOWN', 0.97);

    expect(screen.getByText('Unsorted')).toBeInTheDocument();
    expect(screen.queryByText('UNKNOWN')).not.toBeInTheDocument();
  });

  it('says what a running pipeline step is doing instead of printing the step', () => {
    renderPrediction('NIGHTLY:label', 'WORK', 0.5);

    expect(screen.getByText('Labeling new events...')).toBeInTheDocument();
    expect(screen.queryByText(/NIGHTLY/)).not.toBeInTheDocument();
  });

  it('says a new account is waiting for its first model, not COLD_START', () => {
    renderPrediction('COLD_START', 'UNKNOWN', 0.5);

    expect(screen.getByText('Waiting to initialize...')).toBeInTheDocument();
    expect(screen.queryByText(/COLD_START/)).not.toBeInTheDocument();
  });
});
