import { type MouseEvent } from 'react';

import { ConceptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const CONCEPT_FRAGMENT = gql(`
  fragment ConceptGridItemData on ConceptType {
    id
    name
    description
  }
`);

interface Props {
  concept: FragmentType<typeof CONCEPT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ConceptGridItem({ concept, onClick }: Props) {
  const data = useFragment(CONCEPT_FRAGMENT, concept);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ConceptIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.name}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.description}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Concept</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
