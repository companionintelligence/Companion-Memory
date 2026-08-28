import { type MouseEvent } from 'react';

import { ProductIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatMinor } from '@/lib/money';

import { EntityGridItem } from './EntityGridItem';

export const PRODUCT_FRAGMENT = gql(`
  fragment ProductGridItemData on ProductModelType {
    id
    # Aliased: ProductModelType.title is String! while ContentType, EventType,
    # FileType and NoteType all expose a NULLABLE title. All of them are spread
    # into the one explorer Search selection set, so sharing the response key
    # trips GraphQL's overlapping-fields rule.
    productTitle: title
    brand
    modelNumber
    category
    description
    isDigital
    msrpMinor
    # Aliased for the same overlapping-fields reason as the title above:
    # ItemType.currency is String! while this one is nullable String, and both
    # fragments are spread into the one explorer Search selection set. Response
    # keys that share a name must share a SHAPE, nullability included.
    productCurrency: currency
  }
`);

interface Props {
  product: FragmentType<typeof PRODUCT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ProductGridItem({ product, onClick }: Props) {
  const data = useFragment(PRODUCT_FRAGMENT, product);

  const msrp = formatMinor(data.msrpMinor, data.productCurrency);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ProductIcon className="shrink-0" />

        <div className="text-md truncate font-semibold">{data.productTitle}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="min-h-0 shrink-0 line-clamp-3 leading-tight">{data.description}</div>

        <EntityGridItem.Meta>
          {data.brand ?? null}
          {data.modelNumber ?? null}
          {msrp ?? null}
        </EntityGridItem.Meta>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">{data.isDigital ? 'Digital product' : 'Product'}</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
