import { act, fireEvent, screen } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { GetReceiptsQuery, ReceiptExtractionState } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_RECEIPTS, PAGE_SIZE, ReceiptsPage } from './ReceiptsPage';

// The hub nav reads a provider the harness deliberately does not supply (see
// renderWithProviders); ThingsPage.test.tsx stubs it the same way.
vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children: React.ReactNode }) => children,
}));

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

type ReceiptNode = GetReceiptsQuery['receipts']['edges'][number]['node'];

const RECEIPT_ID = btoa('receipt:r1');
const SECOND_RECEIPT_ID = btoa('receipt:r2');

const BASE_VARIABLES: {
  merchantName: string | null;
  extractionState: ReceiptExtractionState | null;
  first: number;
} = {
  merchantName: null,
  extractionState: null,
  first: PAGE_SIZE,
};

const makeReceipt = (overrides: Partial<ReceiptNode> = {}): ReceiptNode =>
  ({
    __typename: 'ReceiptType' as const,
    id: RECEIPT_ID,
    merchantName: 'Hornbach',
    purchasedAt: '2026-05-01T00:00:00.000Z',
    totalMinor: 12999,
    currency: 'EUR',
    orderNumber: 'A-77',
    channel: 'IN_STORE' as const,
    extractionState: 'EXTRACTED' as const,
    lineItems: [{ __typename: 'ReceiptLineItemType' as const, id: 'l1' }],
    ...overrides,
  }) as ReceiptNode;

function pageInfoFor(overrides: { hasNextPage?: boolean; endCursor?: string | null } = {}) {
  return {
    __typename: 'PageInfo' as const,
    hasNextPage: overrides.hasNextPage ?? false,
    endCursor: overrides.endCursor ?? null,
  };
}

const receiptsResult = (
  nodes: ReceiptNode[],
  totalCount = nodes.length,
  overrides: { hasNextPage?: boolean } = {},
) => ({
  receipts: {
    __typename: 'ReceiptConnection' as const,
    totalCount,
    pageInfo: pageInfoFor({
      hasNextPage: overrides.hasNextPage ?? false,
      endCursor: overrides.hasNextPage ? (nodes.at(-1)?.id ?? null) : null,
    }),
    edges: nodes.map((node) => ({ __typename: 'ReceiptEdge' as const, cursor: node.id, node })),
  },
});

/**
 * `variables` may carry `after` for a `fetchMore` page; it isn't part of the
 * page's own filter state, so it's split out before merging onto BASE_VARIABLES
 * — the initial query never sends an `after` key at all, and the mock's
 * variables must match that exactly.
 */
const receiptsMock = (
  variables: Partial<typeof BASE_VARIABLES> & { after?: string },
  nodes: ReceiptNode[],
  totalCount?: number,
  opts: { hasNextPage?: boolean } = {},
) => {
  const { after, ...filters } = variables;

  return mockQuery(
    GET_RECEIPTS,
    { ...BASE_VARIABLES, ...filters, ...(after == null ? {} : { after }) },
    receiptsResult(nodes, totalCount, opts),
    { maxUsageCount: 3 },
  );
};

/**
 * Surfaces the live URL search params in the DOM so assertions can read the
 * state the page writes without reaching into router internals — same pattern
 * as ExplorerToolbar.test.tsx's ParamsProbe.
 */
function ParamsProbe() {
  const [params] = useSearchParams();

  return <div data-testid="params">{params.toString()}</div>;
}

/** See PlacesPage.test.tsx — stubs IntersectionObserver with a no-op that
 *  records callbacks so a test can fire them manually. */
function captureIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  const original = globalThis.IntersectionObserver;

  class CapturingObserver {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }

    observe() {}

    unobserve() {}

    disconnect() {}

    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;

  return {
    scrollSentinelIntoView: async () => {
      await act(async () => {
        for (const callback of callbacks) {
          callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
      });
    },
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}

describe('ReceiptsPage', () => {
  it('renders each receipt with its total in ITS OWN currency, not dollars', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [receiptsMock({}, [makeReceipt()], 7)],
    });

    expect(await screen.findByText('Hornbach')).toBeInTheDocument();
    expect(screen.getByText('7 receipts')).toBeInTheDocument();

    const total = screen.getByText(/129[.,]99/);

    expect(total).toHaveTextContent('€');
    expect(total).not.toHaveTextContent('$');
  });

  it('keeps the phone filters together and uses compact receipt rows', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [receiptsMock({}, [makeReceipt()], 7)],
    });

    expect(await screen.findByText('Hornbach')).toBeInTheDocument();

    const toolbar = screen.getByTestId('receipts-toolbar');
    expect(toolbar).toHaveClass('grid', 'grid-cols-[minmax(0,1fr)_9rem]', 'device:flex');
    expect(toolbar).toContainElement(screen.getByPlaceholderText('Search by merchant...'));
    expect(toolbar).toContainElement(screen.getByLabelText('Extraction state'));
    expect(toolbar).toContainElement(screen.getByText('7 receipts'));

    expect(screen.getByTestId('receipt-row')).toHaveClass('gap-2', 'p-2', 'device:gap-3', 'device:p-3');
  });

  it('counts a single line as "1 line" and several as "lines"', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [
        receiptsMock({}, [
          makeReceipt(),
          makeReceipt({
            id: btoa('receipt:r2'),
            merchantName: 'Bauhaus',
            lineItems: [
              { __typename: 'ReceiptLineItemType', id: 'l1' },
              { __typename: 'ReceiptLineItemType', id: 'l2' },
            ],
          } as Partial<ReceiptNode>),
        ]),
      ],
    });

    expect(await screen.findByText('1 line')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
  });

  it('flags a receipt whose extraction never finished, and leaves a finished one unflagged', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [
        receiptsMock({}, [
          makeReceipt(),
          makeReceipt({
            id: btoa('receipt:r2'),
            merchantName: 'Bauhaus',
            extractionState: 'NOT_APPLICABLE',
          } as Partial<ReceiptNode>),
        ]),
      ],
    });

    // Humanized, not the raw `NOT_APPLICABLE`.
    expect(await screen.findByText('Not applicable')).toBeInTheDocument();
    expect(screen.queryByText('Extracted')).toBeNull();
  });

  it('shows an em dash rather than a bare 0 when a receipt has no total', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [receiptsMock({}, [makeReceipt({ totalMinor: null } as Partial<ReceiptNode>)])],
    });

    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  it('sends the merchant filter to the server rather than filtering on the client', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [
        receiptsMock({}, [makeReceipt()]),
        // Trimmed, and null-not-empty-string is covered by BASE_VARIABLES.
        receiptsMock({ merchantName: 'bauhaus' }, [
          makeReceipt({ id: btoa('receipt:r2'), merchantName: 'Bauhaus' } as Partial<ReceiptNode>),
        ]),
      ],
    });

    fireEvent.change(await screen.findByPlaceholderText('Search by merchant...'), {
      target: { value: '  bauhaus  ' },
    });

    expect(await screen.findByText('Bauhaus')).toBeInTheDocument();
  });

  it('sends the extraction-state filter as the enum the resolver takes', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [
        receiptsMock({}, [makeReceipt()]),
        receiptsMock({ extractionState: 'FAILED' }, [
          makeReceipt({
            id: btoa('receipt:r3'),
            merchantName: 'Toom',
            extractionState: 'FAILED',
          } as Partial<ReceiptNode>),
        ]),
      ],
    });

    fireEvent.click(await screen.findByLabelText('Extraction state'));
    fireEvent.click(await screen.findByRole('option', { name: 'Failed' }));

    expect(await screen.findByText('Toom')).toBeInTheDocument();
  });

  it('opens a receipt at its decoded id', async () => {
    navigate.mockClear();

    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [receiptsMock({}, [makeReceipt()])],
    });

    fireEvent.click(await screen.findByText('Hornbach'));

    expect(navigate).toHaveBeenCalledWith('/receipts/r1');
  });

  it('shows an empty state instead of an empty list', async () => {
    renderWithProviders(<ReceiptsPage />, {
      route: '/memory/receipts',
      mocks: [receiptsMock({}, [], 0)],
    });

    expect(await screen.findByText('No receipts found')).toBeInTheDocument();
  });

  describe('search state lives in the URL', () => {
    it('reads the initial merchant filter from the ?q= param', async () => {
      renderWithProviders(<ReceiptsPage />, {
        route: '/memory/receipts?q=bauhaus',
        mocks: [
          receiptsMock({ merchantName: 'bauhaus' }, [
            makeReceipt({ merchantName: 'Bauhaus' } as Partial<ReceiptNode>),
          ]),
        ],
      });

      expect(await screen.findByText('Bauhaus')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search by merchant...')).toHaveValue('bauhaus');
    });

    it('writes what is typed into the ?q= param rather than local-only state', async () => {
      renderWithProviders(
        <>
          <ParamsProbe />
          <ReceiptsPage />
        </>,
        {
          route: '/memory/receipts',
          mocks: [
            receiptsMock({}, [makeReceipt()]),
            receiptsMock({ merchantName: 'bauhaus' }, [
              makeReceipt({ merchantName: 'Bauhaus' } as Partial<ReceiptNode>),
            ]),
          ],
        },
      );

      expect(await screen.findByText('Hornbach')).toBeInTheDocument();
      expect(screen.getByTestId('params').textContent).toBe('');

      fireEvent.change(screen.getByPlaceholderText('Search by merchant...'), {
        target: { value: 'bauhaus' },
      });

      expect(await screen.findByText('Bauhaus')).toBeInTheDocument();
      expect(screen.getByTestId('params').textContent).toBe('q=bauhaus');
    });
  });

  describe('error state', () => {
    /**
     * The error branch used to reuse the same confident EmptyState the genuine
     * "No receipts found" branch renders — a fetch failure read identically to
     * "you have none", with no way to retry. It must render the shared
     * ErrorState instead, with a Try again button that actually refetches.
     */
    it('shows the shared ErrorState with a working retry when the query fails, not a silent empty state', async () => {
      renderWithProviders(<ReceiptsPage />, {
        route: '/memory/receipts',
        mocks: [
          mockQuery(GET_RECEIPTS, BASE_VARIABLES, { error: new Error('receipts unavailable') }),
          // Consumed only after a successful retry re-renders the list.
          receiptsMock({}, [makeReceipt()]),
        ],
      });

      expect(await screen.findByText('Could not load receipts')).toBeInTheDocument();
      expect(
        screen.getByText('Your receipts are still here — this device could not reach them just now.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Couldn.t load receipts:/)).not.toBeInTheDocument();
      expect(screen.queryByText('No receipts found')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('Hornbach')).toBeInTheDocument();
    });
  });

  describe('pagination via useInfiniteConnection', () => {
    it('appends the next page when the sentinel scrolls into view', async () => {
      const observer = captureIntersectionObserver();

      try {
        renderWithProviders(<ReceiptsPage />, {
          route: '/memory/receipts',
          mocks: [
            receiptsMock({}, [makeReceipt()], 2, { hasNextPage: true }),
            receiptsMock(
              { after: RECEIPT_ID },
              [makeReceipt({ id: SECOND_RECEIPT_ID, merchantName: 'Bauhaus' } as Partial<ReceiptNode>)],
              2,
            ),
          ],
        });

        expect(await screen.findByText('Hornbach')).toBeInTheDocument();
        expect(screen.queryByText('Bauhaus')).not.toBeInTheDocument();

        await observer.scrollSentinelIntoView();

        expect(await screen.findByText('Bauhaus')).toBeInTheDocument();
        expect(screen.getByText('Hornbach')).toBeInTheDocument();
        expect(screen.getByText(/loaded/).textContent).toContain('2 of 2 loaded · end');
      } finally {
        observer.restore();
      }
    });
  });
});
