import { type MouseEvent } from 'react';

import { PersonIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const PERSON_FRAGMENT = gql(`
  fragment PersonGridItemData on PersonType {
    id
    name
    description
    avatarUrl
  }
`);

interface Props {
  person: FragmentType<typeof PERSON_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PersonGridItem({ person, onClick }: Props) {
  const data = useFragment(PERSON_FRAGMENT, person);

  const avatarUrl = data.avatarUrl
    ? /^https?:\/\//.test(data.avatarUrl)
      ? data.avatarUrl
      : `/static${data.avatarUrl}`
    : undefined;

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        {avatarUrl ? (
          <img src={avatarUrl} alt={data.name || ''} className="h-8 w-8 shrink-0 rounded-full object-cover" />
        ) : (
          <PersonIcon className="shrink-0" />
        )}

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
