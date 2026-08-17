import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { Button, IconButton, Tooltip } from '@ci/shadcn';
import { Link as LinkIcon } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';

import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { PersonIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { AddRelationshipModal } from '@/components/modals/AddItemModal/AddRelationshipModal';
import { gql } from '@/graphql';

const ALLOWED_TYPES = {
  communication: ['SENT', 'RECEIVED'],
  concept: ['PREFERS', 'DISLIKES', 'INTERESTED_IN'],
  content: ['CREATED'],
  event: ['PARTICIPATED_IN'],
  item: ['OWNS', 'CREATED'],
  note: ['CREATED'],
  person: [
    'KNOWS',
    'FRIENDS_WITH',
    'WORKS_WITH',
    'COLLABORATED_WITH',
    'MENTORED',
    'TAUGHT',
    'LEARNED_FROM',
    'SPOUSE',
    'PARENT_OF',
    'CHILD_OF',
    'SIBLING_OF',
    'FAMILY_MEMBER',
    'MET_WITH',
    'EMAILED',
    'RECEIVED_EMAIL_FROM',
    'ORGANIZED_EVENT_WITH',
    'EDITED_WITH',
    'IS',
    'LIVES_WITH',
    'ASSOCIATED_WITH',
  ],
  place: ['LIVES_IN', 'STUDIES_AT', 'WORKS_AT', 'LIVES_NEAR', 'VISITED', 'OWNS'],
  thread: ['CREATED'],
};
const MIN_HOP_DEPTH = 1;
const MAX_HOP_DEPTH = 5;
/**
 * One hop, so the graph on a person's page is that person's connections.
 *
 * Two hops looks richer and is actively misleading: the node budget is spent breadth-first, so a
 * person with a single relationship gets 1 node of their own and 23 belonging to whoever they are
 * connected to. The page then draws somebody else's network under this person's name. Every other
 * entity page already defaults to 1 (see `EntityGraph`); the "+" control still expands.
 */
const DEFAULT_HOP_DEPTH = 1;
const MIN_NODE_LIMIT = 10;
const MAX_NODE_LIMIT = 100;
const NODE_LIMIT_STEP = 5;
const DEFAULT_NODE_LIMIT = 25;

const GET_PERSON = gql(`
  query GetPerson($id: ID!) {
    person(id: $id) {
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

const UPDATE_PERSON_DESCRIPTION = gql(`
  mutation UpdatePersonDescription($input: UpdatePersonInput!) {
    updatePerson(input: $input) {
      success
      person {
        id
        description
      }
    }
  }
`);

export function PersonPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [addRelationshipModalOpen, setAddRelationshipModalOpen] = useState(false);
  const [hopDepth, setHopDepth] = useState(DEFAULT_HOP_DEPTH);
  const [nodeLimit, setNodeLimit] = useState(DEFAULT_NODE_LIMIT);

  const { data, loading } = useQuery(GET_PERSON, {
    variables: {
      id: GlobalUID.encode('person', id!),
    },
  });

  const [updatePersonDescription] = useMutation(UPDATE_PERSON_DESCRIPTION);

  const person = data?.person;
  const [editMode, setEditMode] = useState(false);

  usePageTitle(
    person?.name ? `Person - ${person.name} - Companion Intelligence` : 'Person - Companion Intelligence',
  );

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (person == null) {
    content = <EmptyState icon={<PersonIcon size={48} colorized={false} />} message="Person not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PersonIcon />
            <h1 className="text-2xl font-bold">{person.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1">
              <span className="text-xs text-muted-foreground">Hops</span>
              <IconButton
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={hopDepth <= MIN_HOP_DEPTH}
                onClick={() => setHopDepth((prev) => Math.max(MIN_HOP_DEPTH, prev - 1))}
                label={t('PERSON_GRAPH_FEWER_HOPS')}
              >
                -
              </IconButton>
              <span className="w-5 text-center text-sm font-medium">{hopDepth}</span>
              <IconButton
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={hopDepth >= MAX_HOP_DEPTH}
                onClick={() => setHopDepth((prev) => Math.min(MAX_HOP_DEPTH, prev + 1))}
                label={t('PERSON_GRAPH_MORE_HOPS')}
              >
                +
              </IconButton>
            </div>
            <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1">
              <span className="text-xs text-muted-foreground">Nodes</span>
              <IconButton
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={nodeLimit <= MIN_NODE_LIMIT}
                onClick={() => setNodeLimit((prev) => Math.max(MIN_NODE_LIMIT, prev - NODE_LIMIT_STEP))}
                label={t('PERSON_GRAPH_FEWER_NODES')}
              >
                -
              </IconButton>
              <span className="w-8 text-center text-sm font-medium">{nodeLimit}</span>
              <IconButton
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={nodeLimit >= MAX_NODE_LIMIT}
                onClick={() => setNodeLimit((prev) => Math.min(MAX_NODE_LIMIT, prev + NODE_LIMIT_STEP))}
                label={t('PERSON_GRAPH_MORE_NODES')}
              >
                +
              </IconButton>
            </div>
            <Tooltip>
              <Tooltip.Trigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAddRelationshipModalOpen(true)}
                  aria-label="Add relationship"
                >
                  <LinkIcon />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>Add relationship</Tooltip.Content>
            </Tooltip>
            <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <EntityGraph entityId={id!} maxDepth={hopDepth} nodeLimit={nodeLimit} />
          </div>

          <EntityTagsDescriptionCard
            entityType="person"
            entityId={id!}
            resetKey={person.id}
            tags={person.tags.map((t) => t.label)}
            description={person.description}
            editMode={editMode}
            onDescriptionSave={async (value) => {
              const result = await updatePersonDescription({
                variables: { input: { id: person.id, description: value } },
              });

              // The resolver reports a rejected write (wrong owner, missing row) in the payload
              // rather than throwing, so a silent no-op would otherwise look like a save.
              if (!result.data?.updatePerson.success) {
                throw new Error('Update was rejected');
              }
            }}
          />
        </div>

        <EntityRelationshipCards entityId={id!} />
        <EntityEvolutionPanel entityId={id!} entityName={person.name} />
      </PageContent>
    );
  }

  return (
    <>
      {content}

      {id && (
        <AddRelationshipModal
          allowedRelationshipTypes={ALLOWED_TYPES}
          entityType={'person'}
          entityId={id}
          open={addRelationshipModalOpen}
          onClose={() => setAddRelationshipModalOpen(false)}
        />
      )}
    </>
  );
}
