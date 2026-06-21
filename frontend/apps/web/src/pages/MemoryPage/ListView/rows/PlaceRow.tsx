import { type MouseEvent, type ReactNode } from 'react';

import { PlaceIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const PLACE_FRAGMENT = gql(`
  fragment TablePlaceRowData on PlaceType {
    id
    name
    description
  }
`);

interface Props {
  place: FragmentType<typeof PLACE_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PlaceRow({ place, time, onClick }: Props) {
  const data = useFragment(PLACE_FRAGMENT, place);

  return (
    <EntityRow
      icon={<PlaceIcon />}
      title={data.name}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
