import { PersonIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <PersonIcon />
        <div className="font-medium">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Person</div>
    </div>
  );
}
