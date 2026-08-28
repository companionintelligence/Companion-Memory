import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatMinor } from '@/lib/money';

import { EntityGridItem } from './grid/EntityGridItem';
import { resolveMediaUrl } from './resolveMediaUrl';

/**
 * The catalog MODEL an owned thing is an instance of — the product, not the
 * object. Every unit of it shares the same GTIN and the same stock photo; only
 * the serial on the plate tells two of them apart.
 */
export const PRODUCT_MODEL_FRAGMENT = gql(`
  fragment ProductModelCardData on ProductModelType {
    id
    title
    brand
    manufacturer
    modelNumber
    category
    subcategory
    productType
    isDigital
    msrpMinor
    currency
    identityConfidence
    identifiers {
      namespace
      value
      rawValue
    }
    # The stock photo, already resolved to URLs by a DataLoader-backed
    # @ResolveField (ProductModelResolver.image) rather than the second
    # round-trip this card used to issue for itself.
    image {
      id
      previewUrl
      mediaUrl
      url
    }
  }
`);

interface Props {
  product: FragmentType<typeof PRODUCT_MODEL_FRAGMENT>;
  onClick?: () => void;
}

/** The one code a shopper recognises: the barcode, else the manufacturer part. */
function catalogCode(
  identifiers: readonly { namespace: string; value: string; rawValue?: string | null }[],
): { label: string; value: string } | null {
  const gtin = identifiers.find((identifier) => identifier.namespace === 'GTIN');

  if (gtin) {
    return { label: 'GTIN', value: gtin.rawValue?.trim() || gtin.value };
  }

  const mpn = identifiers.find((identifier) => identifier.namespace === 'MPN');

  if (mpn) {
    return { label: 'MPN', value: mpn.rawValue?.trim() || mpn.value };
  }

  return null;
}

export function ProductModelCard({ product, onClick }: Props) {
  const data = useFragment(PRODUCT_MODEL_FRAGMENT, product);

  const image = data.image;
  const imageUrl =
    resolveMediaUrl(image?.previewUrl) ?? resolveMediaUrl(image?.mediaUrl) ?? resolveMediaUrl(image?.url);

  const code = catalogCode(data.identifiers);
  const msrp = formatMinor(data.msrpMinor, data.currency);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <div className="min-w-0">
          <div className="truncate text-md font-semibold" title={data.title}>
            {data.title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[data.brand ?? data.manufacturer, data.modelNumber].filter(Boolean).join(' · ') ||
              'Catalog model'}
          </div>
        </div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        {imageUrl && (
          <div className="min-h-0 grow overflow-hidden rounded-sm bg-muted">
            <img src={imageUrl} alt={data.title} className="h-full w-full object-contain" />
          </div>
        )}

        <EntityGridItem.Meta>
          {code ? `${code.label} ${code.value}` : null}
          {msrp ? `MSRP ${msrp}` : null}
          {data.category ?? null}
          {/* A model derived from a receipt line or a vision guess is a WEAKER
              claim than one a human or a catalog asserted; say so rather than
              presenting both as equally real. */}
          {data.identityConfidence < 1 ? `${Math.round(data.identityConfidence * 100)}% confident` : null}
        </EntityGridItem.Meta>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">{data.isDigital ? 'Digital product' : 'Product'}</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
