import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { useParams } from 'react-router-dom';

import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { ConceptIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

const GET_CONCEPT = gql(`
  query GetConcept($id: ID!) {
    concept(id: $id) {
      id
      name
      description
      tags {
        id
        label
      }
    }
  }
`);

const UPDATE_CONCEPT_DESCRIPTION = gql(`
  mutation UpdateConceptDescription($input: UpdateConceptInput!) {
    updateConcept(input: $input) {
      success
      concept {
        id
        description
      }
    }
  }
`);

export function ConceptPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_CONCEPT, {
    variables: {
      id: GlobalUID.encode('concept', id!),
    },
  });

  const [updateConceptDescription] = useMutation(UPDATE_CONCEPT_DESCRIPTION);

  const concept = data?.concept;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(
    concept?.name ? `Concept - ${concept.name} - Companion Intelligence` : 'Concept - Companion Intelligence',
  );

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (concept == null) {
    content = <EmptyState icon={<ConceptIcon size={48} colorized={false} />} message="Concept not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ConceptIcon />
            <h1 className="text-2xl font-bold">{concept.name}</h1>
          </div>
          <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <EntityGraph entityId={id!} />
          </div>

          <EntityTagsDescriptionCard
            entityType="concept"
            entityId={id!}
            resetKey={concept.id}
            tags={concept.tags.map((tag) => tag.label)}
            description={concept.description}
            editMode={editMode}
            onDescriptionSave={async (value) => {
              // UpdateConceptInput requires `name`, so a description-only edit has to resend it.
              // That makes this a last-write-wins update on the name as well: if it was renamed
              // elsewhere since this page loaded, the cached value here would win. Same trade the
              // existing MemoryPage detail editors make, and the page has no polling to widen it.
              // The `?? ''` only fires when the stored name is genuinely null — the query selects
              // `name`, so it is not a projection gap — and null and '' both render as 'Unnamed'.
              // Omitting the field instead is not an option: it is non-null on the input.
              const result = await updateConceptDescription({
                variables: { input: { id: concept.id, name: concept.name ?? '', description: value } },
              });

              if (!result.data?.updateConcept.success) {
                throw new Error('Update was rejected');
              }
            }}
          />
        </div>

        <EntityRelationshipCards entityId={id!} />
        <EntityEvolutionPanel entityId={id!} entityName={concept.name} />
      </PageContent>
    );
  }

  return <>{content}</>;
}
