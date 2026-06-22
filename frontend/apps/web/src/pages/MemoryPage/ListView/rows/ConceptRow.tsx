import { type MouseEvent, type ReactNode } from 'react';

import { ConceptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const CONCEPT_FRAGMENT = gql(`
  fragment TableConceptRowData on ConceptType {
    id
    name
    description
  }
`);

interface Props {
  concept: FragmentType<typeof CONCEPT_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ConceptRow({ concept, time, onClick }: Props) {
  const data = useFragment(CONCEPT_FRAGMENT, concept);

  return (
    <EntityRow
      icon={<ConceptIcon />}
      title={data.name}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
