import { Input, Label } from '@ci/shadcn';

import type { MemoryItem } from '../../types';

interface Props {
  memory: MemoryItem;
}

export function EventDetails({ memory }: Props) {
  return (
    <div className="grid flex-1 auto-rows-min gap-6 px-4">
      {memory?.location != null && (
        <div className="grid flex-1 auto-rows-min gap-6">
          <Label className="text-xl">Location</Label>
          <div className="grid gap-3">
            <Label htmlFor="address">Address</Label>
            <Input id="address" disabled defaultValue={memory.location.address} />
          </div>

          <div className="grid gap-3">
            <Label htmlFor="coordinates">Coordinates</Label>
            <Input
              id="coordinates"
              disabled
              defaultValue={`Latitude: ${memory.location.lat}, Longitude: ${memory.location.lng}`}
            />
          </div>
        </div>
      )}
      {memory.metadata?.sourceSystem != null && (
        <div className="grid flex-1 auto-rows-min gap-6 px-4">
          <div className="grid gap-3">
            <Label htmlFor="sourceSystem">Platform</Label>
            <Input id="sourceSystem" disabled defaultValue={memory.metadata.sourceSystem as string} />
          </div>
          )
        </div>
      )}
      {memory?.timestamp != null && (
        <div className="grid gap-3">
          <Label htmlFor="startTime">Start Time</Label>
          <Input id="startTime" disabled defaultValue={memory.timestamp} />
        </div>
      )}
      {memory?.metadata?.endTime != null && (
        <div className="grid gap-3">
          <Label htmlFor="endTime">End Time</Label>
          <Input id="endTime" disabled defaultValue={memory.metadata.endTime as string} />
        </div>
      )}
      {memory?.metadata?.durationMinutes != null && (
        <div className="grid gap-3">
          <Label htmlFor="duration">Duration</Label>
          <Input
            id="duration"
            disabled
            defaultValue={`${Math.floor((memory.metadata.durationMinutes as number) / 60)} hours, ${(memory.metadata.durationMinutes as number) % 60} minutes`}
          />
        </div>
      )}
    </div>
  );
}
