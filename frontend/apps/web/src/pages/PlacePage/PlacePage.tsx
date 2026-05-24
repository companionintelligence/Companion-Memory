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
import { PlaceIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Map } from '@/components/Map';
import { TagInput } from '@/components/TagInput';
import { gql } from '@/graphql';

const GET_PLACE = gql(`
  query GetPlace($id: ID!) {
    place(id: $id) {
      id
      name
      description
      properties
      tags {
        id
        label
      }
    }
  }
`);

export function PlacePage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_PLACE, {
    variables: {
      id: GlobalUID.encode('place', id!),
    },
  });

  const { tagEntities, untagEntities } = useTagEntityService();

  const place = data?.place;
  const [editMode, setEditMode] = useState(false);

  usePageTitle(place?.name ? `${place.name} - Companion Intelligence` : 'Place - Companion Intelligence');

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (place == null) {
    content = <EmptyState icon={<PlaceIcon size={48} colorized={false} />} message="Place not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PlaceIcon />
            <h1 className="text-2xl font-bold">{place.name}</h1>
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
            <Card className="p-0 h-full">
              <Card.Content className="p-4 flex flex-col gap-6 h-full">
                <div className="space-y-2">
                  <Label>Tags</Label>
                  <TagInput
                    key={place.id}
                    tags={place.tags.map((t) => t.label) ?? []}
                    readOnly={!editMode}
                    onTagAdded={async (label) => {
                      try {
                        await tagEntities([GlobalUID.encode('place', id!)], [label]);

                        return true;
                      } catch {
                        return false;
                      }
                    }}
                    onTagRemoved={async (label) => {
                      await untagEntities([GlobalUID.encode('place', id!)], [label]);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    key={place.id}
                    id="description"
                    defaultValue={place.description ?? ''}
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

          <div className="flex flex-col gap-4">
            {place.properties != null &&
              typeof place.properties.latitude === 'number' &&
              typeof place.properties.longitude === 'number' && (
                <Card className="p-0 overflow-hidden h-[300px]">
                  <Card.Content className="p-0 h-full w-full">
                    <Map
                      center={[place.properties.latitude, place.properties.longitude]}
                      zoomEnabled={false}
                      draggingEnabled={false}
                      zoom={15}
                    >
                      <Map.Marker position={[place.properties.latitude, place.properties.longitude]} />
                    </Map>
                  </Card.Content>
                </Card>
              )}

            <EntityGraph entityId={id!} />
          </div>
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
              <Breadcrumb.Page>Places</Breadcrumb.Page>
            </Breadcrumb.Item>

            {place && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />

                <Breadcrumb.Item>
                  <Breadcrumb.Page>{place?.name || 'Unnamed'}</Breadcrumb.Page>
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
