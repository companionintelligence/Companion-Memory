import { setApiBaseUrl } from '@ci/common';
import { usePowerSync } from '@powersync/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerSyncProvider } from './PowerSyncProvider';

const mocks = vi.hoisted(() => ({
  nativeDatabase: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAndClear: vi.fn(),
    close: vi.fn(),
  },
  /** What `isNativePlatform()` answers: a phone, or a browser. */
  native: false,
  purgeLegacyIndexedDbReplica: vi.fn(),
  // One entry per connector the provider builds: the callback it passes for
  // "this server runs no PowerSync service".
  syncOffCallbacks: [] as Array<(origin: string) => void>,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'jwt-abc', authenticated: true }],
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => mocks.native,
}));

vi.mock('./legacyIndexedDb', () => ({
  purgeLegacyIndexedDbReplica: mocks.purgeLegacyIndexedDbReplica,
}));

// The preview store needs a real database (`watch`) and the filesystem; the
// provider only starts and stops it, which is all these tests need to see.
vi.mock('./previews', () => ({
  isPreviewSyncEnabled: () => true,
  startPreviewSync: async () => undefined,
  stopPreviewSync: () => undefined,
  subscribePreviewSync: () => () => undefined,
}));

vi.mock('./nativeDatabase', () => ({
  openNativePowerSyncDatabase: () => mocks.nativeDatabase,
  openReplicaWithRetry: async () => mocks.nativeDatabase,
  NATIVE_DB_ON_DISK_FILENAME: 'ci-powersyncSQLite.db',
}));

// Plain functions, not vi.fn(): the config restores mocks between tests, which
// would leave a vi.fn() returning undefined and the provider's `.then` throwing.
vi.mock('./searchIndex', () => ({
  ensureDocumentsTable: async () => undefined,
  ensureSearchIndex: async () => false,
  countDocuments: async () => 0,
  watchBulkDownloads: () => () => undefined,
}));

vi.mock('./session', () => ({
  bindPowerSyncDatabase: vi.fn(),
  measurePowerSyncSizeBytes: vi.fn().mockResolvedValue(null),
  setReplicaOpenState: vi.fn(),
}));

vi.mock('./connector', () => ({
  GraphQLBackendConnector: vi.fn(function (
    this: unknown,
    _getAuthToken: unknown,
    onSyncUnavailable: (origin: string) => void,
  ) {
    mocks.syncOffCallbacks.push(onSyncUnavailable);
  }),
}));

function latestSyncOffCallback(): (origin: string) => void {
  const callback = mocks.syncOffCallbacks.at(-1);

  if (!callback) {
    throw new Error('the provider has not built a connector yet');
  }

  return callback;
}

/** Renders what the context holds, so a test can see whether any database reached consumers. */
function ContextProbe() {
  const database = usePowerSync();

  return <output data-testid="context">{database ? 'database' : 'none'}</output>;
}

beforeEach(() => {
  setApiBaseUrl('https://memory-a.example');
  mocks.native = false;
  mocks.syncOffCallbacks.length = 0;
  mocks.purgeLegacyIndexedDbReplica.mockReset().mockResolvedValue([]);

  for (const method of Object.values(mocks.nativeDatabase)) {
    method.mockReset().mockResolvedValue(undefined);
  }
});

afterEach(() => {
  setApiBaseUrl('');
});

// The connect logic only ever runs for the encrypted replica, so these run as
// a phone would: the native adapter loads and its database is the one that
// syncs. A browser is covered by the last describe.
describe('PowerSyncProvider', () => {
  beforeEach(() => {
    mocks.native = true;
  });

  it('stops connecting once the server says it runs no PowerSync service', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1));

    act(() => latestSyncOffCallback()('https://memory-a.example'));

    await waitFor(() => expect(mocks.nativeDatabase.disconnect).toHaveBeenCalled());

    // The working-set screens ask for a reconnect after changing the window.
    // That must not start asking the same server again.
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await waitFor(() => expect(mocks.nativeDatabase.disconnect.mock.calls.length).toBeGreaterThan(1));
    expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1);
  });

  it('connects again when the app points at a different server', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1));
    act(() => latestSyncOffCallback()('https://memory-a.example'));
    await waitFor(() => expect(mocks.nativeDatabase.disconnect).toHaveBeenCalled());

    act(() => setApiBaseUrl('https://memory-b.example'));

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(2));
  });

  it('ignores a late answer from the previous server', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1));
    const previousServerCallback = latestSyncOffCallback();

    act(() => setApiBaseUrl('https://memory-b.example'));
    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(2));

    act(() => previousServerCallback('https://memory-a.example'));
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(3));
  });

  it('ignores an answer from another server that reached this connector mid-switch', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1));

    // The app went to memory-b and back while a request was in flight, so this
    // connector's request reached memory-b. That says nothing about memory-a.
    act(() => latestSyncOffCallback()('https://memory-b.example'));
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(2));
    expect(mocks.nativeDatabase.disconnect).not.toHaveBeenCalled();
  });
});

describe('PowerSyncProvider on a phone', () => {
  it('hands consumers nothing until the encrypted SQLite replica is open, then that replica', async () => {
    mocks.native = true;

    render(
      <PowerSyncProvider>
        <ContextProbe />
      </PowerSyncProvider>,
    );

    // Before 2026-10-26 a plaintext IndexedDB placeholder filled this window; a
    // consumer that read from it would have read nothing, or worse, synced into it.
    expect(screen.getByTestId('context')).toHaveTextContent('none');

    await waitFor(() => expect(screen.getByTestId('context')).toHaveTextContent('database'));
    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1));
    expect(mocks.purgeLegacyIndexedDbReplica).toHaveBeenCalledTimes(1);
  });
});

describe('PowerSyncProvider in a desktop browser', () => {
  it('opens no database, connects nothing, and deletes what an earlier build left in IndexedDB', async () => {
    mocks.native = false;
    mocks.purgeLegacyIndexedDbReplica.mockResolvedValue(['ci-powersync.db']);

    render(
      <PowerSyncProvider>
        <ContextProbe />
      </PowerSyncProvider>,
    );

    await waitFor(() => expect(mocks.purgeLegacyIndexedDbReplica).toHaveBeenCalledTimes(1));

    // Nothing asks the server for a sync token from a browser, even after the
    // working-set screens ask for a reconnect.
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('context')).toHaveTextContent('none');
    expect(mocks.nativeDatabase.connect).not.toHaveBeenCalled();
    expect(mocks.syncOffCallbacks).toHaveLength(0);
  });
});
