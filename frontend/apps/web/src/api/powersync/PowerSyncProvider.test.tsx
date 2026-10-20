import { setApiBaseUrl } from '@ci/common';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerSyncProvider } from './PowerSyncProvider';

const mocks = vi.hoisted(() => ({
  database: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
  },
  nativeDatabase: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
  },
  /** What `isNativePlatform()` answers: a phone, or a browser. */
  native: false,
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

vi.mock('./webDatabase', () => ({
  openWebPowerSyncDatabase: () => mocks.database,
}));

vi.mock('./nativeDatabase', () => ({
  openNativePowerSyncDatabase: () => mocks.nativeDatabase,
}));

// Plain functions, not vi.fn(): the config restores mocks between tests, which
// would leave a vi.fn() returning undefined and the provider's `.then` throwing.
vi.mock('./searchIndex', () => ({
  ensureSearchIndex: async () => false,
  countDocuments: async () => 0,
}));

vi.mock('./session', () => ({
  bindPowerSyncDatabase: vi.fn(),
  measurePowerSyncSizeBytes: vi.fn().mockResolvedValue(null),
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

beforeEach(() => {
  setApiBaseUrl('https://memory-a.example');
  mocks.native = false;
  mocks.syncOffCallbacks.length = 0;

  for (const database of [mocks.database, mocks.nativeDatabase]) {
    database.connect.mockReset().mockResolvedValue(undefined);
    database.disconnect.mockReset().mockResolvedValue(undefined);
    database.close.mockReset().mockResolvedValue(undefined);
  }
});

afterEach(() => {
  setApiBaseUrl('');
});

describe('PowerSyncProvider', () => {
  it('stops connecting once the server says it runs no PowerSync service', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(1));

    act(() => latestSyncOffCallback()('https://memory-a.example'));

    await waitFor(() => expect(mocks.database.disconnect).toHaveBeenCalled());

    // The working-set screens ask for a reconnect after changing the window.
    // That must not start asking the same server again.
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await waitFor(() => expect(mocks.database.disconnect.mock.calls.length).toBeGreaterThan(1));
    expect(mocks.database.connect).toHaveBeenCalledTimes(1);
  });

  it('connects again when the app points at a different server', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(1));
    act(() => latestSyncOffCallback()('https://memory-a.example'));
    await waitFor(() => expect(mocks.database.disconnect).toHaveBeenCalled());

    act(() => setApiBaseUrl('https://memory-b.example'));

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(2));
  });

  it('ignores a late answer from the previous server', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(1));
    const previousServerCallback = latestSyncOffCallback();

    act(() => setApiBaseUrl('https://memory-b.example'));
    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(2));

    act(() => previousServerCallback('https://memory-a.example'));
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(3));
  });

  it('ignores an answer from another server that reached this connector mid-switch', async () => {
    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(1));

    // The app went to memory-b and back while a request was in flight, so this
    // connector's request reached memory-b. That says nothing about memory-a.
    act(() => latestSyncOffCallback()('https://memory-b.example'));
    act(() => {
      window.dispatchEvent(new Event('ci-powersync-reconnect'));
    });

    await waitFor(() => expect(mocks.database.connect).toHaveBeenCalledTimes(2));
    expect(mocks.database.disconnect).not.toHaveBeenCalled();
  });
});

describe('PowerSyncProvider on a phone', () => {
  it('never connects the IndexedDB placeholder; the encrypted SQLite replica is the one that syncs', async () => {
    mocks.native = true;

    render(<PowerSyncProvider>child</PowerSyncProvider>);

    await waitFor(() => expect(mocks.nativeDatabase.connect).toHaveBeenCalledTimes(1));

    // Before the SQLite adapter resolved, the web database was the context's
    // value and the session was authenticated — the old code connected it
    // then, leaving a plaintext IndexedDB copy of whatever synced in that window.
    expect(mocks.database.connect).not.toHaveBeenCalled();
    expect(mocks.database.close).toHaveBeenCalled();
  });
});
