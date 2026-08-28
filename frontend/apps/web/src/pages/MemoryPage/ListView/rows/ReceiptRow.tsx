import { type MouseEvent, type ReactNode } from 'react';

import { ReceiptIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatMinor } from '@/lib/money';

import { EntityRow } from './EntityRow';

export const RECEIPT_FRAGMENT = gql(`
  fragment TableReceiptRowData on ReceiptType {
    id
    merchantName
    purchasedAt
    totalMinor
    # Aliased for the overlapping-fields rule: ItemType.currency is String!
    # while this one is nullable String, and both fragments are spread into the
    # one explorer Search selection set. Response keys that share a name must
    # share a SHAPE, nullability included.
    receiptCurrency: currency
    lineItems {
      id
    }
  }
`);

interface Props {
  receipt: FragmentType<typeof RECEIPT_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ReceiptRow({ receipt, time, onClick }: Props) {
  const data = useFragment(RECEIPT_FRAGMENT, receipt);

  const lineCount = data.lineItems.length;
  const subtitle =
    [
      formatMinor(data.totalMinor, data.receiptCurrency),
      lineCount > 0 ? `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null;

  return (
    <EntityRow
      icon={<ReceiptIcon />}
      title={data.merchantName || 'Unknown merchant'}
      subtitle={subtitle}
      time={time}
      onClick={onClick}
    />
  );
}
