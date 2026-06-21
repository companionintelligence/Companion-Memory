import { Badge, Input, Label, Sheet } from '@ci/shadcn';

import type { GenericEntity } from '../../../MemoryPage/useEntityService';

interface Props {
  entity: GenericEntity;
}

/**
 * Fallback details view for entities without a dedicated, fragment-backed
 * detail component (e.g. graph nodes from the REST graph API). Renders the
 * node's generic fields inside the shared EntityDetails sheet so every memory
 * view opens the same sheet on click.
 */
export function GenericDetails({ entity }: Props) {
  const propertyEntries = Object.entries(entity.properties ?? {}).slice(0, 8);

  return (
    <Sheet.Content className="z-index-1000">
      <Sheet.Header>
        <Sheet.Title className="truncate">{entity.name ?? 'Untitled Entity'}</Sheet.Title>
        {entity.description && <Sheet.Description>{entity.description}</Sheet.Description>}
      </Sheet.Header>
      <div className="grid flex-1 auto-rows-min gap-6 px-4">
        {entity.entityType && (
          <div className="grid gap-3">
            <Label>Type</Label>
            <div>
              <Badge variant="outline">{entity.entityType}</Badge>
            </div>
          </div>
        )}
        {propertyEntries.length > 0 && (
          <div className="grid auto-rows-min gap-6">
            <Label className="text-xl">Properties</Label>
            {propertyEntries.map(([key, value]) => (
              <div key={key} className="grid gap-3">
                <Label htmlFor={`generic-prop-${key}`}>{key}</Label>
                <Input id={`generic-prop-${key}`} disabled defaultValue={String(value ?? '')} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet.Content>
  );
}
