import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { getApiBaseUrl, isNativePlatform, registerCachedDataProbe, subscribeApiBaseUrl } from '@ci/common';
import { PowerSyncContext } from '@powersync/react';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { useAuth } from '@/hooks';

import { GraphQLBackendConnector } from './connector';
import { countDocuments, ensureSearchIndex } from './searchIndex';
import { bindPowerSyncDatabase, measurePowerSyncSizeBytes } from './session';
import { openWebPowerSyncDatabase } from './webDatabase';
import { POWER_SYNC_CACHE_BUDGET_BYTES, shrinkToBudget } from './workingSet';

/**
 * Mounts the local-first PowerSync database and exposes it via `PowerSyncContext`.
 *
 * On native this is Capacitor SQLite (one 8 GB rolling working set). On web it is
 * WASQLite IndexedDB. GraphQL remains the source of truth when PowerSync is down
 * (token endpoint 503) or a row is outside the subscribed window.
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

    void import('./nativeDatabase')
      .then(({ openNativePowerSyncDatabase }) => {
        if (cancelled) {
          return;
        }

        native = openNativePowerSyncDatabase() as AbstractPowerSyncDatabase;
        bindPowerSyncDatabase(native);
        setDatabase(native);
        setStorageDecided(true);
        void webDatabase.close();
      })
      .catch((error: unknown) => {
        console.warn('[PowerSync] Native SQLite adapter unavailable; using IndexedDB VFS', error);
        bindPowerSyncDatabase(webDatabase);
        setStorageDecided(true);
      });

    return () => {
      cancelled = true;
      bindPowerSyncDatabase(null);
      void native?.close();
    };
  }, [webDatabase]);

  // The device's search index over the synced documents, and the signal the
  // connection chip reads to say "cached" rather than "fresh" when no server
  // answers. Both follow whichever database this platform settled on.
  useEffect(() => {
    if (!storageDecided) {
      return;
    }

    // Aborting releases a build still waiting for a first sync this handle
    // will never see (the database was swapped, or the app signed out).
    const controller = new AbortController();

    void ensureSearchIndex(database, { signal: controller.signal })
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

    return () => {
      controller.abort();
      unregister();
    };
  }, [database, storageDecided]);

  useEffect(() => {
    const onReconnect = () => setReconnectNonce((n) => n + 1);

    window.addEventListener('ci-powersync-reconnect', onReconnect);

    return () => window.removeEventListener('ci-powersync-reconnect', onReconnect);
  }, []);

  useEffect(() => {
    // Nothing is connected yet while the storage is undecided, so there is
    // nothing to disconnect either.
    if (!storageDecided) {
      return;
    }

    if (!authenticated || syncOffFor === apiBaseUrl) {
      void database.disconnect();

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
  }, [database, storageDecided, authenticated, reconnectNonce, apiBaseUrl, syncOffFor]);

  useEffect(() => {
    if (!authenticated) {
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
