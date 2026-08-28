import { type MouseEvent, type ReactNode } from 'react';

import { ProductIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatMinor } from '@/lib/money';

import { EntityRow } from './EntityRow';

export const PRODUCT_FRAGMENT = gql(`
  fragment TableProductRowData on ProductModelType {
    id
    # Aliased for the same overlapping-fields reason as ProductGridItemData.
    productTitle: title
    brand
    modelNumber
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
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ProductRow({ product, time, onClick }: Props) {
  const data = useFragment(PRODUCT_FRAGMENT, product);

  const subtitle =
    [data.brand, data.modelNumber, formatMinor(data.msrpMinor, data.productCurrency)]
      .filter(Boolean)
      .join(' · ') || null;

  return (
    <EntityRow
      icon={<ProductIcon />}
      title={data.productTitle}
      subtitle={subtitle}
      time={time}
      onClick={onClick}
    />
  );
}
