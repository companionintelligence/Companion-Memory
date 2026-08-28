import { PRODUCT_FRAGMENT } from '@/components/entities/grid/ProductGridItem';
import { useFragment } from '@/graphql';
import { formatMinor } from '@/lib/money';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold } from './EntityDetailScaffold';

interface Props {
  entity: MemoryEntityOf<'ProductModelType'>;
}

/**
 * A catalog MODEL. Read-only: nothing in the GraphQL surface updates a product
 * from the client, and offering edit affordances the API would reject is worse
 * than offering none.
 */
export function ProductDetails({ entity }: Props) {
  const data = useFragment(PRODUCT_FRAGMENT, entity);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.productTitle || 'Product'}
      subtitle={data.isDigital ? 'Digital product' : 'Product'}
      taggable
      metaItems={[
        { label: 'Brand', value: data.brand },
        { label: 'Model number', value: data.modelNumber },
        { label: 'Category', value: data.category },
        { label: 'MSRP', value: formatMinor(data.msrpMinor, data.productCurrency) },
      ]}
      rawData={data}
    />
  );
}
