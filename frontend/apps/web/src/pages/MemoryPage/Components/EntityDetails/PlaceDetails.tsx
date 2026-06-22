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
  latitude?: number | null;
  longitude?: number | null;
};

interface Props {
  entity: MemoryEntityOf<'PlaceType'>;
}

export function PlaceDetails({ entity }: Props) {
  const data = useFragment(PLACE_FRAGMENT, entity);
  const [updatePlace] = useMutation(UPDATE_PLACE);

  const properties = (data.properties ?? {}) as PlaceProperties;
  const hasCoordinates = properties.latitude != null && properties.longitude != null;

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
          value: hasCoordinates ? `${properties.latitude}, ${properties.longitude}` : null,
        },
        { label: 'Type', value: 'Place' },
      ]}
      rawData={data}
    />
  );
}
