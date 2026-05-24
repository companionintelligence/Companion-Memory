import { type MouseEvent } from 'react';

import { PersonIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const PERSON_FRAGMENT = gql(`
  fragment TablePersonRowData on PersonType {
    id
    name
    description
  }
`);

interface Props {
  person: FragmentType<typeof PERSON_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function PersonRow({ person, onClick }: Props) {
  const data = useFragment(PERSON_FRAGMENT, person);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <PersonIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.name}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.description}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
