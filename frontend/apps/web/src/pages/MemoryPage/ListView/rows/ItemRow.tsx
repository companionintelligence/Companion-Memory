import { type MouseEvent, type ReactNode } from 'react';

import { ItemIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const ITEM_FRAGMENT = gql(`
  fragment TableItemRowData on ItemType {
    id
    name
    description
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
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onSelectInventoryItem?: (item: ItemInventoryPreview) => void;
}

export function ItemRow({ item, time, onClick, onSelectInventoryItem }: Props) {
  const data = useFragment(ITEM_FRAGMENT, item);

  return (
    <EntityRow
      icon={<ItemIcon />}
      title={data.name}
      subtitle={data.description}
      time={time}
      onClick={(e) => {
        onSelectInventoryItem?.({
          id: data.id,
          name: data.name ?? '',
          description: data.description ?? null,
          file: data.file?.sourceUrl ? { sourceUrl: data.file.sourceUrl } : null,
        });
        onClick?.(e);
      }}
    />
  );
}
