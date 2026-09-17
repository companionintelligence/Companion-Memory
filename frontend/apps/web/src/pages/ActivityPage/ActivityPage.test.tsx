import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ActivityPage } from './ActivityPage';
import type { ActivityFilters, ActivityRow } from './useActivity';

const loadMore = vi.fn();
const state: {
  rows: ActivityRow[] | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
} = { rows: [], loading: false, loadingMore: false, error: null, hasMore: false };

/** Captured so a tab click can be asserted to change the QUESTION, not just the styling. */
let lastFilters: ActivityFilters | undefined;

vi.mock('./useActivity', () => ({
  useActivity: (filters: ActivityFilters) => {
    lastFilters = filters;

    return { ...state, loadMore, refresh: vi.fn() };
  },
}));

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 'ti-1',
  occurredAt: '2026-09-10T08:00:00.000Z',
  intent: 'memory.recall',
  tool: 'memory_recall',
  domain: 'memory',
  source: 'native',
  outcome: 'success',
  capability: 'write',
  principal: 'owner',
  principalName: null,
  tier: null,
  access: 'read',
  external: false,
  destructive: false,
  errorCode: null,
  error: null,
  durationMs: 120,
  correlationId: null,
  ...over,
});

describe('ActivityPage', () => {
  beforeEach(() => {
    loadMore.mockReset();
    state.rows = [];
    state.loading = false;
    state.loadingMore = false;
    state.error = null;
    state.hasMore = false;
    lastFilters = undefined;
  });

  it('names the app that called, not just the authority it held', () => {
    state.rows = [
      row({
        principal: 'managed-app',
        principalName: 'app:ci-openclaw:ci-marketplace',
        capability: 'full',
      }),
    ];
    renderWithProviders(<ActivityPage />);

    expect(screen.getByText('OpenClaw')).toBeInTheDocument();
    // "full" alone was the old answer to "who", and it cannot tell the owner's
    // own key from an installed harness's.
    expect(screen.queryByText('full')).not.toBeInTheDocument();
  });

  it('falls back to the slug for an app it has no label for', () => {
    state.rows = [row({ principal: 'managed-app', principalName: 'app:ci-newthing:ci-marketplace' })];
    renderWithProviders(<ActivityPage />);

    expect(screen.getByText('ci-newthing')).toBeInTheDocument();
  });

  it('says "You" when the owner called, rather than attributing it to an app', () => {
    state.rows = [row({ principal: 'owner', principalName: null })];
    renderWithProviders(<ActivityPage />);

    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('shows a refusal AND its reason — a row that only says "did not happen" is unreadable', () => {
    state.rows = [
      row({
        intent: 'messaging.send',
        outcome: 'refused',
        errorCode: 'TOOL_FORBIDDEN',
        error: 'Tool "messaging_send" requires "full" access, but this API key is "write"',
      }),
    ];
    renderWithProviders(<ActivityPage />);

    expect(screen.getByText('refused')).toBeInTheDocument();
    expect(screen.getByText('TOOL_FORBIDDEN')).toBeInTheDocument();
    expect(screen.getByText(/requires "full" access/)).toBeInTheDocument();
  });

  it('flags irreversible and appliance-leaving calls, and stays quiet when they are neither', () => {
    state.rows = [row({ destructive: true, external: true })];
    const { unmount } = renderWithProviders(<ActivityPage />);

    expect(screen.getByText('irreversible')).toBeInTheDocument();
    expect(screen.getByText('leaves appliance')).toBeInTheDocument();
    unmount();

    // Shown only when true: a line of mostly-"no" badges trains the eye to skip
    // the row where one of them says yes.
    state.rows = [row()];
    renderWithProviders(<ActivityPage />);

    expect(screen.queryByText('irreversible')).not.toBeInTheDocument();
    expect(screen.queryByText('leaves appliance')).not.toBeInTheDocument();
  });

  it('marks an on-device call but not an appliance one, because NULL tier means appliance', () => {
    state.rows = [row({ tier: 'local' })];
    const { unmount } = renderWithProviders(<ActivityPage />);

    expect(screen.getByText('on-device')).toBeInTheDocument();
    unmount();

    state.rows = [row({ tier: null })];
    renderWithProviders(<ActivityPage />);

    expect(screen.queryByText('on-device')).not.toBeInTheDocument();
  });

  it('asks the server a different question per tab, rather than filtering what it already has', () => {
    // Client-side filtering would silently lie once the ledger is longer than a
    // page: "Refused" would show the refusals in the newest 50 rows, not the
    // refusals.
    renderWithProviders(<ActivityPage />);
    expect(lastFilters).toStrictEqual({});

    fireEvent.click(screen.getByRole('tab', { name: 'Refused' }));
    expect(lastFilters).toStrictEqual({ outcome: 'refused' });

    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(lastFilters).toStrictEqual({ principal: 'managed-app' });
  });

  it('reads an empty Refused tab as good news, and an empty Apps tab as something else', () => {
    state.rows = [];
    renderWithProviders(<ActivityPage />);
    expect(screen.getByText(/No tool calls recorded yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Refused' }));
    expect(screen.getByText(/has not had to stop anything/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(screen.getByText(/No installed app has run a tool yet/)).toBeInTheDocument();
  });

  it('offers Older only when the server said there is more', () => {
    state.rows = [row()];
    state.hasMore = false;
    const { unmount } = renderWithProviders(<ActivityPage />);

    expect(screen.queryByRole('button', { name: 'Older' })).not.toBeInTheDocument();
    unmount();

    state.hasMore = true;
    renderWithProviders(<ActivityPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(loadMore).toHaveBeenCalled();
  });

  it('surfaces a load error instead of showing an empty ledger as if nothing had happened', () => {
    state.rows = null;
    state.error = 'boom';
    renderWithProviders(<ActivityPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/boom/);
  });
});
