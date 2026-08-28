import { useMutation } from '@apollo/client';

import { ITEM_FRAGMENT } from '@/components/entities/grid/ItemGridItem';
import { gql, useFragment } from '@/graphql';
import { formatAmount } from '@/lib/money';
import { humanizeEnum } from '@/lib/utils';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';

function formatLastSeen(value?: string | Date | null): string | null {
  if (value == null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

/** The codes on the object, raw form first — that is what is printed on it. */
function formatIdentifiers(
  identifiers: readonly { namespace: string; value: string; rawValue?: string | null }[],
): string | null {
  if (identifiers.length === 0) {
    return null;
  }

  return identifiers
    .map((identifier) => `${identifier.namespace} ${identifier.rawValue?.trim() || identifier.value}`)
    .join(', ');
}

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
      title={data.name || 'Unnamed thing'}
      subtitle="Thing"
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
          // No currency symbol in the label: the amount is stored in the
          // thing's OWN currency, which is not necessarily the dollar the
          // hardcoded `($)` promised.
          label: 'Estimated value',
          value: data.currentValue != null ? String(data.currentValue) : '',
          inputType: 'number',
        },
      ]}
      onSave={async (values) => {
        // Clearing the field should null out the value, not persist $0. Guard
        // against unparseable input by treating it as cleared too.
        const trimmedValue = values.currentValue?.trim() ?? '';
        const parsedValue = trimmedValue === '' ? null : Number(trimmedValue);
        const currentValue = parsedValue == null || Number.isNaN(parsedValue) ? null : parsedValue;

        await updateItem({
          variables: {
            input: {
              id: entity.id,
              name: values.name || '',
              description: values.description,
              category: values.category,
              brand: values.brand,
              model: values.model,
              currentValue,
            },
          },
        });
      }}
      metaItems={[
        { label: 'Category', value: data.category },
        { label: 'Brand', value: data.product?.brand ?? data.brand },
        { label: 'Model', value: data.product?.title ?? data.model },
        { label: 'Value', value: formatAmount(data.currentValue, data.currency) },
        { label: 'Quantity', value: data.quantity > 1 ? String(data.quantity) : null },
        // A disposed/lent/lost thing keeps its row, so the drawer has to say
        // which — 'Active' is the boring case and is left off. Humanized, or the
        // drawer is the one surface still showing a raw `LENT_OUT`.
        {
          label: 'Status',
          value: data.lifecycleState !== 'ACTIVE' ? humanizeEnum(data.lifecycleState) : null,
        },
        { label: 'Last seen', value: formatLastSeen(data.lastSeenAt) },
        { label: 'Codes', value: formatIdentifiers(data.identifiers) },
      ]}
      rawData={data}
    />
  );
}
