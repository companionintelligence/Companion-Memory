/**
 * Whether a view answers from this phone's synced replica instead of the appliance.
 *
 * The same two triggers as the header box's `useSearchService`: the connection chip says
 * the appliance is unreachable, or the appliance's request failed on the network. Two
 * differences, both because a view is a page and not a dropdown:
 *
 * - Never before the first probe has settled (`isResolved`). The mode starts as an
 *   absence of an answer, and flashing "Saved on this phone" over every page load would
 *   make the local view look like the normal one.
 * - Never without a synced replica to read (`hasDatabase`): a desktop browser syncs
 *   nothing, and its offline answer is the appliance's error state.
 *
 * One rule for every offline surface — the Memory list, the events chronology, the
 * timeline tab, the map's pins, the people list, and the error state's copy — so they
 * all flip together.
 */
import { useSyncExternalStore } from 'react';

import { useOptionalConnectionMode, type ConnectionMode } from '@ci/common';

import { isReplicaLockedError } from './replicaErrors';
import {
  getReplicaDatabase,
  getReplicaOpenState,
  subscribeBoundDatabase,
  subscribeReplicaOpenState,
} from './session';

export function answersFromDevice({
  mode,
  isResolved,
  error,
  hasDatabase,
}: {
  mode: ConnectionMode;
  isResolved: boolean;
  error: unknown;
  hasDatabase: boolean;
}): boolean {
  if (!hasDatabase) {
    return false;
  }

  if (isResolved && mode !== 'connected') {
    return true;
  }

  return Boolean(
    error != null &&
    typeof error === 'object' &&
    'networkError' in error &&
    (error as { networkError?: unknown }).networkError,
  );
}

/**
 * {@link answersFromDevice} for the current connection probe. `error` is the appliance
 * request the view would otherwise render, when it has one. Optional probe: the views
 * also render in trees without a connection provider (tests, embeds), where the
 * appliance's answer is the only one.
 */
export function useAnswersFromDevice(error?: unknown): boolean {
  const connection = useOptionalConnectionMode();
  const database = useReplicaDatabase();

  if (connection == null) {
    return false;
  }

  return answersFromDevice({
    mode: connection.mode,
    isResolved: connection.isResolved,
    error,
    hasDatabase: database != null,
  });
}

/**
 * The phone's replica as a render-time value that follows the binding: null until the
 * provider has opened it, the database after, null again if it is torn down. Reading
 * `getReplicaDatabase()` in render instead froze whatever answer the first render got.
 */
export function useReplicaDatabase() {
  return useSyncExternalStore(subscribeBoundDatabase, getReplicaDatabase, getReplicaDatabase);
}

export interface ReplicaOpenStatus {
  /** The appliance is unreachable and this phone's copy is still being opened (or retried): wait. */
  opening: boolean;
  /** The appliance is unreachable AND this phone's own copy could not be opened: nothing can answer. */
  failed: boolean;
  /** The copy failed because another connection still held its write lock (`ReplicaLockedError`). */
  locked: boolean;
}

const NOTHING_TO_SAY: ReplicaOpenStatus = { opening: false, failed: false, locked: false };

/**
 * The cases {@link useAnswersFromDevice} cannot express: the phone should have a replica,
 * the appliance is not answering, and the replica is either still opening or could not be
 * opened. Without this a phone whose own copy is stuck reads "Needs the Memory server",
 * which points at the wrong thing — the server being away is not why there is nothing to
 * show. Says nothing while the appliance answers or before the first probe.
 */
export function useReplicaOpenState(): ReplicaOpenStatus {
  const connection = useOptionalConnectionMode();
  const state = useSyncExternalStore(subscribeReplicaOpenState, getReplicaOpenState, getReplicaOpenState);

  if (connection == null || !connection.isResolved || connection.mode === 'connected') {
    return NOTHING_TO_SAY;
  }

  if (state.phase === 'opening') {
    return { opening: true, failed: false, locked: false };
  }

  if (state.phase === 'failed') {
    return { opening: false, failed: true, locked: isReplicaLockedError(state.error) };
  }

  return NOTHING_TO_SAY;
}
