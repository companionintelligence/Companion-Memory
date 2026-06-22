import { useMutation } from '@apollo/client';

import { CONCEPT_FRAGMENT } from '@/components/entities/grid/ConceptGridItem';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold } from './EntityDetailScaffold';

const UPDATE_CONCEPT = gql(`
  mutation UpdateConceptDetail($input: UpdateConceptInput!) {
    updateConcept(input: $input) {
      success
      concept {
        id
        name
        description
      }
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'ConceptType'>;
}

export function ConceptDetails({ entity }: Props) {
  const data = useFragment(CONCEPT_FRAGMENT, entity);
  const [updateConcept] = useMutation(UPDATE_CONCEPT);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.name || 'Concept'}
      subtitle="Concept"
      taggable
      editFields={[
        { key: 'name', label: 'Name', value: data.name ?? '' },
        { key: 'description', label: 'Description', value: data.description ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateConcept({
          variables: {
            input: { id: entity.id, name: values.name, description: values.description },
          },
        });
      }}
      rawData={data}
    />
  );
}
