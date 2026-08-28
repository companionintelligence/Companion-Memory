import { type MouseEvent } from 'react';

import { PersonAvatar } from '@/components/PersonAvatar';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const PERSON_FRAGMENT = gql(`
  fragment PersonGridItemData on PersonType {
    id
    name
    description
    avatarUrl
    firstName
    lastName
    birthDate
  }
`);

interface Props {
  person: FragmentType<typeof PERSON_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PersonGridItem({ person, onClick }: Props) {
  const data = useFragment(PERSON_FRAGMENT, person);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        {/* size="sm" is 32px — the exact h-8 w-8 this rendered before
            PersonAvatar existed, so this is a no-op for anyone who already
            has a photo. */}
        <PersonAvatar name={data.name} avatarUrl={data.avatarUrl} size="sm" />

        <div className="text-md font-semibold truncate">{data.name}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.description}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Person</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
