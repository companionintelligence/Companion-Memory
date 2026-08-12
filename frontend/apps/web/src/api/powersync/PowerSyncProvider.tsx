import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import { PowerSyncContext } from '@powersync/react';
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';

import { useAuth } from '@/hooks';

import { GraphQLBackendConnector } from './connector';
import { AppSchema } from './schema';

/**
 * Mounts the local-first PowerSync database and exposes it via `PowerSyncContext`
 * (consumed by `useQuery`/`usePowerSync` from `@powersync/react`), mirroring
 * `ApolloProvider`'s token-ref pattern so a refreshed JWT is picked up without
 * recreating the connector.
 */
export function PowerSyncProvider({ children }: { children: ReactNode }) {
  const [{ authToken, authenticated }] = useAuth();

  const tokenRef = useRef(authToken);

  tokenRef.current = authToken;

  // Created once and never torn down for auth changes — only the connector
  // (re)connects/disconnects below. Re-creating the database itself would drop
  // the open SQLite connection and any in-flight watched queries.
  const database = useMemo(() => {
    return new PowerSyncDatabase({
      schema: AppSchema,
      database: new WASQLiteOpenFactory({
        dbFilename: 'ci-powersync.db',
        // IDBBatchAtomicVFS (IndexedDB-backed) is the only VFS that works without
        // cross-origin-isolation headers, which the Capacitor webview can't set —
        // this is also the library default, set explicitly so it's not mistaken
        // for an oversight. Do not switch to OPFSCoopSyncVFS or similar.
        vfs: WASQLiteVFS.IDBBatchAtomicVFS,
      }),
    });
  }, []);

  useEffect(() => {
    if (!authenticated) {
      // No session yet, or just logged out — nothing to connect. Dropping any
      // previous connection here avoids continuing to sync a signed-out device.
      //
      // Known gap: this does not clear locally-synced data on logout
      // (`disconnectAndClear()`), so a second user signing in on a shared device
      // would see the previous user's rows until the next full resync. Not
      // addressed in this pass — flag before shipping multi-user native support.
      void database.disconnect();

      return;
    }

    const connector = new GraphQLBackendConnector(() => tokenRef.current ?? null);

    void database.connect(connector);
  }, [database, authenticated]);

  useEffect(() => {
    return () => {
      void database.close();
    };
  }, [database]);

  return <PowerSyncContext.Provider value={database}>{children}</PowerSyncContext.Provider>;
}
