import { type MouseEvent } from 'react';

import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const EVENT_FRAGMENT = gql(`
  fragment EventGridItemData on EventType {
    id
    title
    description
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

        <div className="text-md font-semibold truncate">{data.title}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.description}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Event</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
