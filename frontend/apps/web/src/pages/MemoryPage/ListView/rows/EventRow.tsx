import { type MouseEvent, type ReactNode } from 'react';

import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { eventDisplayTitle } from '../../Components/utils';

import { EntityRow } from './EntityRow';

export const EVENT_FRAGMENT = gql(`
  fragment TableEventRowData on EventType {
    id
    title
    description
    startTime
    locationName
    previewUrl
    mediaContentType
  }
`);

interface Props {
  event: FragmentType<typeof EVENT_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function EventRow({ event, time, onClick }: Props) {
  const data = useFragment(EVENT_FRAGMENT, event);

  // Photo/video events show their thumbnail in the compact icon slot (mirrors
  // FileRow) and a derived "Photo · place · date" title instead of a filename.
  const thumbUrl = data.previewUrl ? `/static${data.previewUrl}` : undefined;
  const title = eventDisplayTitle({
    title: data.title,
    startTime: data.startTime,
    locationName: data.locationName,
    mediaContentType: data.mediaContentType,
  });

  return (
    <EntityRow
      icon={
        thumbUrl ? (
          <img src={thumbUrl} alt={title} className="h-9 w-9 rounded-md bg-muted object-cover" />
        ) : (
          <EventIcon />
        )
      }
      title={title || 'Untitled event'}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
