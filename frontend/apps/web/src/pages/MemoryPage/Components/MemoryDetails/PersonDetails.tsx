import { Input, Label } from '@ci/shadcn';

import type { MemoryItem } from '../../types';

interface Props {
  memory: MemoryItem;
}

export function PersonDetails({ memory }: Props) {
  return (
    <div className="grid flex-1 auto-rows-min gap-6 px-4">
      {memory.metadata?.properties?.first_name != null && (
        <div className="grid gap-3">
          <Label htmlFor="firstName">First Name</Label>
          <Input id="firstName" disabled defaultValue={`${memory.metadata.properties.first_name}`} />
        </div>
      )}
      {memory.metadata?.properties?.last_name != null && (
        <div className="grid gap-3">
          <Label htmlFor="lastName">Last Name</Label>
          <Input id="lastName" disabled defaultValue={`${memory.metadata.properties.last_name}`} />
        </div>
      )}
      {memory.metadata?.properties?.email != null && (
        <div className="grid gap-3">
          <Label htmlFor="email">Email</Label>
          <Input id="email" disabled defaultValue={`${memory.metadata.properties.email}`} />
        </div>
      )}
      {memory.metadata?.properties?.family_role != null && (
        <div className="grid gap-3">
          <Label htmlFor="relationship">Relationship</Label>
          <Input id="relationship" disabled defaultValue={`${memory.metadata.properties.family_role}`} />
        </div>
      )}
      {memory.metadata?.properties?.occupation != null && (
        <div className="grid gap-3">
          <Label htmlFor="occupation">Occupation</Label>
          <Input id="occupation" disabled defaultValue={`${memory.metadata.properties.occupation}`} />
        </div>
      )}
    </div>
  );
}
