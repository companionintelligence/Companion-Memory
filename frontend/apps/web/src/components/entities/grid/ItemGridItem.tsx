import { type MouseEvent, useMemo } from 'react';

import { ItemIcon } from '@/components/icons';
import { PendingImage } from '@/components/PendingImage';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatAmount } from '@/lib/money';
import { humanizeEnum } from '@/lib/utils';

import { resolveMediaUrl } from '../resolveMediaUrl';

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
    currency
    quantity
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
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onSelectThing?: (item: ItemThingPreview) => void;
}

export function ItemGridItem({ item, onClick, onSelectThing }: Props) {
  const data = useFragment(ITEM_FRAGMENT, item);

  const url = useMemo(() => resolveMediaUrl(data.file?.sourceUrl), [data.file?.sourceUrl]);

  // What a person recognises the thing by, after its name: who made it, and the
  // one code that would let them find it again.
  const provenance = [data.product?.brand ?? data.brand, data.product?.title ?? data.model]
    .filter(Boolean)
    .join(' · ');
  const primaryCode = data.identifiers[0];
  const lastSeen = data.lastSeenAt ? new Date(data.lastSeenAt) : null;
  const lastSeenLabel =
    lastSeen && !Number.isNaN(lastSeen.getTime()) ? `Seen ${lastSeen.toLocaleDateString()}` : null;
  // The fragment has always fetched `currentValue` and `currency` and the card
  // has never shown either — a query paying for a column nobody renders. What a
  // thing is worth is one of the three facts a person scanning a grid of
  // possessions is actually looking for, so it is rendered rather than dropped.
  const value = formatAmount(data.currentValue, data.currency);

  return (
    <EntityGridItem
      onClick={(e) => {
        onSelectThing?.({
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
            <PendingImage src={url} />
          </div>
        )}

        <EntityGridItem.Meta>
          {provenance || null}
          {primaryCode
            ? `${primaryCode.namespace} ${primaryCode.rawValue?.trim() || primaryCode.value}`
            : null}
          {lastSeenLabel}
        </EntityGridItem.Meta>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end gap-2">
        {value && <span className="text-sm tabular-nums text-muted-foreground">{value}</span>}
        {/* Six of something is a different fact from one of it, and the count is
            the only field on the card that the grid cannot show twice: two rows
            of "AA battery" mean two ROWS, not two batteries. Only shown above
            one — "×1" is the boring case and every thing has it. */}
        {data.quantity > 1 && (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {`×${data.quantity}`}
          </span>
        )}
        {/* An owned thing that is gone (lost, lent, disposed) is still a thing
            that happened — it keeps its row, so the card has to SAY so rather
            than looking identical to something on the shelf. */}
        {data.lifecycleState !== 'ACTIVE' && (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {humanizeEnum(data.lifecycleState)}
          </span>
        )}
        <div className="text-sm text-muted-foreground">Thing</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
