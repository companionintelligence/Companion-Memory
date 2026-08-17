import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { Card, Label } from '@ci/shadcn';
import { User } from '@ci/shadcn/icons';
import { useParams, Link } from 'react-router-dom';

import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { CommunicationIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';
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
          <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <Card className="h-full">
              <Card.Content className="whitespace-pre-wrap">{communication.content}</Card.Content>
            </Card>
          </div>

          <EntityTagsDescriptionCard
            entityType="communication"
            entityId={id!}
            resetKey={communication.id}
            tags={communication.tags.map((t) => t.label)}
            description={communication.preview}
            descriptionLabel="Summary"
            editMode={editMode}
            className="h-full"
          >
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
          </EntityTagsDescriptionCard>
        </div>

        <EntityEvolutionPanel entityId={id!} entityName={communication.subject} />
      </PageContent>
    );
  }

  return <>{content}</>;
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
