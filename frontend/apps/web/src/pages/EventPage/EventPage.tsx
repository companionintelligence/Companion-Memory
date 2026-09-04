import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { Card, Label } from '@ci/shadcn';
import { User } from '@ci/shadcn/icons';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityFieldsCard, formatEntityLabel, formatEntityTimestamp } from '@/components/EntityFields';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { ErrorState } from '@/components/ErrorState';
import { EventIcon, PlaceIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Map } from '@/components/Map';
import { Tag } from '@/components/Tag';
import { gql } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';
import {
  EntityMedia,
  resolveStaticUrl,
} from '@/pages/MemoryPage/Components/EntityDetails/EntityDetailScaffold';

import { EventContentGrid } from './EventContentGrid';

// Exported for the colocated test, which mocks it failing.
export const GET_EVENT = gql(`
  query GetEvent($id: ID!) {
    event(id: $id) {
      id
      title
      description

      # When it happened, what kind it was and where it came from. The page used
      # to select none of these, so /events/:id could not answer "when was this?".
      startTime
      endTime
      eventType
      sourceSystem

      # A photo/video event's own binary, resolved server-side from its linked
      # file (null for non-media events), plus the content rows attached to it.
      mediaContentType
      mediaUrl
      previewUrl
      contents(first: 60) {
        edges {
          node {
            id
            ...EventContentTile
          }
        }
      }

      tags {
        id
        label
      }

      location {
        id
        name
        properties
      }

      organizer {
        id
        name
      }

      participants {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`);

// Same write the memory drawer makes (UpdateEventDetail), so the page can edit
// the title as well as the description instead of the description alone.
const UPDATE_EVENT_FIELDS = gql(`
  mutation UpdateEventPageFields($input: UpdateEventInput!) {
    updateEvent(input: $input) {
      id
      title
      description
    }
  }
`);

export function EventPage() {
  const { id } = useParams<{ id: string }>();

  const navigate = useNavigate();

  const { data, loading, error, refetch } = useQuery(GET_EVENT, {
    variables: {
      id: GlobalUID.encode('event', id!),
    },
  });

  const [updateEventFields] = useMutation(UPDATE_EVENT_FIELDS);

  const event = data?.event;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(
    event?.title ? `Event - ${event.title} - Companion Intelligence` : 'Event - Companion Intelligence',
  );

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (error) {
    // A failed fetch is not an absent record. Dropping `error` sent a 500, a
    // dead connection or an expired session down the branch below, which told
    // the owner their own event does not exist.
    content = (
      <ErrorState
        title="Could not load this event"
        description="This event is still here — this device could not reach it just now."
        onRetry={() => void refetch()}
      />
    );
  } else if (event == null) {
    content = <EmptyState icon={<EventIcon size={48} colorized={false} />} message="Event not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <EventIcon />
            <h1 className="text-2xl font-bold">{event.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <ChatWithAgentMenu
              context={namedChatContext({
                title: event.title,
                body:
                  [event.description, event.eventType, event.sourceSystem].filter(Boolean).join(' · ') ||
                  null,
                sourceKind: 'EventType',
                sourceId: event.id,
              })}
            />
            <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-4 md:col-span-2">
            {/* The drawer's own field set + metadata rows, so reaching this route
                directly does not silently drop the title editor or the timestamps. */}
            <EntityFieldsCard
              title="Event"
              resetKey={event.id}
              editMode={editMode}
              onEditModeChange={setEditMode}
              fields={[{ key: 'title', label: 'Title', value: event.title ?? '' }]}
              metaItems={[
                { label: 'Starts', value: formatEntityTimestamp(event.startTime) },
                { label: 'Ends', value: formatEntityTimestamp(event.endTime) },
                { label: 'Type', value: formatEntityLabel(event.eventType) ?? 'Event' },
                { label: 'Source', value: formatEntityLabel(event.sourceSystem) },
              ]}
              onSave={async (values) => {
                const result = await updateEventFields({
                  variables: { input: { id: event.id, title: values.title } },
                });

                // updateEvent resolves to the event itself, or null when the write was rejected.
                if (!result.data?.updateEvent) {
                  throw new Error('Update was rejected');
                }
              }}
            >
              <EntityMedia
                src={resolveStaticUrl(event.mediaUrl ?? event.previewUrl)}
                previewSrc={resolveStaticUrl(event.previewUrl)}
                contentType={event.mediaContentType}
                alt={event.title ?? ''}
              />
            </EntityFieldsCard>

            <EventContentGrid contents={event.contents.edges.map((edge) => edge.node)} />

            <EntityTagsDescriptionCard
              entityType="event"
              entityId={id!}
              resetKey={event.id}
              tags={event.tags.map((t) => t.label)}
              description={event.description}
              editMode={editMode}
              onDescriptionSave={async (value) => {
                const result = await updateEventFields({
                  variables: { input: { id: event.id, description: value } },
                });

                // updateEvent resolves to the event itself, or null when the write was rejected.
                if (!result.data?.updateEvent) {
                  throw new Error('Update was rejected');
                }
              }}
            >
              {event.organizer && (
                <div className="flex flex-col gap-2">
                  <Label>Organizer</Label>
                  <Link to={`/people/${GlobalUID.parse('person', event.organizer.id)}`}>
                    <Tag icon={<User />} className="text-sm" text={event.organizer.name ?? ''} />
                  </Link>
                </div>
              )}

              {event.participants.edges.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Label>Participants</Label>
                  <div className="flex flex-wrap gap-2">
                    {event.participants.edges.map(({ node }) => (
                      <Link key={node.id} to={`/people/${GlobalUID.parse('person', node.id)}`}>
                        <Tag icon={<User />} className="text-sm cursor-pointer" text={node.name ?? ''} />
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {event.location && (
                <div className="flex flex-col gap-2">
                  <Label>Location</Label>
                  <Link to={`/places/${GlobalUID.parse('place', event.location.id)}`}>
                    <div className="flex gap-2 bg-secondary p-2 pr-5 rounded-full items-center cursor-pointer w-fit">
                      <PlaceIcon />
                      <div className="text-sm">{event.location?.name ?? ''}</div>
                    </div>
                  </Link>
                </div>
              )}
            </EntityTagsDescriptionCard>
          </div>

          {event.location != null &&
            typeof event.location.properties.latitude === 'number' &&
            typeof event.location.properties.longitude === 'number' && (
              <Card className="p-0 overflow-hidden">
                <Card.Content className="p-0 h-full w-full">
                  <Map
                    center={[event.location.properties.latitude, event.location.properties.longitude]}
                    zoomEnabled={false}
                    draggingEnabled={false}
                    zoom={15}
                  >
                    <Map.Marker
                      position={[event.location.properties.latitude, event.location.properties.longitude]}
                      onClick={() => navigate(`/places/${GlobalUID.parse('place', event.location!.id)}`)}
                    />
                  </Map>
                </Card.Content>
              </Card>
            )}
        </div>

        <EntityEvolutionPanel entityId={id!} entityName={event.title} />
      </PageContent>
    );
  }

  return <>{content}</>;
}
