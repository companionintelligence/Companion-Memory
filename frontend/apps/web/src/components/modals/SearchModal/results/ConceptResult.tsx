import { ConceptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <ConceptIcon />
        <div className="font-medium">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Concept</div>
    </div>
  );
}
