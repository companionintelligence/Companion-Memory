import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, Portal, usePageTitle, EmptyState } from '@ci/common';
import { Breadcrumb, Card, Label, Textarea, Toggle, cn } from '@ci/shadcn';
import { Pencil, User } from '@ci/shadcn/icons';
import { useParams, Link } from 'react-router-dom';

import { useTagEntityService } from '@/api';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { CommunicationIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';
import { TagInput } from '@/components/TagInput';
import { gql } from '@/graphql';

const GET_COMMUNICATION = gql(`
  query GetCommunication($id: ID!) {
    communication(id: $id) {
      id
      type
      subject
      preview
      content

      from {
        id
        name
      }

      to {
        edges {
          node {
            id
            name
          }
        }
      }

      tags {
        id
        label
      }
    }
  }
`);

export function CommunicationPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_COMMUNICATION, {
    variables: {
      id: GlobalUID.encode('communication', id!),
    },
  });

  const { tagEntities, untagEntities } = useTagEntityService();

  const communication = data?.communication;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(
    communication?.subject
      ? `Communication - ${communication.subject || renderTypeSubject(communication.type)} - Companion Intelligence`
      : 'Communication - Companion Intelligence',
  );

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (communication == null) {
    content = (
      <EmptyState
        icon={<CommunicationIcon size={48} colorized={false} />}
        message="Communication not found"
      />
    );
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CommunicationIcon />
            {/* No subject (chat-style sources): the preview stands in as the
                heading rather than a synthesized "<Type>" subject. */}
            <h1 className="text-2xl font-bold">
              {communication.subject || communication.preview || renderTypeSubject(communication.type)}
            </h1>
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
            <Card className="h-full">
              <Card.Content className="whitespace-pre-wrap">{communication.content}</Card.Content>
            </Card>
          </div>

          <Card className="p-0 h-full">
            <Card.Content className="p-4 flex flex-col gap-6">
              {communication.from && (
                <div className="flex flex-col gap-2">
                  <Label>From</Label>
                  <Link to={`/people/${GlobalUID.parse('person', communication.from.id)}`}>
                    <Tag icon={<User />} className="text-sm" text={communication.from.name ?? ''} />
                  </Link>
                </div>
              )}

              {communication.to.edges.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Label>To</Label>
                  <div className="flex flex-wrap gap-2">
                    {communication.to.edges.map(({ node }) => (
                      <Link key={node.id} to={`/people/${GlobalUID.parse('person', node.id)}`}>
                        <Tag icon={<User />} className="text-sm cursor-pointer" text={node.name ?? ''} />
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="description">Summary</Label>
                <Textarea
                  key={communication.id}
                  id="preview"
                  defaultValue={communication.preview ?? ''}
                  readOnly={!editMode}
                  className={cn(
                    'resize-none min-h-[120px]',
                    editMode ? '' : 'shadow-none focus-visible:ring-0 focus-visible:border-border',
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label>Tags</Label>

                <TagInput
                  key={communication.id}
                  tags={communication.tags.map((t) => t.label) ?? []}
                  readOnly={!editMode}
                  onTagAdded={async (label) => {
                    try {
                      await tagEntities([GlobalUID.encode('communication', id!)], [label]);

                      return true;
                    } catch {
                      return false;
                    }
                  }}
                  onTagRemoved={async (label) => {
                    await untagEntities([GlobalUID.encode('communication', id!)], [label]);
                  }}
                />
              </div>
            </Card.Content>
          </Card>
        </div>

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
              <Breadcrumb.Page>Communication</Breadcrumb.Page>
            </Breadcrumb.Item>

            {communication && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>
                    {communication.subject || communication.preview || renderTypeSubject(communication.type)}
                  </Breadcrumb.Page>
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

function renderTypeSubject(type: string) {
  switch (type) {
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS Message';
    case 'call':
      return 'Phone Call';
    default:
      return 'Message';
  }
}
