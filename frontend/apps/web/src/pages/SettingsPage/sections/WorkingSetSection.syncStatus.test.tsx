import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  status: undefined as
    | undefined
    | {
        connected: boolean;
        connecting: boolean;
        lastSyncedAt?: Date;
        dataFlowStatus: { downloading: boolean };
      },
  unavailableFor: null as string | null,
  apiBaseUrl: 'https://memory.example.lan',
  sizeBytes: 0,
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => true,
  getApiBaseUrl: () => h.apiBaseUrl,
  subscribeApiBaseUrl: () => () => undefined,
}));
vi.mock('@powersync/react', () => {
  // A getter, so each test's status is what the section reads on mount; one object, so
  // `usePowerSync` returns a stable identity across renders.
  const database = {
    get currentStatus() {
      return h.status;
    },
    registerListener: () => () => undefined,
  };

  return { usePowerSync: () => database };
});
vi.mock('@/api/powersync/session', () => {
  const open = { phase: 'open' as const };

  return {
    clearPowerSyncWorkingSet: async () => undefined,
    measurePowerSyncSizeBytes: async () => h.sizeBytes,
    getReplicaOpenState: () => open,
    subscribeReplicaOpenState: () => () => undefined,
    getSyncUnavailableFor: () => h.unavailableFor,
    subscribeSyncUnavailableFor: () => () => undefined,
  };
});
vi.mock('@/api/powersync/previews', () => {
  const status = { synced: 0, bytes: 0, pending: 0 };

  return {
    isPreviewSyncEnabled: () => true,
    setPreviewSyncEnabled: () => undefined,
    subscribePreviewSync: () => () => undefined,
    measurePreviews: async () => status,
    deleteAllPreviews: async () => undefined,
  };
});

import { WorkingSetSection } from './WorkingSetSection';

afterEach(() => {
  h.status = undefined;
  h.unavailableFor = null;
  h.sizeBytes = 0;
  vi.useRealTimers();
});

describe('the working set sync status', () => {
  it('says a phone that never synced has nothing stored, rather than showing an empty window', async () => {
    h.status = { connected: false, connecting: false, dataFlowStatus: { downloading: false } };
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('working-set-sync-status')).toHaveTextContent(/Not synced yet/);
    expect(screen.getByRole('switch', { name: /Keep photo previews/ })).toBeInTheDocument();
  });

  it('stays on "Last synced" through the short downloads of live sync', async () => {
    h.status = {
      connected: true,
      connecting: false,
      lastSyncedAt: new Date('2026-10-30T16:00:00Z'),
      dataFlowStatus: { downloading: true },
    };
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('working-set-sync-status')).toHaveTextContent(/^Last synced /);
  });

  it('says a first sync is running', async () => {
    h.status = { connected: true, connecting: false, dataFlowStatus: { downloading: true } };
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('working-set-sync-status')).toHaveTextContent(
      'Syncing for the first time',
    );
  });

  it('says when the copy was last synced', async () => {
    h.status = {
      connected: true,
      connecting: false,
      lastSyncedAt: new Date('2026-10-30T16:00:00Z'),
      dataFlowStatus: { downloading: false },
    };
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('working-set-sync-status')).toHaveTextContent(/^Last synced /);
  });

  it('says the server runs no sync, and offers no previews that could never come', async () => {
    h.unavailableFor = h.apiBaseUrl;
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('working-set-sync-status')).toHaveTextContent(
      /does not run the sync service/,
    );
    expect(screen.queryByText(/rolling window/)).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Keep photo previews/ })).not.toBeInTheDocument();
  });

  it('ignores a no-sync answer from a server the app has since left', async () => {
    h.unavailableFor = 'https://old-server.example';
    h.status = { connected: false, connecting: false, dataFlowStatus: { downloading: false } };
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('working-set-sync-status')).toHaveTextContent(/Not synced yet/);
  });

  it('shows a small copy in MB and keeps measuring while the screen is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByText(/Used: 0 MB/)).toBeInTheDocument();

    // A first sync lands while Settings is open.
    h.sizeBytes = 25_403_392;
    // Not re-read within the retry window once a size is known...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText(/Used: 0 MB/)).toBeInTheDocument();

    // ...but within the minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });

    expect(await screen.findByText(/Used: 24 MB \/ 8\.0 GB/)).toBeInTheDocument();
  });
});
