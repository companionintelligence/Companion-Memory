import { createContext, useContext } from 'react';

import { useOptionalEntityService, type MemoryEntity } from '../../useEntityService';

/**
 * What the details drawer needs from whoever mounts it: a way to swap the
 * shown entity (opening a related entity, or `null` to close after a delete)
 * and a way to refresh the list behind it after a restore.
 */
export interface EntityDrawerHost {
  setActiveEntity: (entity: MemoryEntity | null) => void;
  refetch: () => void;
  /**
   * Swap a re-fetched copy of the shown entity in, but only while that same
   * entity is still shown (see withFresherEntity). A drawer rendering a
   * snapshot re-reads nothing from the cache, so without this a refetch for
   * fresh media links never reaches it. Optional: a host whose entity is
   * always a live query result can leave it out.
   */
  refreshActiveEntity?: (entity: MemoryEntity) => void;
}

const EntityDrawerHostContext = createContext<EntityDrawerHost | null>(null);

/** Mount around `EntityDetails` on pages that aren't the memory explorer. */
export const EntityDrawerHostProvider = EntityDrawerHostContext.Provider;

/**
 * The explorer provides these through `EntityServiceProvider`; any other page
 * (the content library, …) wraps the drawer in `EntityDrawerHostProvider`.
 */
export function useEntityDrawerHost(): EntityDrawerHost {
  const host = useContext(EntityDrawerHostContext);
  const service = useOptionalEntityService();

  if (host) {
    return host;
  }

  if (service) {
    const [{ refetch }, { setActiveEntity, refreshActiveEntity }] = service;

    return { setActiveEntity, refetch, refreshActiveEntity };
  }

  throw new Error('EntityDetails needs an EntityDrawerHostProvider or EntityServiceProvider above it');
}
