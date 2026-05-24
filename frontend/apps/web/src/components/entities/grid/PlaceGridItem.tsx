import { type MouseEvent } from 'react';

import { PlaceIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const PLACE_FRAGMENT = gql(`
  fragment PlaceGridItemData on PlaceType {
    id
    name
    description
  }
`);

interface Props {
  place: FragmentType<typeof PLACE_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PlaceGridItem({ place, onClick }: Props) {
  const data = useFragment(PLACE_FRAGMENT, place);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <PlaceIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.name}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.description}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Place</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
