import { Input, Label, Sheet } from '@ci/shadcn';

import { type FragmentType, useFragment } from '@/graphql';

import { COMMUNICATION_FRAGMENT } from '../EntityCard/CommunicationCard';

interface Props {
  entity: FragmentType<typeof COMMUNICATION_FRAGMENT>;
}

export function CommunicationDetails({ entity }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, entity);

  return (
    <Sheet.Content className="z-index-1000">
      <Sheet.Header>
        <Sheet.Title>
          {data.direction[0].toUpperCase() + data.direction.slice(1)}{' '}
          {data.type[0].toUpperCase() + data.type.slice(1)} - {data.subject || data.preview}
        </Sheet.Title>
        {data.subject && <Sheet.Description>{data.preview}</Sheet.Description>}
      </Sheet.Header>
      <div className="grid flex-1 auto-rows-min gap-6 px-4">
        <Sheet.Description>{data.communicationContent}</Sheet.Description>
        {data.from && (
          <div className="grid gap-3">
            <Sheet.Title>From</Sheet.Title>
            <Sheet.Description>{data.from.name}</Sheet.Description>
          </div>
        )}
        {data.to?.edges?.length > 0 && (
          <div className="grid gap-3">
            <Sheet.Title>To</Sheet.Title>
            {data.to.edges.map((person) => (
              <Sheet.Description>{person.node.name}</Sheet.Description>
            ))}
          </div>
        )}
        <div className="grid gap-3">
          <Label htmlFor="startTime">Start Time</Label>
          <Input id="startTime" disabled defaultValue={new Date(data.time).toLocaleString()} />
        </div>
      </div>
    </Sheet.Content>
  );
}
