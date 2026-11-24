import { PlaceIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { startFilterDrag } from '../filterDrag';

import { SearchResultRow } from './SearchResultRow';

export const PLACE_FRAGMENT = gql(`
  fragment SearchResultPlaceData on PlaceType {
    id
    name
  }
`);

interface Props {
  place: FragmentType<typeof PLACE_FRAGMENT>;
}

export function PlaceResult({ place }: Props) {
  const data = useFragment(PLACE_FRAGMENT, place);
  const name = data.name ?? '';

  return (
    // Draggable onto the Memory explorer's filter drop area to add this place
    // as a where-filter; clicking still navigates to the place.
    <SearchResultRow
      draggable={Boolean(name)}
      onDragStart={(event) => startFilterDrag(event, 'place', name)}
      className="cursor-grab active:cursor-grabbing"
      icon={<PlaceIcon />}
      title={data.name}
      kind="Place"
    />
  );
}
