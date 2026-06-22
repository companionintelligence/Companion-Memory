import { type MouseEvent, useMemo } from 'react';

import { ItemIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const ITEM_FRAGMENT = gql(`
  fragment ItemGridItemData on ItemType {
    id
    name
    description
    category
    brand
    model
    currentValue
    file {
      id
      sourceUrl
    }
  }
`);

export interface ItemInventoryPreview {
  id: string;
  name: string;
  description: string | null;
  file: {
    sourceUrl: string;
  } | null;
}

interface Props {
  item: FragmentType<typeof ITEM_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onSelectInventoryItem?: (item: ItemInventoryPreview) => void;
}

export function ItemGridItem({ item, onClick, onSelectInventoryItem }: Props) {
  const data = useFragment(ITEM_FRAGMENT, item);

  const url = useMemo(() => {
    return data.file?.sourceUrl ? `/static${data.file.sourceUrl}` : undefined;
  }, [data.file?.sourceUrl]);

  return (
    <EntityGridItem
      onClick={(e) => {
        onSelectInventoryItem?.({
          id: data.id,
          name: data.name ?? '',
          description: data.description ?? null,
          file: data.file?.sourceUrl ? { sourceUrl: data.file.sourceUrl } : null,
        });
        onClick?.(e);
      }}
    >
      <EntityGridItem.Header>
        <ItemIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.name}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight min-h-0 shrink-0">{data.description}</div>

        {url && (
          <div className="rounded-sm overflow-hidden min-h-0 grow">
            <img
              src={url}
              alt={data.name ? `${data.name} image` : 'Item image'}
              className="object-cover w-full h-full"
            />
          </div>
        )}
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Item</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
