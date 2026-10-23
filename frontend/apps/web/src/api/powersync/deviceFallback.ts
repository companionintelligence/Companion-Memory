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
import { useOptionalConnectionMode, type ConnectionMode } from '@ci/common';

import { getReplicaDatabase } from './session';

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

  if (connection == null) {
    return false;
  }

  return answersFromDevice({
    mode: connection.mode,
    isResolved: connection.isResolved,
    error,
    hasDatabase: getReplicaDatabase() != null,
  });
}
