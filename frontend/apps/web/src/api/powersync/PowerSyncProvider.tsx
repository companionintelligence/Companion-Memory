import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  getApiBaseUrl,
  isNativePlatform,
  registerCachedDataProbe,
  setLocalSearchReplicaFile,
  subscribeApiBaseUrl,
} from '@ci/common';
import { PowerSyncContext } from '@powersync/react';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { useAuth } from '@/hooks';

import { GraphQLBackendConnector } from './connector';
import { purgeLegacyIndexedDbReplica } from './legacyIndexedDb';
import { NATIVE_DB_ON_DISK_FILENAME } from './nativeDatabase';
import { isPreviewSyncEnabled, startPreviewSync, stopPreviewSync, subscribePreviewSync } from './previews';
import { countDocuments, ensureDocumentsTable, ensureSearchIndex, watchBulkDownloads } from './searchIndex';
import { bindPowerSyncDatabase, measurePowerSyncSizeBytes, setReplicaOpenState } from './session';
import { POWER_SYNC_CACHE_BUDGET_BYTES, shrinkToBudget } from './workingSet';

/**
 * Mounts the local-first PowerSync database and exposes it via `PowerSyncContext`.
 *
 * There is exactly one database this app will ever hold: the ENCRYPTED replica,
 * Capacitor SQLite opened through SQLCipher on a phone (one 8 GB rolling working
 * set). A desktop browser has none — `SECURITY_ARCHITECTURE.md` § 2.3 explains why
 * a plaintext IndexedDB copy cannot be encrypted in any way that matters, and since
 * 2026-10-20 the browser does not sync; since 2026-10-26 it does not even open a
 * database, and neither does a phone while its replica is still opening or when
 * the native adapter failed. The context value is `null` in all of those cases,
 * and GraphQL is the only source. GraphQL also remains the source of truth on a
 * phone when PowerSync is down (token endpoint 503) or a row is outside the
 * subscribed window.
 *
 * A server that answers "PowerSync is not configured" is not asked again until
 * this provider remounts (sign-in, app start) or the app points at another
 * server. Left connected, the SDK would ask it for a token every few seconds for
 * as long as the app is open.
 */
