import { type MouseEvent } from 'react';

import { MapPin } from '@ci/shadcn/icons';

import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatDateTime } from '@/pages/MemoryPage/Components/utils';

import { EntityGridItem } from './EntityGridItem';
import { SourceBadge } from './SourceBadge';

export const EVENT_FRAGMENT = gql(`
  fragment EventGridItemData on EventType {
    id
    title
    description
    startTime
    eventType
    locationName
    sourceSystem
  }
`);

interface Props {
  event: FragmentType<typeof EVENT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function EventGridItem({ event, onClick }: Props) {
  const data = useFragment(EVENT_FRAGMENT, event);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <EventIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.title || 'Untitled event'}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight text-sm text-muted-foreground">
          {data.description || data.eventType}
        </div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="justify-between">
        <EntityGridItem.Meta>
          {data.startTime && <span className="truncate">{formatDateTime(data.startTime)}</span>}
          {data.locationName && (
            <span className="flex items-center gap-0.5 truncate">
              <MapPin className="size-3 shrink-0" />
              {data.locationName}
            </span>
          )}
        </EntityGridItem.Meta>
        <SourceBadge source={data.sourceSystem} fallback="Event" />
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
