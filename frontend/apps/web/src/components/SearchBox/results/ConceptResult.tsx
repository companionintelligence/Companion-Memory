import { ConceptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchResultRow } from './SearchResultRow';

export const CONCEPT_FRAGMENT = gql(`
  fragment SearchResultConceptData on ConceptType {
    id
    name
  }
`);

interface Props {
  concept: FragmentType<typeof CONCEPT_FRAGMENT>;
}

export function ConceptResult({ concept }: Props) {
  const data = useFragment(CONCEPT_FRAGMENT, concept);

  return <SearchResultRow icon={<ConceptIcon />} title={data.name} kind="Concept" />;
}
