import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isGettingStartedActive, markGettingStartedActive } from '@/lib/gettingStarted';

import { GettingStartedBanner } from './GettingStartedBanner';
import type { MemoryTotals } from './firstSync';

const EMPTY: MemoryTotals = {
  communications: 0,
  events: 0,
  content: 0,
  objects: 0,
  browser_activity: 0,
  position: 0,
};

const h = vi.hoisted(() => ({
  user: { id: 'u1', onboarded: true } as { id: string; onboarded: boolean } | null,
  isMobile: false as boolean | undefined,
  models: [{ model: 'llama3' }] as Array<{ model: string }>,
  modelsLoading: false,
  connections: 0,
  importsFlag: true,
  snapshot: null as null | { batch: { running: number; queued: number; records: number } },
  status: {
    totals: null as MemoryTotals | null,
    indexingItems: null as number | null,
    unpushedRuns: null as number | null,
    refresh: vi.fn(),
  },
  startPush: vi.fn(),
  refreshImports: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@apollo/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apollo/client')>()),
  useQuery: () => ({ data: { connections: { totalCount: h.connections } } }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  useDeviceLayout: () => ({ isMobile: h.isMobile }),
}));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast: h.toast }),
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: (flag: string) => (flag === 'import.page' ? h.importsFlag : false) }),
}));

vi.mock('@/hooks', () => ({
  useCurrentUser: () => ({ user: h.user }),
  useModel: () => [{ activeModels: h.models, loading: h.modelsLoading }, {}],
}));

vi.mock('@/components/connect/ConnectedAccountsSection', () => ({ GET_CONNECTIONS: {} }));

vi.mock('@/pages/ImportPage/useImportApi', () => ({
  useActiveImports: () => ({ snapshot: h.snapshot, error: null, refresh: h.refreshImports }),
  useImportApi: () => ({ startPush: h.startPush }),
}));

vi.mock('./useFirstSyncStatus', () => ({ useFirstSyncStatus: () => h.status }));

function renderBanner() {
  return render(
    <MemoryRouter>
      <GettingStartedBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  h.user = { id: 'u1', onboarded: true };
  h.isMobile = false;
  h.models = [{ model: 'llama3' }];
  h.modelsLoading = false;
  h.connections = 0;
  h.importsFlag = true;
  h.snapshot = null;
  h.status = { totals: EMPTY, indexingItems: 0, unpushedRuns: 0, refresh: vi.fn() };
  h.startPush.mockReset();
  h.refreshImports.mockReset();
  h.toast.success.mockReset();
  h.toast.error.mockReset();
});

describe('GettingStartedBanner', () => {
  it('is absent for a user onboarding never marked — everyone who onboarded before it existed', () => {
    renderBanner();

    expect(screen.queryByTestId('getting-started')).toBeNull();
  });

  it('is absent while there is no user yet', () => {
    markGettingStartedActive('u1');
    h.user = null;
    renderBanner();

    expect(screen.queryByTestId('getting-started')).toBeNull();
  });

  it('shows live counts of what has reached memory', () => {
    markGettingStartedActive('u1');
    h.connections = 1;
    h.status.totals = { ...EMPTY, communications: 12_400, events: 88 };
    h.status.indexingItems = 0;
    renderBanner();

    expect(screen.getByText('You’re all set')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('In your memory now: 12,400 messages · 88 events');
  });

  it('lists the checklist open on desktop, with the two things only the user can do', () => {
    markGettingStartedActive('u1');
    h.models = [];
    renderBanner();

    expect(screen.getByText('Getting started · 0 of 3')).toBeInTheDocument();
    expect(screen.getByText('Choose a chat model')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up a model' }).getAttribute('href')).toMatch(
      /\/settings\/model$/,
    );
    expect(screen.getByRole('link', { name: 'Connect a source' })).toHaveAttribute('href', '/sources/connect');
    expect(screen.getByRole('link', { name: 'Import data' })).toHaveAttribute('href', '/sources/import');
  });

  it('leaves out Import data when importing is switched off', () => {
    markGettingStartedActive('u1');
    h.importsFlag = false;
    renderBanner();

    expect(screen.queryByRole('link', { name: 'Import data' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Connect a source' })).toBeInTheDocument();
  });

  it('folds to one line on a phone until Details is pressed', () => {
    markGettingStartedActive('u1');
    h.isMobile = true;
    h.models = [];
    renderBanner();

    expect(screen.queryByText('Choose a chat model', { selector: 'li p' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('Choose a chat model', { selector: 'li p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers to save an import that parsed but was never pushed, and does it', async () => {
    markGettingStartedActive('u1');
    h.status.unpushedRuns = 2;
    h.startPush.mockResolvedValue({ runs: [{}, {}] });
    renderBanner();

    expect(screen.getByText('2 imports are read but not saved yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }));

    await waitFor(() => expect(h.startPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Saving 2 imports to your memory.'));
    expect(h.status.refresh).toHaveBeenCalled();
    expect(h.refreshImports).toHaveBeenCalled();
  });

  it('says so when the save cannot start', async () => {
    markGettingStartedActive('u1');
    h.status.unpushedRuns = 1;
    h.startPush.mockRejectedValue(new Error('No runs to push'));
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('No runs to push'));
  });

  it('shows a running import with its record count', () => {
    markGettingStartedActive('u1');
    h.snapshot = { batch: { running: 1, queued: 0, records: 5_000 } };
    renderBanner();

    expect(screen.getByText('1 import running')).toBeInTheDocument();
    expect(screen.getByText(/5,000 records read so far/)).toBeInTheDocument();
  });

  it('goes away when dismissed, and stays away', () => {
    markGettingStartedActive('u1');
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));

    expect(screen.queryByTestId('getting-started')).toBeNull();
    expect(isGettingStartedActive('u1')).toBe(false);
  });
});
