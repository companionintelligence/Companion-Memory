import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { Label } from '@ci/shadcn';
import { User } from '@ci/shadcn/icons';
import { useParams, Link } from 'react-router-dom';

import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityFieldsCard, formatEntityLabel, formatEntityTimestamp } from '@/components/EntityFields';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { ErrorState } from '@/components/ErrorState';
import { CommunicationIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';
import { gql } from '@/graphql';

// Exported for the colocated test, which mocks it failing.
export const GET_COMMUNICATION = gql(`
  query GetCommunication($id: ID!) {
    communication(id: $id) {
      id
      type
      subject
      preview
      content

      # When it was sent, and which way it went. The page used to select
      # neither, so /communications/:id could not answer "when was this?".
      time
      direction

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

// Same write the memory drawer makes (UpdateCommunicationDetail). The page used
// to mount the edit pencil without one, so it could only ever edit tags.
const UPDATE_COMMUNICATION_FIELDS = gql(`
  mutation UpdateCommunicationPageFields($input: UpdateCommunicationInput!) {
    updateCommunication(input: $input) {
      id
      subject
      content
    }
  }
`);

export function CommunicationPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading, error, refetch } = useQuery(GET_COMMUNICATION, {
    variables: {
      id: GlobalUID.encode('communication', id!),
    },
  });

  const [updateCommunicationFields] = useMutation(UPDATE_COMMUNICATION_FIELDS);

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
  } else if (error) {
    // A failed fetch is not an absent record. Dropping `error` sent a 500, a
    // dead connection or an expired session down the branch below, which told
    // the owner their own communication does not exist.
    content = (
      <ErrorState
        title="Could not load this communication"
        description="This communication is still here — this device could not reach it just now."
        onRetry={() => void refetch()}
      />
    );
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
            {/* The drawer's field set + metadata rows, so reaching this route
                directly keeps the subject/content editor and shows the timestamp. */}
            <EntityFieldsCard
              className="h-full"
              title="Message"
              resetKey={communication.id}
              editMode={editMode}
              onEditModeChange={setEditMode}
              fields={[
                { key: 'subject', label: 'Subject', value: communication.subject ?? '' },
                { key: 'content', label: 'Content', value: communication.content ?? '', multiline: true },
              ]}
              metaItems={[
                { label: 'Type', value: formatEntityLabel(communication.type) },
                { label: 'Direction', value: formatEntityLabel(communication.direction) },
                { label: 'When', value: formatEntityTimestamp(communication.time) },
              ]}
              onSave={async (values) => {
                const result = await updateCommunicationFields({
                  variables: {
                    input: { id: communication.id, subject: values.subject, content: values.content },
                  },
                });

                // updateCommunication resolves to the row itself, or null when the write was rejected.
                if (!result.data?.updateCommunication) {
                  throw new Error('Update was rejected');
                }
              }}
            />
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
