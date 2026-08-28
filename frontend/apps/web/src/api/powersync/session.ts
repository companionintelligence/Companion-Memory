import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { POWER_SYNC_DEFAULT_LOOKBACK_DAYS, setLookbackDays } from './workingSet';

let database: AbstractPowerSyncDatabase | null = null;

export function bindPowerSyncDatabase(db: AbstractPowerSyncDatabase | null): void {
  database = db;
}

export function getBoundPowerSyncDatabase(): AbstractPowerSyncDatabase | null {
  return database;
}

export function requestPowerSyncReconnect(): void {
  window.dispatchEvent(new Event('ci-powersync-reconnect'));
}

/**
 * Drop the local replica. Call on logout (S3). Does not reconnect; the provider
 * reconnects only while a session exists.
 */
export async function disconnectAndClearPowerSync(): Promise<void> {
  if (!database) {
    return;
  }

  try {
    await database.disconnectAndClear();
  } catch {
    await database.disconnect();
  }
}

/** How long logout waits for the local replica to be dropped before moving on. */
export const POWER_SYNC_LOGOUT_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * `disconnectAndClearPowerSync` with a deadline, for logout.
 *
 * `disconnectAndClear()` first awaits the SQLite worker's readiness handshake.
 * If that worker never came up (e.g. the dev server 404'd its script), the
 * promise never settles — it neither resolves nor rejects — and everything
 * sequenced behind it silently never runs. Sign-out must not be one of those
 * things: a stale replica on a shared device is a nuisance, a session the user
 * cannot leave is a security problem. Resolves `true` when the replica was
 * dropped, `false` when the deadline hit or the teardown threw; the caller
 * proceeds with logout either way.
 *
 * On `false` the underlying `disconnectAndClear()` is still pending. It only
 * completes if the worker later becomes ready, which cannot happen for the
 * failure this guards against, so it is left to settle rather than raced
 * against a subsequent login.
 */
export async function disconnectAndClearPowerSyncForLogout(
  timeoutMs = POWER_SYNC_LOGOUT_TEARDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const outcome = await Promise.race([disconnectAndClearPowerSync().then(() => 'done' as const), deadline]);

    if (outcome === 'timeout') {
      console.warn(
        `[PowerSync] Local replica teardown did not finish within ${timeoutMs}ms; continuing logout without it`,
      );

      return false;
    }

    return true;
  } catch (error) {
    console.warn('[PowerSync] Local replica teardown failed; continuing logout without it', error);

    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function clearPowerSyncWorkingSet(): Promise<void> {
  await disconnectAndClearPowerSync();
  setLookbackDays(POWER_SYNC_DEFAULT_LOOKBACK_DAYS);
  requestPowerSyncReconnect();
}

export async function measurePowerSyncSizeBytes(db: AbstractPowerSyncDatabase): Promise<number | null> {
  try {
    const row = await db.getOptional<{ size: number }>(
      'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
    );

    return typeof row?.size === 'number' ? row.size : null;
  } catch {
    return null;
  }
}
