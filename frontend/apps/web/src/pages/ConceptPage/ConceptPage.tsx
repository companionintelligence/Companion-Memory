import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, Portal, usePageTitle, EmptyState } from '@ci/common';
import { Breadcrumb, Card, Label, Textarea, Toggle, cn } from '@ci/shadcn';
import { Pencil } from '@ci/shadcn/icons';
import { useParams, Link } from 'react-router-dom';

import { useTagEntityService } from '@/api';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { ConceptIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { TagInput } from '@/components/TagInput';
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

export function ConceptPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_CONCEPT, {
    variables: {
      id: GlobalUID.encode('concept', id!),
    },
  });

  const { tagEntities, untagEntities } = useTagEntityService();

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
          <Toggle
            aria-label="Toggle edit mode"
            size="sm"
            variant="outline"
            className="data-[state=on]:bg-transparent data-[state=on]:*:[svg]:fill-blue-500 data-[state=on]:*:[svg]:stroke-blue-500"
            pressed={editMode}
            onPressedChange={setEditMode}
          >
            <Pencil />
          </Toggle>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <EntityGraph entityId={id!} />
          </div>

          <Card className="p-0">
            <Card.Content className="p-4 flex flex-col gap-6">
              <div className="space-y-2">
                <Label>Tags</Label>

                <TagInput
                  key={concept.id}
                  tags={concept.tags.map((tag) => tag.label) ?? []}
                  readOnly={!editMode}
                  onTagAdded={async (label) => {
                    try {
                      await tagEntities([GlobalUID.encode('concept', id!)], [label]);

                      return true;
                    } catch {
                      return false;
                    }
                  }}
                  onTagRemoved={async (label) => {
                    await untagEntities([GlobalUID.encode('concept', id!)], [label]);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  key={concept.id}
                  id="description"
                  defaultValue={concept.description ?? ''}
                  readOnly={!editMode}
                  className={cn(
                    'resize-none min-h-[120px]',
                    editMode ? '' : 'shadow-none focus-visible:ring-0 focus-visible:border-border',
                  )}
                />
              </div>
            </Card.Content>
          </Card>
        </div>

        <EntityRelationshipCards entityId={id!} />
        <EntityEvolutionPanel entityId={id!} />
      </PageContent>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            <Breadcrumb.Separator className="hidden md:block" />

            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Page>Concepts</Breadcrumb.Page>
            </Breadcrumb.Item>

            {concept && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />

                <Breadcrumb.Item>
                  <Breadcrumb.Page>{concept?.name || 'Unnamed'}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {content}
    </>
  );
}
