import { useQuery } from '@apollo/client';

import type { GenericEntity } from '../../useEntityService';

import { GET_DRAWER_NODE, genericEntityGlobalId, isDetailNode } from './drawerNode';
import { EntityDetails } from './EntityDetails';
import { GenericDetails } from './GenericDetails';

export { GET_DRAWER_NODE, genericEntityGlobalId } from './drawerNode';

interface Props {
  entity: GenericEntity;
}

/**
 * A relationship card (or graph node) only knows an entity's id, type and
 * name. Rather than showing that stub, fetch the full node and render the same
 * details body the entity would get if it had been clicked in the explorer.
 * Falls back to the stub view while loading, and stays on it for types with
 * no dedicated body.
 */
export function ResolvedGenericDetails({ entity }: Props) {
  const globalId = genericEntityGlobalId(entity);

  const { data } = useQuery(GET_DRAWER_NODE, {
    variables: { id: globalId ?? '' },
    skip: globalId == null,
    fetchPolicy: 'cache-first',
  });

  const node = data?.node ?? null;

  if (node && isDetailNode(node)) {
    return <EntityDetails entity={node} />;
  }

  return <GenericDetails entity={entity} />;
}
