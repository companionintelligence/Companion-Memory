import { useMutation } from '@apollo/client';

import { PLACE_FRAGMENT } from '@/components/entities/grid/PlaceGridItem';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold } from './EntityDetailScaffold';

const UPDATE_PLACE = gql(`
  mutation UpdatePlaceDetail($input: UpdatePlaceInput!) {
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
  /**
   * The coordinate as the WRITERS spell it. Nothing writes `latitude`/
   * `longitude` into this bag: `PlaceService.upsert` writes `lat`/`lng`
   * (PlaceService.ts), and LifeScope-style rows carry `geolocation` as
   * [lng, lat]. This component used to read `properties.latitude`, which is
   * never set, so the Coordinates row was blank for every place — including
   * ones whose coordinate was known to full precision in `location_point`.
   *
   * The typed `latitude`/`longitude` on PlaceType are the right source: the
   * entity's @AfterLoad already resolves all three shapes into them
   * (PlaceEntity.loadPropertiesFromJsonb). These keys stay only as a last
   * resort for a row the resolver did not hydrate.
   */
  lat?: number | null;
  lng?: number | null;
};

interface Props {
  entity: MemoryEntityOf<'PlaceType'>;
}

export function PlaceDetails({ entity }: Props) {
  const data = useFragment(PLACE_FRAGMENT, entity);
  const [updatePlace] = useMutation(UPDATE_PLACE);

  const properties = (data.properties ?? {}) as PlaceProperties;
  const latitude = data.latitude ?? properties.lat ?? null;
  const longitude = data.longitude ?? properties.lng ?? null;
  const hasCoordinates = latitude != null && longitude != null;

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.name || 'Place'}
      subtitle="Place"
      taggable
      editFields={[
        { key: 'name', label: 'Name', value: data.name ?? '' },
        { key: 'description', label: 'Description', value: data.description ?? '', multiline: true },
        { key: 'address', label: 'Address', value: properties.address ?? '' },
      ]}
      onSave={async (values) => {
        await updatePlace({
          variables: {
            input: {
              id: entity.id,
              name: values.name,
              description: values.description,
              properties: { ...properties, address: values.address },
            },
          },
        });
      }}
      metaItems={[
        {
          label: 'Where',
          value: hasCoordinates ? `${latitude}, ${longitude}` : null,
        },
        { label: 'Type', value: 'Place' },
      ]}
      rawData={data}
    />
  );
}
