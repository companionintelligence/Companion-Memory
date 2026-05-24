import { Input, Label, Sheet } from '@ci/shadcn';

import { type FragmentType, useFragment } from '@/graphql';

import { BROWSER_ACTIVITY_FRAGMENT } from '../EntityCard/BrowserActivityCard';

interface Props {
  entity: FragmentType<typeof BROWSER_ACTIVITY_FRAGMENT>;
}

export function BrowserActivityDetails({ entity }: Props) {
  const data = useFragment(BROWSER_ACTIVITY_FRAGMENT, entity);

  return (
    <Sheet.Content className="z-index-1000">
      <Sheet.Header>
        <Sheet.Title>
          {data.actionType ? data.actionType[0].toUpperCase() + data.actionType.slice(1) + ' - ' : ''}
          {data.title}
        </Sheet.Title>
        <Sheet.Description>
          <div className="hover:text-blue-500 cursor-pointer" onClick={() => window.open(data.url, '_blank')}>
            {data.url}
          </div>
        </Sheet.Description>
      </Sheet.Header>
      <div className="grid flex-1 auto-rows-min gap-6 px-4">
        <div className="grid gap-3">
          <Label htmlFor="startTime">Start Time</Label>
          <Input id="startTime" disabled defaultValue={new Date(data.time).toLocaleString()} />
        </div>
      </div>
    </Sheet.Content>
  );
}
