import type { AbstractPowerSyncDatabase } from '@powersync/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  POWER_SYNC_LOGOUT_TEARDOWN_TIMEOUT_MS,
  bindPowerSyncDatabase,
  disconnectAndClearPowerSyncForLogout,
} from './session';

function fakeDatabase(overrides: Partial<AbstractPowerSyncDatabase>): AbstractPowerSyncDatabase {
  return {
    disconnectAndClear: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AbstractPowerSyncDatabase;
}

describe('disconnectAndClearPowerSyncForLogout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    bindPowerSyncDatabase(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves true once the replica has been dropped', async () => {
    const db = fakeDatabase({});
    bindPowerSyncDatabase(db);

    await expect(disconnectAndClearPowerSyncForLogout()).resolves.toBe(true);
    expect(db.disconnectAndClear).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('resolves true immediately when no database is bound', async () => {
    await expect(disconnectAndClearPowerSyncForLogout()).resolves.toBe(true);
  });

  it('gives up after the deadline when disconnectAndClear never settles', async () => {
    // A worker that never came up: the promise neither resolves nor rejects.
    bindPowerSyncDatabase(fakeDatabase({ disconnectAndClear: vi.fn(() => new Promise<void>(() => {})) }));

    const pending = disconnectAndClearPowerSyncForLogout();

    await vi.advanceTimersByTimeAsync(POWER_SYNC_LOGOUT_TEARDOWN_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('did not finish'));
  });

  it('honours a custom deadline', async () => {
    bindPowerSyncDatabase(fakeDatabase({ disconnectAndClear: vi.fn(() => new Promise<void>(() => {})) }));

    const pending = disconnectAndClearPowerSyncForLogout(50);

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(false);
  });

  it('resolves false when both the clear and the disconnect fallback throw', async () => {
    bindPowerSyncDatabase(
      fakeDatabase({
        disconnectAndClear: vi.fn().mockRejectedValue(new Error('clear failed')),
        disconnect: vi.fn().mockRejectedValue(new Error('disconnect failed')),
      }),
    );

    await expect(disconnectAndClearPowerSyncForLogout()).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.any(Error));
  });

  it('does not leave its timer running once the teardown finishes', async () => {
    bindPowerSyncDatabase(fakeDatabase({}));

    await disconnectAndClearPowerSyncForLogout();

    expect(vi.getTimerCount()).toBe(0);
  });
});
