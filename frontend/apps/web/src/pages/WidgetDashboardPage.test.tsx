import { useQuery } from '@apollo/client/react';
import { fetchJson } from '@ci/common';
import { screen, waitFor } from '@testing-library/react';
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

const authState = vi.hoisted(() => ({ authToken: 'test-token' as string | null, authenticated: true }));

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useAuth: () => [authState] };
});

const mockedFetchJson = vi.mocked(fetchJson);

beforeEach(() => {
  vi.mocked(useQuery).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useQuery>);
  mockedFetchJson.mockResolvedValue({
    summary: { pending: 2, active: 1, failed: 1, deadLettered: 1, completed: 44 },
  });
});

afterEach(() => {
  authState.authToken = 'test-token';
  authState.authenticated = true;
  vi.clearAllMocks();
});

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

  it('waits for a session before asking', async () => {
    authState.authToken = null;
    authState.authenticated = false;

    renderWithProviders(<WidgetDashboardPage />);

    await waitFor(() =>
      expect(screen.getByText('Queue health appears after a successful sync.')).toBeInTheDocument(),
    );
    expect(mockedFetchJson).not.toHaveBeenCalled();
  });
});
