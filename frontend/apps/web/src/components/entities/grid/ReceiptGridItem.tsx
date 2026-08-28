import { type MouseEvent } from 'react';

import { ReceiptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatMinor } from '@/lib/money';

import { EntityGridItem } from './EntityGridItem';

export const RECEIPT_FRAGMENT = gql(`
  fragment ReceiptGridItemData on ReceiptType {
    id
    merchantName
    purchasedAt
    totalMinor
    # Aliased for the overlapping-fields rule: ItemType.currency is String!
    # while this one is nullable String, and both fragments are spread into the
    # one explorer Search selection set. Response keys that share a name must
    # share a SHAPE, nullability included.
    receiptCurrency: currency
    orderNumber
    channel
    extractionState
    lineItems {
      id
    }
  }
`);

interface Props {
  receipt: FragmentType<typeof RECEIPT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ReceiptGridItem({ receipt, onClick }: Props) {
  const data = useFragment(RECEIPT_FRAGMENT, receipt);

  const total = formatMinor(data.totalMinor, data.receiptCurrency);
  const purchasedAt = data.purchasedAt ? new Date(data.purchasedAt).toLocaleDateString() : null;
  const lineCount = data.lineItems.length;

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ReceiptIcon className="shrink-0" />

        <div className="text-md truncate font-semibold">{data.merchantName || 'Unknown merchant'}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="text-2xl font-semibold tabular-nums">{total ?? '—'}</div>

        <EntityGridItem.Meta>
          {purchasedAt}
          {lineCount > 0 ? `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}` : null}
          {data.orderNumber ? `#${data.orderNumber}` : null}
        </EntityGridItem.Meta>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Receipt</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
