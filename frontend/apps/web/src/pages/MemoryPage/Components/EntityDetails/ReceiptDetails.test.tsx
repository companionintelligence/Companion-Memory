import { Sheet } from '@ci/shadcn';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDrawerHostProvider, type EntityDrawerHost } from './drawerHost';
import { GET_RECEIPT_DOCUMENT, GET_RECEIPT_LINES, ReceiptDetails } from './ReceiptDetails';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints; the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const RECEIPT_ID = btoa('receipt:r-1');
const DOCUMENT_ID = btoa('content:c-1');
const MINTED_ITEM_ID = btoa('item:i-1');

const entity = {
  __typename: 'ReceiptType',
  id: RECEIPT_ID,
  merchantName: 'Hardware Barn',
  purchasedAt: '2026-03-04T18:20:00.000Z',
  totalMinor: 5413,
  receiptCurrency: 'USD',
  orderNumber: 'HB-99123',
  channel: 'IN_STORE',
  extractionState: 'EXTRACTED',
  lineItems: [{ __typename: 'ReceiptLineItemType', id: btoa('receipt-line-item:l-1') }],
  tags: [],
} as unknown as MemoryEntityOf<'ReceiptType'>;

const lines = (overrides: Record<string, unknown> = {}) => ({
  receipt: {
    __typename: 'ReceiptType' as const,
    id: RECEIPT_ID,
    currency: 'USD',
    documentContentId: DOCUMENT_ID,
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
      },
    ],
    ...overrides,
  },
});

const document = {
  content: {
    __typename: 'ContentType' as const,
    id: DOCUMENT_ID,
    title: 'receipt-hardware-barn.eml',
    mimetype: 'text/plain',
    url: null,
    mediaUrl: null,
    previewUrl: null,
    text: 'HARDWARE BARN\n1 Cordless drill 40.00',
  },
};

function renderDrawer(host: ReturnType<typeof newHost>, data: ReturnType<typeof lines> = lines()) {
  return renderWithProviders(
    <EntityDrawerHostProvider value={host}>
      <Sheet open>
        <ReceiptDetails entity={entity} />
      </Sheet>
    </EntityDrawerHostProvider>,
    {
      mocks: [
        mockQuery(GET_RECEIPT_LINES, { id: RECEIPT_ID }, data),
        mockQuery(GET_RECEIPT_DOCUMENT, { id: DOCUMENT_ID }, document),
      ],
    },
  );
}

const newHost = () => ({
  setActiveEntity: vi.fn<EntityDrawerHost['setActiveEntity']>(),
  refetch: vi.fn<EntityDrawerHost['refetch']>(),
});

describe('ReceiptDetails', () => {
  /**
   * Regression: the drawer used to omit the lines and the source document and
   * link to `/receipts/:id` for them. Losing that link means the drawer has to
   * carry the whole receipt, or the data becomes unreachable.
   */
  it('renders every extracted line, with its facts and its money', async () => {
    renderDrawer(newHost());

    expect(await screen.findByText('Cordless drill')).toBeInTheDocument();
    expect(screen.getByText('Makita · XPH · tools')).toBeInTheDocument();
    expect(screen.getByText('$40.00')).toBeInTheDocument();

    expect(screen.getByText('Extended warranty')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getByText('Not physical')).toBeInTheDocument();
  });

  it('renders the source document the lines were extracted from', async () => {
    renderDrawer(newHost());

    expect(await screen.findByText('receipt-hardware-barn.eml')).toBeInTheDocument();
    expect(screen.getByText(/HARDWARE BARN/)).toBeInTheDocument();
  });

  it('no longer offers a link out to the full receipt page', async () => {
    renderDrawer(newHost());

    await screen.findByText('Cordless drill');

    expect(screen.queryByRole('link', { name: 'Full receipt' })).not.toBeInTheDocument();
  });

  it('opens the thing a physical line minted in the same drawer, rather than navigating', async () => {
    const host = newHost();

    renderDrawer(host);

    fireEvent.click(await screen.findByRole('button', { name: 'Open thing' }));

    expect(host.setActiveEntity).toHaveBeenCalledWith({
      __typename: 'GenericEntity',
      // The raw graph id: `genericEntityGlobalId` re-encodes it on resolve.
      id: 'i-1',
      entityType: 'item',
    });
  });

  it('says so when the extraction produced no lines at all', async () => {
    renderDrawer(newHost(), lines({ lineItems: [], documentContentId: null }));

    expect(await screen.findByText('No line items were extracted.')).toBeInTheDocument();
  });
});
