import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, Portal, usePageTitle, EmptyState } from '@ci/common';
import { Breadcrumb, Card, Label, Textarea, Toggle, cn } from '@ci/shadcn';
import { Pencil, User } from '@ci/shadcn/icons';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { useTagEntityService } from '@/api';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EventIcon, PlaceIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Map } from '@/components/Map';
import { Tag } from '@/components/Tag';
import { TagInput } from '@/components/TagInput';
import { gql } from '@/graphql';

const GET_EVENT = gql(`
  query GetEvent($id: ID!) {
    event(id: $id) {
      id
      title
      description

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

export function EventPage() {
  const { id } = useParams<{ id: string }>();

  const navigate = useNavigate();

  const { data, loading } = useQuery(GET_EVENT, {
    variables: {
      id: GlobalUID.encode('event', id!),
    },
  });

  const { tagEntities, untagEntities } = useTagEntityService();

  const event = data?.event;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(
    event?.title ? `Event - ${event.title} - Companion Intelligence` : 'Event - Companion Intelligence',
  );

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
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
            <Card className="p-0">
              <Card.Content className="p-4 flex flex-col gap-6">
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

                <div className="space-y-2">
                  <Label>Tags</Label>

                  <TagInput
                    key={event.id}
                    tags={event.tags.map((t) => t.label) ?? []}
                    readOnly={!editMode}
                    onTagAdded={async (label) => {
                      tagEntities([GlobalUID.encode('event', id!)], [label]);

                      return true;
                    }}
                    onTagRemoved={(label) => {
                      void untagEntities([GlobalUID.encode('event', id!)], [label]);
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    key={event.id}
                    id="description"
                    defaultValue={event.description ?? ''}
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
              <Breadcrumb.Page>Event</Breadcrumb.Page>
            </Breadcrumb.Item>

            {event && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{event.title}</Breadcrumb.Page>
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
