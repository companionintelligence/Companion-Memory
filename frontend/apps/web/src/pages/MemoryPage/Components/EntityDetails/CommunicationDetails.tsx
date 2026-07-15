import { useMutation } from '@apollo/client';

import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';
import { COMMUNICATION_FRAGMENT } from '../EntityCard/CommunicationCard';

import { EntityDetailScaffold } from './EntityDetailScaffold';

const UPDATE_COMMUNICATION = gql(`
  mutation UpdateCommunicationDetail($input: UpdateCommunicationInput!) {
    updateCommunication(input: $input) {
      id
      subject
      preview
      communicationContent: content
    }
  }
`);

function capitalize(value?: string | null): string {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

interface Props {
  entity: MemoryEntityOf<'CommunicationType'>;
}

export function CommunicationDetails({ entity }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, entity);
  const [updateCommunication] = useMutation(UPDATE_COMMUNICATION);

  const headline = `${capitalize(data.direction)} ${capitalize(data.type)}`.trim();
  const recipients = (data.to?.edges ?? [])
    .map((edge) => edge.node.name)
    .filter((name): name is string => Boolean(name))
    .join(', ');

  // Chat-style sources have no subject: the preview becomes the title (its
  // only rendering) rather than showing a synthesized "Inbound Chat" headline;
  // the headline is a last resort for truly empty communications.
  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.subject || data.preview || headline || 'Communication'}
      subtitle={data.subject ? data.preview : undefined}
      taggable
      editFields={[
        { key: 'subject', label: 'Subject', value: data.subject ?? '' },
        { key: 'content', label: 'Content', value: data.communicationContent ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateCommunication({
          variables: { input: { id: entity.id, subject: values.subject, content: values.content } },
        });
      }}
      metaItems={[
        { label: 'Type', value: capitalize(data.type) },
        { label: 'Direction', value: capitalize(data.direction) },
        { label: 'When', value: data.time ? new Date(data.time).toLocaleString() : null },
        { label: 'From', value: data.from?.name },
        { label: 'To', value: recipients || null },
      ]}
      rawData={data}
    />
  );
}
