import { useMutation } from '@apollo/client';

import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';
import { EVENT_FRAGMENT } from '../EntityCard/EventCard';

import { EntityDetailScaffold } from './EntityDetailScaffold';

const UPDATE_EVENT = gql(`
  mutation UpdateEventDetail($input: UpdateEventInput!) {
    updateEvent(input: $input) {
      id
      title
      description
    }
  }
`);

type LocationProperties = {
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

interface Props {
  entity: MemoryEntityOf<'EventType'>;
}

export function EventDetails({ entity }: Props) {
  const data = useFragment(EVENT_FRAGMENT, entity);
  const [updateEvent] = useMutation(UPDATE_EVENT);

  const props = (data.location?.properties ?? {}) as LocationProperties;
  const coordinates =
    props.latitude != null && props.longitude != null ? `${props.latitude}, ${props.longitude}` : null;
  const where = [data.location?.name, props.address, coordinates].filter(Boolean).join(' · ');

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.title || 'Event'}
      subtitle="Event"
      taggable
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'description', label: 'Description', value: data.description ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateEvent({
          variables: {
            input: { id: entity.id, title: values.title, description: values.description },
          },
        });
      }}
      metaItems={[
        { label: 'Source', value: data.sourceSystem },
        { label: 'Start', value: data.startTime ? new Date(data.startTime).toLocaleString() : null },
        { label: 'End', value: data.endTime ? new Date(data.endTime).toLocaleString() : null },
        { label: 'Where', value: where || null },
        { label: 'Type', value: 'Event' },
      ]}
      rawData={data}
    />
  );
}
