import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

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
import { NATIVE_DB_ON_DISK_FILENAME } from './nativeDatabase';
import { isPreviewSyncEnabled, startPreviewSync, stopPreviewSync, subscribePreviewSync } from './previews';
import { countDocuments, ensureDocumentsTable, ensureSearchIndex, watchBulkDownloads } from './searchIndex';
import { bindPowerSyncDatabase, measurePowerSyncSizeBytes, setReplicaOpenState } from './session';
import { openWebPowerSyncDatabase } from './webDatabase';
import { POWER_SYNC_CACHE_BUDGET_BYTES, shrinkToBudget } from './workingSet';

/**
 * Mounts the local-first PowerSync database and exposes it via `PowerSyncContext`.
 *
 * Only the ENCRYPTED replica ever syncs: Capacitor SQLite opened through
 * SQLCipher on a phone (one 8 GB rolling working set). In a desktop browser,
 * and on a phone whose native adapter failed to load, the database is
 * WASQLite over IndexedDB — a plaintext file in the browser profile, which
 * `SECURITY_ARCHITECTURE.md` § 2.3 explains cannot be encrypted in any way
 * that matters. Since 2026-10-20 that database is never connected: the
 * provider wipes whatever an earlier build synced into it and leaves it
 * empty, and GraphQL is the browser's only source. GraphQL also remains the
 * source of truth on a phone when PowerSync is down (token endpoint 503) or
 * a row is outside the subscribed window.
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

  const webDatabase = useMemo(() => openWebPowerSyncDatabase(), []);
  const [database, setDatabase] = useState<AbstractPowerSyncDatabase>(webDatabase);
  // Whether `database` is the one this platform will keep. On web it is from the
  // start. On native it is not until the SQLite adapter below has been chosen (or
  // failed to load): the IndexedDB database is only a placeholder there, and
  // connecting it would sync the user's rows into a plaintext IndexedDB file on
  // the phone — exactly the copy the encrypted replica exists to avoid.
  const [storageDecided, setStorageDecided] = useState(() => !isNativePlatform());
  // Whether `database` is the SQLCipher file — the only replica allowed to hold
  // the user's rows. False in a browser, and on a phone whose native adapter
  // did not load, where `database` is plaintext IndexedDB.
  const [replicaEncrypted, setReplicaEncrypted] = useState(false);
  // The database whose raw tables exist. The sync client writes the search
  // documents straight into a table this app owns (searchIndex.ts), and its
  // first write fails if that table is missing, so nothing connects before
  // `ensureDocumentsTable` has run on the handle that will be connected.
  const [preparedDatabase, setPreparedDatabase] = useState<AbstractPowerSyncDatabase | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const apiBaseUrl = useSyncExternalStore(subscribeApiBaseUrl, getApiBaseUrl, getApiBaseUrl);
  // The server that said it runs no PowerSync service, if any.
  const [syncOffFor, setSyncOffFor] = useState<string | null>(null);

  useEffect(() => {
    bindPowerSyncDatabase(webDatabase);
    setDatabase(webDatabase);

    if (!isNativePlatform()) {
      return () => {
        bindPowerSyncDatabase(null);
        void webDatabase.close();
      };
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

            if (attempt) {
              bindPowerSyncDatabase(attempt as AbstractPowerSyncDatabase, { replica: true });
            } else {
              bindPowerSyncDatabase(webDatabase);
            }
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
        setReplicaEncrypted(true);
        setStorageDecided(true);
        void webDatabase.close();

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

        console.warn('[PowerSync] Native SQLite adapter unavailable; using IndexedDB VFS', error);
        // The error states read this: a phone that should have a copy but could not open
        // it says so, rather than blaming a server that may also be away.
        setReplicaOpenState({
          phase: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        });
        bindPowerSyncDatabase(webDatabase);
        setStorageDecided(true);
      });

    return () => {
      cancelled = true;
      opening.abort();
      unsubscribePreviews?.();
      stopPreviewSync();
      bindPowerSyncDatabase(null);
      setLocalSearchReplicaFile(null);
      void native?.close();
    };
  }, [webDatabase]);

  // A plaintext database holds nothing. Whatever a build from before
  // 2026-10-20 synced into a browser's IndexedDB is dropped on the next load,
  // and nothing below connects it. The native placeholder never gets here:
  // `storageDecided` stays false until the encrypted file has replaced it.
  useEffect(() => {
    if (!storageDecided || replicaEncrypted) {
      return;
    }

    void database.disconnectAndClear().catch((error: unknown) => {
      console.warn('[PowerSync] Could not clear the plaintext browser replica', error);
    });
  }, [database, storageDecided, replicaEncrypted]);

  // The device's documents table, its search index, and the signal the
  // connection chip reads to say "cached" rather than "fresh" when no server
  // answers. All follow whichever database this platform settled on, and
  // exist only where that database syncs.
  useEffect(() => {
    if (!storageDecided || !replicaEncrypted) {
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
  }, [database, storageDecided, replicaEncrypted]);

  useEffect(() => {
    const onReconnect = () => setReconnectNonce((n) => n + 1);

    window.addEventListener('ci-powersync-reconnect', onReconnect);

    return () => window.removeEventListener('ci-powersync-reconnect', onReconnect);
  }, []);

  useEffect(() => {
    // Nothing is connected yet while the storage is undecided, so there is
    // nothing to disconnect either; and a plaintext database is never
    // connected at all (see the wipe above).
    if (!storageDecided || !replicaEncrypted) {
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
  }, [
    database,
    storageDecided,
    replicaEncrypted,
    preparedDatabase,
    authenticated,
    reconnectNonce,
    apiBaseUrl,
    syncOffFor,
  ]);

  useEffect(() => {
    if (!authenticated || !replicaEncrypted) {
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
  }, [database, authenticated, replicaEncrypted, reconnectNonce]);

  return <PowerSyncContext.Provider value={database as never}>{children}</PowerSyncContext.Provider>;
}
