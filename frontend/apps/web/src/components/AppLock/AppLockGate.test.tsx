import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppLockStoreForTests } from '@/hooks/useAppLock';

import { AppLockGate } from './AppLockGate';

const mocks = vi.hoisted(() => ({
  native: true,
  pending: 0,
  pendingByKind: {} as Record<string, number>,
  uploads: {} as Record<string, number>,
  plugin: {
    getStatus: vi.fn(),
    configure: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
    setLockScreenNote: vi.fn(),
    addListener: vi.fn(),
  },
  /** The listener the gate registered for `lockStateChange`, once it has. */
  lockListener: null as null | ((event: { locked: boolean }) => void),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => mocks.native,
  appLockPlugin: () => (mocks.native ? mocks.plugin : undefined),
  useOutboxQueue: () => ({
    available: true,
    pending: mocks.pending,
    pendingByKind: mocks.pendingByKind,
    needsAttention: 0,
    total: 0,
    capacity: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/api/powersync/pendingUploads', () => ({
  usePendingUploadsByTable: () => mocks.uploads,
}));

const status = (locked: boolean) => ({
  enabled: true,
  grace: '30s' as const,
  secureScreen: true,
  locked,
  available: true,
  biometry: 'strong' as const,
});

beforeEach(() => {
  resetAppLockStoreForTests();
  mocks.native = true;
  mocks.pending = 0;
  mocks.pendingByKind = {};
  mocks.uploads = {};
  mocks.lockListener = null;
  mocks.plugin.getStatus.mockReset().mockResolvedValue(status(true));
  mocks.plugin.unlock.mockReset().mockResolvedValue(status(false));
  mocks.plugin.setLockScreenNote.mockReset().mockResolvedValue(undefined);
  // Like Capacitor's bridge: a thenable with `then` and `remove` and NO `catch`. The
  // first build called `.catch` on it and blanked the app on every phone launch.
  mocks.plugin.addListener
    .mockReset()
    .mockImplementation((_event: string, listener: (e: { locked: boolean }) => void) => {
      mocks.lockListener = listener;
      const handle = { remove: vi.fn() };

      // oxlint-disable-next-line unicorn/no-thenable -- deliberately a then-only thenable: that is the bridge's shape
      return { then: (resolve: (h: typeof handle) => void) => resolve(handle), remove: handle.remove };
    });
});

afterEach(() => resetAppLockStoreForTests());

describe('AppLockGate', () => {
  it('shows the lock screen instead of the page while the native lock is engaged, and the page after the prompt passes', async () => {
    render(
      <AppLockGate>
        <div>the memory</div>
      </AppLockGate>,
    );

    // Before the status arrives nothing is hidden — the native overlay covers that window.
    expect(screen.getByText('the memory')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument());
    expect(screen.queryByText('the memory')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(mocks.plugin.unlock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('the memory')).toBeInTheDocument());
  });

  it('follows a lock the native side decides on its own', async () => {
    mocks.plugin.getStatus.mockResolvedValue(status(false));

    render(
      <AppLockGate>
        <div>the memory</div>
      </AppLockGate>,
    );

    await waitFor(() => expect(mocks.lockListener).not.toBeNull());
    expect(screen.getByText('the memory')).toBeInTheDocument();

    act(() => mocks.lockListener?.({ locked: true }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument());
  });

  it('tells the native lock screen what is waiting to sync, by kind, and nothing else', async () => {
    mocks.pending = 3;
    mocks.pendingByKind = { positions: 3 };
    mocks.plugin.getStatus.mockResolvedValue(status(false));

    render(
      <AppLockGate>
        <div>the memory</div>
      </AppLockGate>,
    );

    await waitFor(() =>
      expect(mocks.plugin.setLockScreenNote).toHaveBeenCalledWith({ text: '3 locations waiting to sync' }),
    );
  });

  it("counts PowerSync's own upload queue -- offline notes and saved searches -- beside the outbox", async () => {
    mocks.pending = 18;
    // 17 fixes plus one note the outbox holds; an outbox row under a kind the note does
    // not name is still reported, as a capture.
    mocks.pendingByKind = { positions: 16, note: 1, 'voice-memo': 1 };
    mocks.uploads = { notes: 1, saved_searches: 2 };
    mocks.plugin.getStatus.mockResolvedValue(status(false));

    render(
      <AppLockGate>
        <div>the memory</div>
      </AppLockGate>,
    );

    await waitFor(() =>
      expect(mocks.plugin.setLockScreenNote).toHaveBeenCalledWith({
        text: '16 locations, 2 notes, 2 saved searches and 1 capture waiting to sync',
      }),
    );
  });

  it('a fault in the mirror shows the page rather than a blank app', async () => {
    mocks.plugin.getStatus.mockImplementation(() => {
      throw new TypeError('bridge exploded');
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppLockGate>
        <div>the memory</div>
      </AppLockGate>,
    );

    await waitFor(() => expect(screen.getByText('the memory')).toBeInTheDocument());
    quiet.mockRestore();
  });

  it('is transparent off native', async () => {
    mocks.native = false;

    render(
      <AppLockGate>
        <div>the memory</div>
      </AppLockGate>,
    );

    expect(screen.getByText('the memory')).toBeInTheDocument();
    await Promise.resolve();
    expect(mocks.plugin.getStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
