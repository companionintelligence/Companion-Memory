/**
 * A watched query against the phone's encrypted replica, with a hook sequence that does
 * not depend on whether the replica is open.
 *
 * `useQuery` from `@powersync/react` returns before calling any hook when its context holds
 * no database, and calls several once it does. Since 2026-10-26 the provider's context is
 * `null` until the SQLCipher file is open (PowerSyncProvider.tsx), so a component mounted
 * across that moment -- the lock mirror, the Memory page's saved-search lookup -- changed
 * its hook order mid-life and React threw the tree away ("change in the order of Hooks";
 * seen on the phone on 2026-10-27, which left the lock screen's note dead for the session).
 * This hook reads the binding the provider publishes (`useReplicaDatabase`) and subscribes
 * with the database's own `watch`, so the same hooks run on every render whatever the
 * replica is doing.
 *
 * No database (a browser, a phone whose replica is still opening or failed) reads as no
 * rows, not loading and no error: there is nothing to ask, and the callers already know why.
 */
import { useCallback, useEffect, useState } from 'react';

import { useReplicaDatabase } from './deviceFallback';

export interface ReplicaQueryResult<T> {
  data: T[];
  /** A replica is bound and its first answer for this query has not arrived yet. */
  isLoading: boolean;
  error: Error | undefined;
  /** Subscribe again from scratch, which also clears an error. */
  refresh: () => void;
}

interface Settled<T> {
  /** The subscription this answer belongs to; an answer for another one is not shown. */
  key: string;
  data: T[];
  error: Error | undefined;
}

const NO_ROWS: never[] = [];

export function useReplicaQuery<T>(sql: string, parameters: readonly unknown[] = []): ReplicaQueryResult<T> {
  const database = useReplicaDatabase();
  // Compared by value: callers pass a fresh array literal on every render.
  const parametersKey = JSON.stringify(parameters);
  const [nonce, setNonce] = useState(0);
  const key = `${nonce}\u0000${sql}\u0000${parametersKey}`;
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    if (!database) {
      return;
    }

    const controller = new AbortController();

    database.watch(
      sql,
      JSON.parse(parametersKey) as unknown[],
      {
        onResult: (result) => {
          if (!controller.signal.aborted) {
            setSettled({ key, data: (result.rows?._array ?? []) as T[], error: undefined });
          }
        },
        onError: (error) => {
          if (!controller.signal.aborted) {
            setSettled({ key, data: NO_ROWS, error });
          }
        },
      },
      { signal: controller.signal },
    );

    return () => controller.abort();
  }, [database, key, sql, parametersKey]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const current = database && settled?.key === key ? settled : null;

  return {
    data: current?.data ?? NO_ROWS,
    isLoading: database != null && current == null,
    error: current?.error,
    refresh,
  };
}
