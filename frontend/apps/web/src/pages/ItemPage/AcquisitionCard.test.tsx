import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import {
  AcquisitionCard,
  GET_ACQUISITION_PLACE,
  GET_ACQUISITION_RECEIPT,
  type AcquisitionLine,
} from './AcquisitionCard';

const RECEIPT_ID = btoa('receipt:r1');
const PLACE_ID = btoa('place:p1');

const makeLine = (overrides: Partial<AcquisitionLine> = {}): AcquisitionLine =>
  ({
    __typename: 'ReceiptLineItemType' as const,
    id: 'l1',
    receiptId: RECEIPT_ID,
    lineNumber: 3,
    description: 'Cordless drill',
    brand: 'Makita',
    modelNumber: 'XPH',
    quantity: 1,
    unitPriceMinor: 12999,
    totalPriceMinor: 12999,
    currency: 'EUR',
    isPhysical: true,
    ...overrides,
  }) as AcquisitionLine;

const receiptMock = (overrides: Record<string, unknown> = {}) =>
  mockQuery(
    GET_ACQUISITION_RECEIPT,
    { id: RECEIPT_ID },
    {
      receipt: {
        __typename: 'ReceiptType' as const,
        id: RECEIPT_ID,
        merchantName: 'Hornbach',
        merchantEntityId: null,
        placeEntityId: null,
        purchasedAt: '2026-05-01T00:00:00.000Z',
        orderNumber: 'A-77',
        channel: 'IN_STORE' as const,
        paymentMethod: 'VISA',
        paymentLast4: '4242',
        currency: 'EUR',
        totalMinor: 12999,
        ...overrides,
      },
    },
  );

describe('AcquisitionCard', () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  });

  it('renders nothing at all when the thing knows nothing about where it came from', () => {
    const { container } = renderWithProviders(<AcquisitionCard />);

    expect(container).toBeEmptyDOMElement();
  });

  it('formats the item price in the ITEM’s currency, not a hardcoded dollar', async () => {
    renderWithProviders(<AcquisitionCard purchasePrice={120} currency="EUR" />);

    const price = await screen.findByText(/120[.,]00/);

    expect(price).toHaveTextContent('€');
    expect(price).not.toHaveTextContent('$');
  });

  it('does not turn a JPY price into a fraction of a yen', async () => {
    renderWithProviders(<AcquisitionCard purchasePrice={12000} currency="JPY" />);

    // 12000 JPY, not 120.00 of anything.
    expect(await screen.findByText(/12[.,\u00a0\u202f]?000/)).toBeInTheDocument();
    expect(screen.queryByText(/120[.,]00\b/)).toBeNull();
  });

  it('falls back to dollars only when the thing carries no currency code', async () => {
    renderWithProviders(<AcquisitionCard purchasePrice={120} />);

    expect(await screen.findByText(/\$120[.,]00/)).toBeInTheDocument();
  });

  it('prefers the receipt line price (integer MINOR units) over the item price', async () => {
    renderWithProviders(<AcquisitionCard acquisition={makeLine()} purchasePrice={999} currency="USD" />, {
      mocks: [receiptMock()],
    });

    // 12999 minor EUR is €129.99 — not €12999, and not the item's $999.
    expect(await screen.findByText(/129[.,]99/)).toBeInTheDocument();
    expect(screen.queryByText(/\$999/)).toBeNull();
  });

  it('follows the receipt for the merchant, the day and the card it was paid with', async () => {
    renderWithProviders(<AcquisitionCard acquisition={makeLine()} />, { mocks: [receiptMock()] });

    expect(await screen.findByText('Hornbach')).toBeInTheDocument();
    expect(await screen.findByText('VISA •••• 4242')).toBeInTheDocument();
  });

  it('links to the receipt line that minted the thing, with its decoded id', async () => {
    renderWithProviders(<AcquisitionCard acquisition={makeLine()} />, { mocks: [receiptMock()] });

    const link = await screen.findByRole('link', { name: 'Line 3 — Cordless drill' });

    expect(link).toHaveAttribute('href', '/receipts/r1');
  });

  it('resolves the place the receipt points at, and links to it', async () => {
    renderWithProviders(<AcquisitionCard acquisition={makeLine()} />, {
      mocks: [
        receiptMock({ placeEntityId: PLACE_ID }),
        mockQuery(
          GET_ACQUISITION_PLACE,
          { id: PLACE_ID },
          { place: { __typename: 'PlaceType' as const, id: PLACE_ID, name: 'Hornbach Wandsbek' } },
        ),
      ],
    });

    const link = await screen.findByRole('link', { name: 'Hornbach Wandsbek' });

    expect(link).toHaveAttribute('href', '/places/p1');
  });

  it('prefers the receipt’s documentary date over the item’s estimated one', async () => {
    renderWithProviders(<AcquisitionCard acquisition={makeLine()} acquiredAt="2019-01-01T00:00:00.000Z" />, {
      mocks: [receiptMock()],
    });

    const receiptDate = new Date('2026-05-01T00:00:00.000Z').toLocaleDateString();
    const itemDate = new Date(2019, 0, 1).toLocaleDateString();

    expect(await screen.findByText(receiptDate)).toBeInTheDocument();
    expect(screen.queryByText(itemDate)).toBeNull();
  });

  it('uses the item’s own fields when there is no receipt line to follow', async () => {
    renderWithProviders(
      <AcquisitionCard
        acquiredFrom="A friend"
        acquisitionMethod="Gift"
        acquiredAt="2026-05-01T00:00:00.000Z"
      />,
    );

    expect(await screen.findByText('A friend')).toBeInTheDocument();
    expect(screen.getByText('Gift')).toBeInTheDocument();
  });

  it('shows a legacy UTC-midnight acquired date as the day it names, west of UTC', async () => {
    process.env.TZ = 'America/Los_Angeles';

    renderWithProviders(<AcquisitionCard acquiredFrom="A friend" acquiredAt="2024-03-02T00:00:00.000Z" />);

    expect(await screen.findByText(new Date(2024, 2, 2).toLocaleDateString())).toBeInTheDocument();
  });

  it('shows a quantity only when more than one unit came off the line', async () => {
    const { unmount } = renderWithProviders(<AcquisitionCard acquisition={makeLine()} />, {
      mocks: [receiptMock()],
    });

    expect(await screen.findByText('Hornbach')).toBeInTheDocument();
    expect(screen.queryByText('Quantity')).toBeNull();

    unmount();

    renderWithProviders(<AcquisitionCard acquisition={makeLine({ quantity: 3 })} />, {
      mocks: [receiptMock()],
    });

    expect(await screen.findByText('Quantity')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
