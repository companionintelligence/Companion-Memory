import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_RECEIPT, ReceiptPage } from './ReceiptPage';

// `ChatWithAgentMenu` reaches for the agent-harness hook context, which this
// page's providers do not supply — it threw during render and took the whole
// page down with it, so every assertion below failed on a page that never
// mounted. The menu is not what these tests are about.
vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

const RAW_ID = 'r-1';
// GlobalUID.encode('receipt', 'r-1') — the page encodes the route param itself.
const RECEIPT_ID = btoa('receipt:r-1');
const MINTED_ITEM_ID = btoa('item:i-1');

const makeReceipt = (overrides: Record<string, unknown> = {}) => ({
  receipt: {
    __typename: 'ReceiptType' as const,
    id: RECEIPT_ID,
    merchantName: 'Hardware Barn',
    merchantEntityId: null,
    placeEntityId: null,
    purchasedAt: '2026-03-04T18:20:00.000Z',
    orderNumber: 'HB-99123',
    channel: 'IN_STORE' as const,
    paymentMethod: 'Visa',
    paymentLast4: '4242',
    currency: 'USD',
    subtotalMinor: 5000,
    taxMinor: 413,
    tipMinor: null,
    shippingMinor: null,
    discountMinor: null,
    totalMinor: 5413,
    extractionState: 'EXTRACTED' as const,
    extractionModel: 'llama3.2-vision',
    extractionConfidence: 0.94,
    extractionError: null,
    documentContentId: null,
    sourceFileId: null,
    sourceSystem: 'gmail',
    sourceType: 'email',
    sourceMessageId: null,
    eventId: null,
    lineItems: [
      {
        __typename: 'ReceiptLineItemType' as const,
        id: btoa('receipt-line-item:l-1'),
        lineNumber: 1,
        description: 'Cordless drill',
        brand: 'Makita',
        modelNumber: 'XPH',
        category: 'tools',
        quantity: 1,
        unitPriceMinor: 4000,
        totalPriceMinor: 4000,
        currency: 'USD',
        isPhysical: true,
        mintedObjectId: MINTED_ITEM_ID,
        productId: null,
      },
      {
        __typename: 'ReceiptLineItemType' as const,
        id: btoa('receipt-line-item:l-2'),
        lineNumber: 2,
        description: 'Extended warranty',
        brand: null,
        modelNumber: null,
        category: null,
        quantity: 1,
        unitPriceMinor: 1000,
        totalPriceMinor: 1000,
        currency: 'USD',
        isPhysical: false,
        mintedObjectId: null,
        productId: null,
      },
    ],
    ...overrides,
  },
});

function renderPage(data: ReturnType<typeof makeReceipt> | { receipt: null }) {
  return renderWithProviders(<ReceiptPage />, {
    path: '/receipts/:id',
    route: `/receipts/${RAW_ID}`,
    mocks: [mockQuery(GET_RECEIPT, { id: RECEIPT_ID }, data)],
  });
}

describe('ReceiptPage', () => {
  it('renders the merchant, the totals breakdown and the payment', async () => {
    renderPage(makeReceipt());

    expect(await screen.findByRole('heading', { name: 'Hardware Barn' })).toBeInTheDocument();

    // Minor units are divided by the CURRENCY's own exponent, not a hardcoded 100.
    expect(screen.getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('$4.13')).toBeInTheDocument();
    expect(screen.getByText('$54.13')).toBeInTheDocument();

    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(screen.getByText('HB-99123')).toBeInTheDocument();
  });

  it('links a physical line to the thing it minted, and says why the others have none', async () => {
    renderPage(makeReceipt());

    const link = await screen.findByRole('link', { name: 'Open thing' });

    expect(link).toHaveAttribute('href', '/items/i-1');
    expect(screen.getByText('Not physical')).toBeInTheDocument();
  });

  it('flags a receipt whose extraction never finished instead of showing it as complete', async () => {
    renderPage(makeReceipt({ extractionState: 'PENDING', lineItems: [] }));

    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('No line items were extracted.')).toBeInTheDocument();
  });

  it('shows a not-found state rather than a blank page', async () => {
    renderPage({ receipt: null });

    expect(await screen.findByText('Receipt not found')).toBeInTheDocument();
  });
});
