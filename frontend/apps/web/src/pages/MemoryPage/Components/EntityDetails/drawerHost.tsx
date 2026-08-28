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
    const [{ refetch }, { setActiveEntity }] = service;

    return { setActiveEntity, refetch };
  }

  throw new Error('EntityDetails needs an EntityDrawerHostProvider or EntityServiceProvider above it');
}
