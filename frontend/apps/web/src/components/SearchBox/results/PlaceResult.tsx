import { PlaceIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <PlaceIcon />
        <div className="font-medium">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Place</div>
    </div>
  );
}
