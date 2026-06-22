import type { GenericEntity } from '../../useEntityService';

import { EntityDetailScaffold, type MetaItem } from './EntityDetailScaffold';

interface Props {
  entity: GenericEntity;
}

/**
 * Read-only detail view for entities without a dedicated, fragment-backed
 * component (e.g. graph nodes from the REST graph API). Renders the node's
 * generic fields through the shared scaffold so every memory view opens the
 * same drawer on click.
 */
export function GenericDetails({ entity }: Props) {
  const propertyEntries = Object.entries(entity.properties ?? {}).slice(0, 8);

  const metaItems: MetaItem[] = [
    { label: 'Type', value: entity.entityType },
    ...propertyEntries.map(([key, value]) => ({
      label: key,
      value: value != null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
    })),
  ];

  return (
    <EntityDetailScaffold
      entity={entity}
      title={entity.name ?? 'Untitled Entity'}
      subtitle={entity.description ?? undefined}
      metaItems={metaItems}
      rawData={entity.properties}
    />
  );
}
