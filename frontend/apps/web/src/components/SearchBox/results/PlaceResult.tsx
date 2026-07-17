import { PlaceIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { startFilterDrag } from '../filterDrag';

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
    <div
      draggable={Boolean(name)}
      onDragStart={(event) => startFilterDrag(event, 'place', name)}
      className="flex cursor-grab items-center justify-between gap-2 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <PlaceIcon />
        <div className="font-medium">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Place</div>
    </div>
  );
}