export function PowerSyncProvider({ children }: { children: ReactNode }) {
  const [{ authToken, authenticated }] = useAuth();
  const tokenRef = useRef(authToken);

  tokenRef.current = authToken;

  // The encrypted replica once it is open. Null in a browser, on a phone whose
  // native adapter did not load, and on a phone while the file is still opening.
  // Nothing below connects, indexes or measures anything until it is set, so no
  // other database can ever receive the user's rows.
  const [database, setDatabase] = useState<AbstractPowerSyncDatabase | null>(null);
  // The database whose raw tables exist. The sync client writes the search
  // documents straight into a table this app owns (searchIndex.ts), and its
  // first write fails if that table is missing, so nothing connects before
  // `ensureDocumentsTable` has run on the handle that will be connected.
  const [preparedDatabase, setPreparedDatabase] = useState<AbstractPowerSyncDatabase | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const apiBaseUrl = useSyncExternalStore(subscribeApiBaseUrl, getApiBaseUrl, getApiBaseUrl);
  // The server that said it runs no PowerSync service, if any.
  const [syncOffFor, setSyncOffFor] = useState<string | null>(null);

  // Earlier builds left an IndexedDB database behind on every platform (a synced
  // copy in browsers before 2026-10-20, an empty placeholder everywhere before
  // 2026-10-26). Delete it; nothing here opens one again.
  useEffect(() => {
    void purgeLegacyIndexedDbReplica()
      .then((removed) => {
        if (removed.length > 0) {
          console.info(`[PowerSync] Removed the legacy IndexedDB database (${removed.join(', ')})`);
        }
      })
      .catch((error: unknown) => {
        console.warn('[PowerSync] Could not remove the legacy IndexedDB database', error);
      });
  }, []);

  useEffect(() => {
    if (!isNativePlatform()) {
      // A browser holds no database: nothing to open, bind or connect.
      return;
    }

    let cancelled = false;
    let native: AbstractPowerSyncDatabase | undefined;
    let unsubscribePreviews: (() => void) | undefined;
    // Stops a retry that is still waiting out a stale lock when this effect is torn down.
    const opening = new AbortController();

    setReplicaOpenState({ phase: 'opening' });

    void import('./nativeDatabase')
      .then(async ({ openReplicaWithRetry }) => {
        // Waits for PowerSync's own startup, and retries it when the file is held by an
        // earlier page instance's connection (see `openReplicaWithRetry`). Each attempt is
        // bound the moment it is constructed, as the handle always was: the offline views
        // decide at render time whether this phone can answer, and the SDK's methods wait
        // for startup on their behalf. A failed attempt is unbound, so a view that asked it
        // mounts afresh against the next one.
        const opened = (await openReplicaWithRetry({
          signal: opening.signal,
          onAttempt: (attempt) => {
            if (cancelled) {
              return;
            }

            bindPowerSyncDatabase(attempt ? (attempt as AbstractPowerSyncDatabase) : null, {
              replica: attempt != null,
            });
          },
          onRetry: (attempt, delayMs, error) => {
            console.warn(
              `[PowerSync] The replica is locked by another connection; retrying in ${delayMs}ms (attempt ${attempt})`,
              error,
            );
          },
        })) as AbstractPowerSyncDatabase;

        if (cancelled) {
          void opened.close().catch(() => undefined);

          return;
        }

        native = opened;
        setReplicaOpenState({ phase: 'open' });
        bindPowerSyncDatabase(native, { replica: true });
        // The on-device model may search this file itself (its knowledge_search tool).
        setLocalSearchReplicaFile(NATIVE_DB_ON_DISK_FILENAME);
        setDatabase(native);

        // The preview store follows its setting: on, it fetches what the
        // replica names; off, it stops (previews.ts).
        const replica = native;
        const followSetting = () => {
          if (isPreviewSyncEnabled()) {
            void startPreviewSync(replica);
          } else {
            stopPreviewSync();
          }
        };

        followSetting();
        unsubscribePreviews = subscribePreviewSync(followSetting);
      })
      .catch((error: unknown) => {
        if (cancelled && error instanceof Error && error.name === 'AbortError') {
          return;
        }

        console.warn('[PowerSync] Native SQLite adapter unavailable; this phone keeps no copy', error);
        // The error states read this: a phone that should have a copy but could not open
        // it says so, rather than blaming a server that may also be away.
        setReplicaOpenState({
          phase: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        });
        bindPowerSyncDatabase(null);
      });

    return () => {
      cancelled = true;
      opening.abort();
      unsubscribePreviews?.();
      stopPreviewSync();
      bindPowerSyncDatabase(null);
      setLocalSearchReplicaFile(null);
      setDatabase(null);
      void native?.close();
    };
  }, []);

  // The device's documents table, its search index, and the signal the
  // connection chip reads to say "cached" rather than "fresh" when no server
  // answers. All exist only once the encrypted replica is open.
  useEffect(() => {
    if (!database) {
      return;
    }

    // Aborting releases a build still waiting for a first sync this handle
    // will never see (the database was swapped, or the app signed out).
    const controller = new AbortController();

    const prepared = ensureDocumentsTable(database)
      .catch((error: unknown) => {
        // Connecting anyway is the lesser evil: without the table the sync
        // client's first write fails and PowerSync retries, which is loud
        // and visible, where never connecting would be a silent stall.
        console.warn('[PowerSync] Could not create the on-device documents table', error);
      })
      .then(() => {
        if (!controller.signal.aborted) {
          setPreparedDatabase(database);
        }
      });

    void prepared
      .then(() => ensureSearchIndex(database, { signal: controller.signal }))
      .then((built) => {
        if (built && !controller.signal.aborted) {
          console.info('[PowerSync] Built the on-device search index');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(
            '[PowerSync] Could not build the on-device search index; search stays online-only',
            error,
          );
        }
      });

    const unregister = registerCachedDataProbe(async () => (await countDocuments(database)) > 0);
    const unwatch = watchBulkDownloads(database, {
      onChange: (event, operations) => {
        console.info(
          event === 'suspended'
            ? `[PowerSync] Paused the on-device search index for a bulk download of ${operations} operations`
            : `[PowerSync] Rebuilt the on-device search index after a bulk download of ${operations} operations`,
        );
      },
    });

    return () => {
      controller.abort();
      unregister();
      unwatch();
    };
  }, [database]);

  useEffect(() => {
    const onReconnect = () => setReconnectNonce((n) => n + 1);

    window.addEventListener('ci-powersync-reconnect', onReconnect);

    return () => window.removeEventListener('ci-powersync-reconnect', onReconnect);
  }, []);

  useEffect(() => {
    // Nothing to connect, or disconnect, until the encrypted replica is open.
    if (!database) {
      return;
    }

    if (!authenticated || syncOffFor === apiBaseUrl) {
      void database.disconnect();

      return;
    }

    if (preparedDatabase !== database) {
      return;
    }

    const connector = new GraphQLBackendConnector(
      () => tokenRef.current ?? null,
      (answeredFor) => {
        // Only an answer from this connector's server, while the app is still on
        // it, counts. A late answer from a server the app has since left (or one
        // a request reached mid-switch) must not touch the connection to another.
        if (answeredFor === apiBaseUrl && getApiBaseUrl() === apiBaseUrl) {
          setSyncOffFor(apiBaseUrl);
        }
      },
    );

    void database.connect(connector).catch((error: unknown) => {
      console.warn('[PowerSync] Connect skipped; GraphQL remains the source of truth', error);
    });
  }, [database, preparedDatabase, authenticated, reconnectNonce, apiBaseUrl, syncOffFor]);

  useEffect(() => {
    if (!authenticated || !database) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      const size = await measurePowerSyncSizeBytes(database);

      if (cancelled || size == null || size <= POWER_SYNC_CACHE_BUDGET_BYTES) {
        return;
      }

      shrinkToBudget(size);
      await database.disconnect();
      setReconnectNonce((n) => n + 1);
    };

    void tick();
    const id = window.setInterval(() => void tick(), 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [database, authenticated, reconnectNonce]);

  return <PowerSyncContext.Provider value={database as never}>{children}</PowerSyncContext.Provider>;
}
