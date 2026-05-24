import { type MouseEvent } from 'react';

import { ConceptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const CONCEPT_FRAGMENT = gql(`
  fragment TableConceptRowData on ConceptType {
    id
    name
    description
  }
`);

interface Props {
  concept: FragmentType<typeof CONCEPT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ConceptRow({ concept, onClick }: Props) {
  const data = useFragment(CONCEPT_FRAGMENT, concept);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <ConceptIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.name}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.description}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
