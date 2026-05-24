import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, Portal, usePageTitle, EmptyState } from '@ci/common';
import { Breadcrumb, Button, Card, Label, Textarea, Toggle, Tooltip, cn } from '@ci/shadcn';
import { Pencil, Link as LinkIcon } from '@ci/shadcn/icons';
import { useParams, Link } from 'react-router-dom';

import { useTagEntityService } from '@/api';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { PersonIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { AddRelationshipModal } from '@/components/modals/AddItemModal/AddRelationshipModal';
import { TagInput } from '@/components/TagInput';
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
const DEFAULT_HOP_DEPTH = 2;
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

export function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const [addRelationshipModalOpen, setAddRelationshipModalOpen] = useState(false);
  const [hopDepth, setHopDepth] = useState(DEFAULT_HOP_DEPTH);
  const [nodeLimit, setNodeLimit] = useState(DEFAULT_NODE_LIMIT);

  const { data, loading } = useQuery(GET_PERSON, {
    variables: {
      id: GlobalUID.encode('person', id!),
    },
  });

  const { tagEntities, untagEntities } = useTagEntityService();

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
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={hopDepth <= MIN_HOP_DEPTH}
                onClick={() => setHopDepth((prev) => Math.max(MIN_HOP_DEPTH, prev - 1))}
                aria-label="Decrease hop depth"
              >
                -
              </Button>
              <span className="w-5 text-center text-sm font-medium">{hopDepth}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={hopDepth >= MAX_HOP_DEPTH}
                onClick={() => setHopDepth((prev) => Math.min(MAX_HOP_DEPTH, prev + 1))}
                aria-label="Increase hop depth"
              >
                +
              </Button>
            </div>
            <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1">
              <span className="text-xs text-muted-foreground">Nodes</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={nodeLimit <= MIN_NODE_LIMIT}
                onClick={() => setNodeLimit((prev) => Math.max(MIN_NODE_LIMIT, prev - NODE_LIMIT_STEP))}
                aria-label="Decrease node limit"
              >
                -
              </Button>
              <span className="w-8 text-center text-sm font-medium">{nodeLimit}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                disabled={nodeLimit >= MAX_NODE_LIMIT}
                onClick={() => setNodeLimit((prev) => Math.min(MAX_NODE_LIMIT, prev + NODE_LIMIT_STEP))}
                aria-label="Increase node limit"
              >
                +
              </Button>
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
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <EntityGraph entityId={id!} maxDepth={hopDepth} nodeLimit={nodeLimit} />
          </div>

          <Card className="p-0">
            <Card.Content className="p-4 flex flex-col gap-6">
              <div className="space-y-2">
                <Label>Tags</Label>

                <TagInput
                  key={person.id}
                  tags={person.tags.map((t) => t.label) ?? []}
                  readOnly={!editMode}
                  onTagAdded={(label) => {
                    tagEntities([GlobalUID.encode('person', id!)], [label]);

                    return true;
                  }}
                  onTagRemoved={async (label) => {
                    await untagEntities([GlobalUID.encode('person', id!)], [label]);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  key={person.id}
                  id="description"
                  defaultValue={person.description ?? ''}
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
              <Breadcrumb.Page>People</Breadcrumb.Page>
            </Breadcrumb.Item>

            {person && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />

                <Breadcrumb.Item>
                  <Breadcrumb.Page>{person?.name || 'Unnamed'}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

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
