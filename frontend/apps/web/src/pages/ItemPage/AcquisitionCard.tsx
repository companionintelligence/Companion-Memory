import { type ReactNode } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Card } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { gql } from '@/graphql';
import type { GetItemQuery } from '@/graphql/graphql';
import { formatAmount, formatMinor } from '@/lib/money';

/**
 * The receipt line that minted this thing carries the price and the quantity,
 * but not WHO sold it or WHEN — those live on the receipt header, so the card
 * has to follow the `receiptId` to say anything useful.
 *
 * Exported, like the place query below, so tests mock the exact documents this
 * card sends rather than a re-declared copy that could drift from them.
 */
export const GET_ACQUISITION_RECEIPT = gql(`
  query GetAcquisitionReceipt($id: ID!) {
    receipt(id: $id) {
      id
      merchantName
      merchantEntityId
      placeEntityId
      purchasedAt
      orderNumber
      channel
      paymentMethod
      paymentLast4
      currency
      totalMinor
    }
  }
`);

export const GET_ACQUISITION_PLACE = gql(`
  query GetAcquisitionPlace($id: ID!) {
    place(id: $id) {
      id
      name
    }
  }
`);

/**
 * The receipt line `GetItem` selects, taken straight from the generated types.
 *
 * Hand-writing this shape mirrored ReceiptLineItemType by eye, so a nullability
 * change in the schema would have compiled here and blown up at runtime. Derived
 * from the QUERY rather than from `ReceiptLineItemType` itself, so it also stays
 * honest about which fields are actually selected.
 */
export type AcquisitionLine = NonNullable<NonNullable<GetItemQuery['item']>['acquisition']>;

function PlaceLine({ placeEntityId }: { placeEntityId: string }) {
  const { data } = useQuery(GET_ACQUISITION_PLACE, { variables: { id: placeEntityId } });

  return (
    <Link to={`/places/${GlobalUID.parse('place', placeEntityId)}`} className="hover:underline">
      {data?.place?.name || 'View place'}
    </Link>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

/**
 * Where this thing came from: the merchant, the place, the day, what it cost,
 * and the receipt that proves it.
 */
export function AcquisitionCard({
  acquisition,
  acquiredAt,
  acquiredFrom,
  acquisitionMethod,
  purchasePrice,
  currency,
}: {
  acquisition?: AcquisitionLine | null;
  acquiredAt?: string | Date | null;
  acquiredFrom?: string | null;
  acquisitionMethod?: string | null;
  purchasePrice?: number | null;
  /** ISO-4217 code for `purchasePrice`, which is a MAJOR-unit amount. */
  currency?: string | null;
}) {
  const { data } = useQuery(GET_ACQUISITION_RECEIPT, {
    variables: { id: acquisition?.receiptId ?? '' },
    skip: acquisition?.receiptId == null,
  });

  const receipt = data?.receipt;
  // Prefer the receipt's own date over the item's — the item's `acquiredAt` may
  // have been estimated by an importer, the receipt's is documentary.
  const rawDate = receipt?.purchasedAt ?? acquiredAt ?? null;
  const date = rawDate == null ? null : new Date(rawDate);
  const dateLabel = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : null;

  const linePrice = formatMinor(acquisition?.totalPriceMinor, acquisition?.currency);
  // The item's own price is a MAJOR-unit float in the item's own currency —
  // not dollars, which is what the `$${purchasePrice}` template it replaces
  // asserted for every EUR and JPY thing in the database.
  const price = linePrice ?? formatAmount(purchasePrice, currency);
  const merchant = receipt?.merchantName ?? acquiredFrom ?? null;

  const hasAnything =
    merchant != null ||
    dateLabel != null ||
    price != null ||
    acquisition != null ||
    acquisitionMethod != null;

  if (!hasAnything) {
    return null;
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Acquisition</Card.Title>
        <Card.Description>How this thing came to be yours.</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2">
        {merchant && <Row label="From">{merchant}</Row>}
        {receipt?.placeEntityId && (
          <Row label="Place">
            <PlaceLine placeEntityId={receipt.placeEntityId} />
          </Row>
        )}
        {dateLabel && <Row label="Date">{dateLabel}</Row>}
        {acquisitionMethod && <Row label="How">{acquisitionMethod}</Row>}
        {price && <Row label="Price">{price}</Row>}
        {acquisition && acquisition.quantity !== 1 && <Row label="Quantity">{acquisition.quantity}</Row>}
        {receipt?.paymentLast4 && (
          <Row label="Paid with">
            {[receipt.paymentMethod, `•••• ${receipt.paymentLast4}`].filter(Boolean).join(' ')}
          </Row>
        )}
        {acquisition && (
          <Row label="Receipt">
            <Link
              to={`/receipts/${GlobalUID.parse('receipt', acquisition.receiptId)}`}
              className="hover:underline"
            >
              {`Line ${acquisition.lineNumber} — ${acquisition.description}`}
            </Link>
          </Row>
        )}
      </Card.Content>
    </Card>
  );
}
