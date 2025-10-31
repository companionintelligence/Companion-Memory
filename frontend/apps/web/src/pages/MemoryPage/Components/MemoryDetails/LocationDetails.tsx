import { Input, Label } from '@ci/shadcn';

import type { MemoryItem } from '../../types';

interface Props {
  memory: MemoryItem;
}

export function LocationDetails({ memory }: Props) {
  return (
    <div className="grid flex-1 auto-rows-min gap-6 px-4">
      <Label className="text-xl">Location</Label>
      {memory.location?.address && (
        <div className="grid gap-3">
          <Label htmlFor="address">Address</Label>
          <Input id="address" disabled defaultValue={memory.location.address} />
        </div>
      )}

      {memory.location?.lat && memory.location?.lng && (
        <div className="grid gap-3">
          <Label htmlFor="coordinates">Coordinates</Label>
          <Input
            id="coordinates"
            disabled
            defaultValue={`Latitude: ${memory.location.lat}, Longitude: ${memory.location.lng}`}
          />
        </div>
      )}
    </div>
  );
}
