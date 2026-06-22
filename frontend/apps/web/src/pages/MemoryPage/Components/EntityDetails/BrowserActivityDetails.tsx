import { useMutation } from '@apollo/client';

import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';
import { BROWSER_ACTIVITY_FRAGMENT } from '../EntityCard/BrowserActivityCard';

import { EntityDetailScaffold } from './EntityDetailScaffold';

const UPDATE_BROWSER_ACTIVITY = gql(`
  mutation UpdateBrowserActivityDetail($input: UpdateBrowserActivityInput!) {
    updateBrowserActivity(input: $input) {
      id
      title
      url
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'BrowserActivityType'>;
}

export function BrowserActivityDetails({ entity }: Props) {
  const data = useFragment(BROWSER_ACTIVITY_FRAGMENT, entity);
  const [updateBrowserActivity] = useMutation(UPDATE_BROWSER_ACTIVITY);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.title || 'Browser activity'}
      subtitle={data.actionType ?? undefined}
      taggable
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'url', label: 'URL', value: data.url ?? '', inputType: 'url' },
      ]}
      onSave={async (values) => {
        await updateBrowserActivity({
          variables: { input: { id: entity.id, title: values.title, url: values.url } },
        });
      }}
      metaItems={[
        { label: 'Action', value: data.actionType },
        { label: 'When', value: data.time ? new Date(data.time).toLocaleString() : null },
      ]}
      rawData={data}
    />
  );
}
