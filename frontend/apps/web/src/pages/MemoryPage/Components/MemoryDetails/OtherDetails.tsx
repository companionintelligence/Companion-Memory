import { Input, Label } from '@ci/shadcn';

import type { MemoryItem } from '../../types';

interface Props {
  memory: MemoryItem;
}

export function OtherDetails({ memory }: Props) {
  return (
    <div className="grid flex-1 auto-rows-min gap-6 px-4">
      {memory.metadata?.sourceSystem != null && (
        <div className="grid gap-3">
          <Label htmlFor="sourceSystem">Platform</Label>
          <Input id="sourceSystem" disabled defaultValue={`${memory.metadata.sourceSystem}`} />
        </div>
      )}
    </div>
  );
}
