import { Input, Label, Sheet } from '@ci/shadcn';

import { type FragmentType, useFragment } from '@/graphql';

import { EVENT_FRAGMENT } from '../EntityCard/EventCard';

interface Props {
  entity: FragmentType<typeof EVENT_FRAGMENT>;
}

export function EventDetails({ entity }: Props) {
  const data = useFragment(EVENT_FRAGMENT, entity);

  return (
    <Sheet.Content className="z-index-1000">
      <Sheet.Header>
        <Sheet.Title>{data.title}</Sheet.Title>
        <Sheet.Description>{data.description}</Sheet.Description>
      </Sheet.Header>
      <div className="grid flex-1 auto-rows-min gap-6 px-4">
        {data?.location != null && (
          <div className="grid flex-1 auto-rows-min gap-6">
            <Label className="text-xl">Location</Label>
            {data.location.name && (
              <div className="grid gap-3">
                <Label htmlFor="address">Name</Label>
                <Input id="address" disabled defaultValue={data.location.name} />
              </div>
            )}
            <div className="grid gap-3">
              <Label htmlFor="address">Address</Label>
              <Input id="address" disabled defaultValue={data.location.properties.address} />
            </div>

            <div className="grid gap-3">
              <Label htmlFor="coordinates">Coordinates</Label>
              <Input
                id="coordinates"
                disabled
                defaultValue={`Latitude: ${data.location.properties.latitude}, Longitude: ${data.location.properties.longitude}`}
              />
            </div>
          </div>
        )}
        {/*{data.metadata?.sourceSystem != null && (*/}
        {/*  <div className="grid flex-1 auto-rows-min gap-6 px-4">*/}
        {/*    <div className="grid gap-3">*/}
        {/*      <Label htmlFor="sourceSystem">Platform</Label>*/}
        {/*      <Input id="sourceSystem" disabled defaultValue={data.metadata.sourceSystem as string} />*/}
        {/*    </div>*/}
        {/*    )*/}
        {/*  </div>*/}
        {/*)}*/}
        {data?.startTime != null && (
          <div className="grid gap-3">
            <Label htmlFor="startTime">Start Time</Label>
            <Input id="startTime" disabled defaultValue={new Date(data.startTime).toLocaleString()} />
          </div>
        )}
        {data?.endTime != null && (
          <div className="grid gap-3">
            <Label htmlFor="endTime">End Time</Label>
            <Input id="endTime" disabled defaultValue={new Date(data.endTime).toLocaleString()} />
          </div>
        )}
        {/*{entity?.durationMinutes != null && (*/}
        {/*  <div className="grid gap-3">*/}
        {/*    <Label htmlFor="duration">Duration</Label>*/}
        {/*    <Input*/}
        {/*      id="duration"*/}
        {/*      disabled*/}
        {/*      defaultValue={`${Math.floor((data.durationMinutes as number) / 60)} hours, ${(data.durationMinutes as number) % 60} minutes`}*/}
        {/*    />*/}
        {/*  </div>*/}
        {/*)}*/}
      </div>
    </Sheet.Content>
  );
}
