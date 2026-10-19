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
  // One entry per connector the provider builds: the callback it passes for
  // "this server runs no PowerSync service".
  syncOffCallbacks: [] as Array<(origin: string) => void>,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'jwt-abc', authenticated: true }],
}));

vi.mock('./webDatabase', () => ({
  openWebPowerSyncDatabase: () => mocks.database,
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
  mocks.syncOffCallbacks.length = 0;
  mocks.database.connect.mockReset().mockResolvedValue(undefined);
  mocks.database.disconnect.mockReset().mockResolvedValue(undefined);
  mocks.database.close.mockReset().mockResolvedValue(undefined);
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
