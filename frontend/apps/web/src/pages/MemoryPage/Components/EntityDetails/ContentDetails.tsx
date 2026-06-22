import { useMutation } from '@apollo/client';

import { CONTENT_FRAGMENT } from '@/components/entities/grid/ContentGridItem';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';

const UPDATE_CONTENT = gql(`
  mutation UpdateContentDetail($input: UpdateContentInput!) {
    updateContent(input: $input) {
      id
      title
      text
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'ContentType'>;
}

export function ContentDetails({ entity }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, entity);
  const [updateContent] = useMutation(UPDATE_CONTENT);

  const mediaSrc = data.mimetype?.startsWith('image/')
    ? resolveStaticUrl(data.contentUrl ?? data.sourceUrl)
    : undefined;

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.title || 'Content'}
      subtitle="Content"
      taggable
      media={<EntityMedia src={mediaSrc} contentType={data.mimetype} alt={data.title ?? ''} />}
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'text', label: 'Text', value: data.text ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateContent({
          variables: { input: { id: entity.id, title: values.title, text: values.text } },
        });
      }}
      metaItems={[{ label: 'Type', value: data.mimetype ?? 'Content' }]}
      rawData={data}
    />
  );
}
