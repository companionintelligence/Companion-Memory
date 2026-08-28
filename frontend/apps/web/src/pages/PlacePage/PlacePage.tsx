import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { Card, Label } from '@ci/shadcn';
import { useParams } from 'react-router-dom';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { PlaceIcon } from '@/components/icons';
import { InlineEditableField } from '@/components/InlineEditableField';
import { PageContent } from '@/components/layout';
import { Map } from '@/components/Map';
import { gql } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';

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

// Same write the memory drawer makes (UpdatePlaceDetail); each inline field
// sends one of these with only its own change.
const UPDATE_PLACE_FIELDS = gql(`
  mutation UpdatePlacePageFields($input: UpdatePlaceInput!) {
    updatePlace(input: $input) {
      id
      name
      description
      properties
    }
  }
`);

type PlaceProperties = {
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export function PlacePage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_PLACE, {
    variables: {
      id: GlobalUID.encode('place', id!),
    },
  });

  const [updatePlaceFields] = useMutation(UPDATE_PLACE_FIELDS);

  const place = data?.place;
  const [tagsEditMode, setTagsEditMode] = useState(false);
  const properties = (place?.properties ?? {}) as PlaceProperties;

  usePageTitle(place?.name ? `${place.name} - Companion Intelligence` : 'Place - Companion Intelligence');

  /**
   * Patch one field. `UpdatePlaceInput.name` is non-null, so an address- or
   * description-only edit has to resend the current name — a last-write-wins
   * update on the name as well, the same trade the memory drawer makes, and
   * nothing on this page polls to widen it. `properties` is likewise a whole
   * bag, so the address edit spreads the stored bag to keep the coordinates.
   */
  const patch = async (field: 'name' | 'address' | 'description', value: string) => {
    if (!place) {
      return;
    }

    const input =
      field === 'name'
        ? { id: place.id, name: value }
        : field === 'description'
          ? { id: place.id, name: place.name ?? '', description: value }
          : { id: place.id, name: place.name ?? '', properties: { ...properties, address: value } };

    const result = await updatePlaceFields({ variables: { input } });

    // updatePlace resolves to the place itself, or null when the write was rejected.
    if (!result.data?.updatePlace) {
      throw new Error('Update was rejected');
    }
  };

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (place == null) {
    content = <EmptyState icon={<PlaceIcon size={48} colorized={false} />} message="Place not found" />;
  } else {
    const hasCoordinates = properties.latitude != null && properties.longitude != null;

    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PlaceIcon />
            <h1 className="text-2xl font-bold">{place.name || 'Unnamed place'}</h1>
          </div>
          <ChatWithAgentMenu
            context={namedChatContext({
              title: place.name,
              body: place.description,
              sourceKind: 'PlaceType',
              sourceId: place.id,
            })}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-4 md:col-span-2">
            {/* Each field edits on its own — pencil, input, Save / Cancel — so
                correcting the address never touches the description. */}
            <Card className="p-0">
              <Card.Content className="flex flex-col gap-6 p-4">
                <InlineEditableField
                  label="Name"
                  value={place.name}
                  resetKey={place.id}
                  onSave={(value) => patch('name', value)}
                />
                <InlineEditableField
                  label="Address"
                  value={properties.address}
                  resetKey={place.id}
                  onSave={(value) => patch('address', value)}
                />
                <InlineEditableField
                  label="Description"
                  value={place.description}
                  resetKey={place.id}
                  multiline
                  onSave={(value) => patch('description', value)}
                />
                {hasCoordinates && (
                  <div className="space-y-1">
                    <Label>Where</Label>
                    <p className="text-sm">
                      {properties.latitude}, {properties.longitude}
                    </p>
                  </div>
                )}
              </Card.Content>
            </Card>

            <EntityTagsDescriptionCard
              entityType="place"
              entityId={id!}
              resetKey={place.id}
              tags={place.tags.map((t) => t.label)}
              description={place.description}
              hideDescription
              editMode={tagsEditMode}
            >
              <div className="flex items-center justify-end">
                <EntityEditToggle pressed={tagsEditMode} onPressedChange={setTagsEditMode} />
              </div>
            </EntityTagsDescriptionCard>
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
        <EntityEvolutionPanel entityId={id!} entityName={place.name} />
      </PageContent>
    );
  }

  return <>{content}</>;
}
