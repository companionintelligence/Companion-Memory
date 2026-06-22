import { type MouseEvent, type ReactNode } from 'react';

import { PersonIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const PERSON_FRAGMENT = gql(`
  fragment TablePersonRowData on PersonType {
    id
    name
    description
  }
`);

interface Props {
  person: FragmentType<typeof PERSON_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PersonRow({ person, time, onClick }: Props) {
  const data = useFragment(PERSON_FRAGMENT, person);

  return (
    <EntityRow
      icon={<PersonIcon />}
      title={data.name}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
