import { type MouseEvent, type ReactNode } from 'react';

import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const EVENT_FRAGMENT = gql(`
  fragment TableEventRowData on EventType {
    id
    title
    description
  }
`);

interface Props {
  event: FragmentType<typeof EVENT_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function EventRow({ event, time, onClick }: Props) {
  const data = useFragment(EVENT_FRAGMENT, event);

  return (
    <EntityRow
      icon={<EventIcon />}
      title={data.title || 'Untitled event'}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
