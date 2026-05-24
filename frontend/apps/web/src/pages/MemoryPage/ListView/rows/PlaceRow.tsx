import { type MouseEvent } from 'react';

import { PlaceIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const PLACE_FRAGMENT = gql(`
  fragment TablePlaceRowData on PlaceType {
    id
    name
    description
  }
`);

interface Props {
  place: FragmentType<typeof PLACE_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PlaceRow({ place, onClick }: Props) {
  const data = useFragment(PLACE_FRAGMENT, place);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <PlaceIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.name}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.description}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
