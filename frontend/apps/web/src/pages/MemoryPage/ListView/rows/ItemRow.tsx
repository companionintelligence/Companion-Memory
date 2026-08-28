import { type MouseEvent, type ReactNode } from 'react';

import { ItemIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { humanizeEnum } from '@/lib/utils';

import { EntityRow } from './EntityRow';

export const ITEM_FRAGMENT = gql(`
  fragment TableItemRowData on ItemType {
    id
    name
    description
    brand
    model
    lifecycleState
    lastSeenAt
    identifiers {
      namespace
      value
      rawValue
    }
    product {
      id
      title
      brand
    }
    file {
      id
      sourceUrl
    }
  }
`);

export interface ItemThingPreview {
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
  onSelectThing?: (item: ItemThingPreview) => void;
}

export function ItemRow({ item, time, onClick, onSelectThing }: Props) {
  const data = useFragment(ITEM_FRAGMENT, item);

  const primaryCode = data.identifiers[0];
  // The row has one subtitle line, so it goes to what identifies the object —
  // maker, code, whether it is still here — and falls back to the description
  // only when the thing knows none of that.
  const provenance =
    [
      [data.product?.brand ?? data.brand, data.product?.title ?? data.model].filter(Boolean).join(' '),
      primaryCode ? `${primaryCode.namespace} ${primaryCode.rawValue?.trim() || primaryCode.value}` : null,
      data.lifecycleState !== 'ACTIVE' ? humanizeEnum(data.lifecycleState) : null,
    ]
      .filter(Boolean)
      .join(' · ') || null;

  return (
    <EntityRow
      icon={<ItemIcon />}
      title={data.name}
      subtitle={provenance ?? data.description}
      time={time}
      onClick={(e) => {
        onSelectThing?.({
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
