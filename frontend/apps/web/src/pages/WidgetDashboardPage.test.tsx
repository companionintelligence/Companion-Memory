import { useQuery } from '@apollo/client/react';
import { fetchJson } from '@ci/common';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import WidgetDashboardPage from './WidgetDashboardPage';

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
