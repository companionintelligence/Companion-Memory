import { useMutation } from '@apollo/client';

import { ITEM_FRAGMENT } from '@/components/entities/grid/ItemGridItem';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';

// `updateItem` decodes the GlobalUID server-side, so pass the encoded id.
const UPDATE_ITEM = gql(`
  mutation UpdateItemDetail($input: UpdateItemInput!) {
    updateItem(input: $input) {
      success
      item {
        id
        name
        description
        category
        brand
        model
        currentValue
      }
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'ItemType'>;
}

export function ItemDetails({ entity }: Props) {
  const data = useFragment(ITEM_FRAGMENT, entity);
  const [updateItem] = useMutation(UPDATE_ITEM);

  const mediaSrc = resolveStaticUrl(data.file?.sourceUrl);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.name || 'Item'}
      subtitle="Item"
      taggable
      media={<EntityMedia src={mediaSrc} contentType="image/*" alt={data.name ?? ''} />}
      editFields={[
        { key: 'name', label: 'Name', value: data.name ?? '' },
        { key: 'description', label: 'Description', value: data.description ?? '', multiline: true },
        { key: 'category', label: 'Category', value: data.category ?? '' },
        { key: 'brand', label: 'Brand', value: data.brand ?? '' },
        { key: 'model', label: 'Model', value: data.model ?? '' },
        {
          key: 'currentValue',
          label: 'Estimated value ($)',
          value: data.currentValue != null ? String(data.currentValue) : '',
          inputType: 'number',
        },
      ]}
      onSave={async (values) => {
        await updateItem({
          variables: {
            input: {
              id: entity.id,
              name: values.name || '',
              description: values.description,
              category: values.category,
              brand: values.brand,
              model: values.model,
              currentValue: values.currentValue ? Number(values.currentValue) : 0,
            },
          },
        });
      }}
      metaItems={[
        { label: 'Category', value: data.category },
        { label: 'Brand', value: data.brand },
        { label: 'Model', value: data.model },
        { label: 'Value', value: data.currentValue != null ? `$${data.currentValue}` : null },
      ]}
      rawData={data}
    />
  );
}
