import { PersonIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { startFilterDrag } from '../filterDrag';

export const PERSON_FRAGMENT = gql(`
  fragment SearchResultPersonData on PersonType {
    id
    name
    description
  }
`);

interface Props {
  person: FragmentType<typeof PERSON_FRAGMENT>;
}

export function PersonResult({ person }: Props) {
  const data = useFragment(PERSON_FRAGMENT, person);
  const name = data.name ?? '';

  return (
    // Draggable onto the Memory explorer's filter drop area to add this person
    // as a who-filter; clicking still navigates to the person.
    <div
      draggable={Boolean(name)}
      onDragStart={(event) => startFilterDrag(event, 'person', name)}
      className="flex cursor-grab items-center justify-between gap-2 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <PersonIcon />
        <div className="font-medium">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Person</div>
    </div>
  );
}
