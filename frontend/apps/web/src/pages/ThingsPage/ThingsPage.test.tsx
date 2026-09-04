import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GetItemDuplicatesQuery } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import {
  GET_ITEM_DUPLICATES,
  GET_THINGS,
  MERGE_ITEMS,
  PAGE_SIZE,
  REJECT_ITEM_DUPLICATES,
  ThingsPage,
} from './ThingsPage';

// The hub nav reads a provider the harness deliberately does not supply (see
// renderWithProviders); PeoplePage.test.tsx stubs it the same way.
vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children: React.ReactNode }) => children,
}));

// The review tab does its own querying and opens a Radix dialog; it has its own
// surface and is not what these tests are about.
vi.mock('./ObservationReview', () => ({
  ObservationReview: () => <div>observation review</div>,
}));

const THING_A = btoa('item:a');
const THING_B = btoa('item:b');

/** Renders `pathname + search` so a test can assert what the router URL holds. */
/** See PeoplePage.test.tsx / PlacesPage.test.tsx — stubs IntersectionObserver with a no-op. */
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

const BASE_VARIABLES = {
  query: null,
  category: null,
  brand: null,
  condition: null,
  lifecycleState: null,
  hasIdentifier: null,
  sort: 'RECENTLY_SEEN' as const,
  first: PAGE_SIZE,
};

const makeThing = (id: string, name: string) => ({
  __typename: 'ItemType' as const,
  id,
  name,
  description: 'Cordless 18V',
  category: 'tools',
  brand: 'Makita',
  model: 'XPH',
  currentValue: 120,
  // Non-null on the schema — omitting it left the cache's diff of this node
  // permanently "incomplete", which triggered a background refetch of the
  // base (no `after`) page every time a fetchMore response landed and
  // silently clobbered the just-merged accumulated list.
  currency: 'USD',
  quantity: 1,
  lifecycleState: 'ACTIVE' as const,
  lastSeenAt: '2026-05-01T00:00:00.000Z',
  identifiers: [
    {
      __typename: 'ObjectIdentifierType' as const,
      namespace: 'GTIN' as const,
      value: '0012345678905',
      rawValue: '012345678905',
    },
  ],
  product: null,
  file: null,
});

const makeThingsResult = (
  nodes: ReturnType<typeof makeThing>[],
  totalCount = nodes.length,
  pageInfoOverrides: { hasNextPage?: boolean; endCursor?: string | null } = {},
) => ({
  items: {
    __typename: 'ItemConnection' as const,
    totalCount,
    pageInfo: {
      __typename: 'PageInfo' as const,
      hasNextPage: pageInfoOverrides.hasNextPage ?? false,
      endCursor: pageInfoOverrides.endCursor ?? null,
    },
    edges: nodes.map((node) => ({
      __typename: 'ItemEdge' as const,
      cursor: node.id,
      node,
    })),
  },
});

const NO_DUPLICATES: GetItemDuplicatesQuery = {
  itemDuplicates: {
    __typename: 'ItemDuplicatesPayload' as const,
    totalCount: 0,
    hasMore: false,
    groups: [],
  },
};

const DUPLICATE_GROUP: GetItemDuplicatesQuery = {
  itemDuplicates: {
    __typename: 'ItemDuplicatesPayload' as const,
    totalCount: 1,
    hasMore: false,
    groups: [
      {
        __typename: 'ItemDuplicateGroupType' as const,
        reason: 'IDENTIFIER' as const,
        value: '0012345678905',
        totalItems: 2,
        items: [
          {
            __typename: 'ItemType' as const,
            id: THING_A,
            name: 'Drill',
            brand: 'Makita',
            model: 'XPH',
            category: 'tools',
            quantity: 1,
            lifecycleState: 'ACTIVE' as const,
          },
          {
            __typename: 'ItemType' as const,
            id: THING_B,
            name: 'Makita drill',
            brand: 'Makita',
            model: 'XPH',
            category: 'tools',
            quantity: 1,
            lifecycleState: 'ACTIVE' as const,
          },
        ],
      },
    ],
  },
};

const duplicatesMock = (result: GetItemDuplicatesQuery, maxUsageCount = 3) =>
  mockQuery(GET_ITEM_DUPLICATES, { limit: 20, offset: 0 }, result, { maxUsageCount });

describe('ThingsPage', () => {
  it('renders the search box, the total count and the things themselves', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')], 42), {
          maxUsageCount: 3,
        }),
        duplicatesMock(NO_DUPLICATES),
      ],
    });

    expect(await screen.findByText('42 things')).toBeInTheDocument();
    expect(await screen.findByText('Drill')).toBeInTheDocument();
  });

  /**
   * Search text is the header search box's `?search=` param (the page has no
   * input of its own), so a deep link runs that search on mount.
   */
  it('runs the search from a ?search= deep link', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things?search=lamp',
      mocks: [
        mockQuery(
          GET_THINGS,
          { ...BASE_VARIABLES, query: 'lamp' },
          makeThingsResult([makeThing(THING_B, 'Desk lamp')]),
          { maxUsageCount: 3 },
        ),
        duplicatesMock(NO_DUPLICATES),
      ],
    });

    expect(await screen.findByText('Desk lamp')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Search things/)).not.toBeInTheDocument();
  });

  it('sends the code filter as the tri-state Boolean the resolver takes', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 3,
        }),
        // `false` is a real filter (things carrying no code at all), not "off".
        mockQuery(
          GET_THINGS,
          { ...BASE_VARIABLES, hasIdentifier: false },
          makeThingsResult([makeThing(THING_B, 'Uncoded lamp')]),
          { maxUsageCount: 3 },
        ),
        duplicatesMock(NO_DUPLICATES, 5),
      ],
    });

    fireEvent.click(await screen.findByLabelText('Codes'));
    fireEvent.click(await screen.findByRole('option', { name: 'No code' }));

    expect(await screen.findByText('Uncoded lamp')).toBeInTheDocument();
  });

  it('sends hasIdentifier: true for "Has a code"', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 3,
        }),
        mockQuery(
          GET_THINGS,
          { ...BASE_VARIABLES, hasIdentifier: true },
          makeThingsResult([makeThing(THING_B, 'Barcoded drill')]),
          { maxUsageCount: 3 },
        ),
        duplicatesMock(NO_DUPLICATES, 5),
      ],
    });

    fireEvent.click(await screen.findByLabelText('Codes'));
    fireEvent.click(await screen.findByRole('option', { name: 'Has a code' }));

    expect(await screen.findByText('Barcoded drill')).toBeInTheDocument();
  });

  it('shows an empty state instead of an empty grid when nothing matches', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([], 0), { maxUsageCount: 3 }),
        duplicatesMock(NO_DUPLICATES),
      ],
    });

    expect(await screen.findByText('No things found')).toBeInTheDocument();
  });

  /**
   * The error branch used to reuse the same confident EmptyState the genuine
   * "No things found" branch renders — a fetch failure read identically to
   * "you have none", with no way to retry. It must render the shared
   * ErrorState instead, with a Try again button that actually refetches.
   */
  it('shows the shared ErrorState with a working retry when the query fails, not a silent empty state', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        { request: { query: GET_THINGS, variables: BASE_VARIABLES }, error: new Error('network down') },
        duplicatesMock(NO_DUPLICATES),
        // Consumed only after a successful retry remounts the rest of the page.
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 3,
        }),
      ],
    });

    expect(await screen.findByText('Could not load things')).toBeInTheDocument();
    expect(
      screen.getByText('Your things are still here — this device could not reach them just now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load things:/)).not.toBeInTheDocument();
    expect(screen.queryByText('No things found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Drill')).toBeInTheDocument();
  });

  it('offers the duplicate group for review, with the shared code that produced it', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 3,
        }),
        duplicatesMock(DUPLICATE_GROUP),
      ],
    });

    expect(await screen.findByText('Possible duplicates')).toBeInTheDocument();
    expect(screen.getByText(/Same code/)).toBeInTheDocument();
    expect(screen.getAllByText('0012345678905').length).toBeGreaterThan(0);
    expect(screen.getByText('Makita drill')).toBeInTheDocument();
  });

  it('merges a duplicate group only after the confirm dialog is accepted', async () => {
    const mergeResult = {
      mergeItems: {
        __typename: 'MergeItemsPayload' as const,
        success: true,
        item: { __typename: 'ItemType' as const, id: THING_A, name: 'Drill' },
        counts: {
          __typename: 'ObjectMergeCountsType' as const,
          identifiers: 1,
          observations: 0,
          receiptLineItems: 0,
        },
      },
    };

    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 5,
        }),
        duplicatesMock(DUPLICATE_GROUP, 5),
        mockQuery(MERGE_ITEMS, { input: { targetId: THING_A, sourceIds: [THING_B] } }, mergeResult),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Merge into one thing' }));

    // The dialog is the gate: nothing is written until its Action is clicked.
    const dialog = await screen.findByRole('alertdialog');

    expect(dialog).toHaveTextContent('Merge into one thing?');

    const confirm = within(dialog).getByRole('button', { name: 'Merge into one thing' });

    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  // The other half of the decision. `itemDuplicates` is recomputed on every
  // request, so a decline that is not written to `ci.entity_merge_blocks` shows
  // the identical group again on the next load — which is exactly what the page
  // did before this mutation existed.
  it('records a declined duplicate group, with no confirm dialog in the way', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 5,
        }),
        duplicatesMock(DUPLICATE_GROUP, 5),
        // The mock matches on VARIABLES, so this is also the assertion that the
        // whole group is sent: a call with anything other than both ids finds no
        // mock, and the card renders the resulting error instead.
        mockQuery(
          REJECT_ITEM_DUPLICATES,
          { itemIds: [THING_A, THING_B] },
          {
            rejectItemDuplicates: true,
          },
        ),
      ],
    });

    const decline = await screen.findByRole('button', { name: 'Not the same thing' });

    fireEvent.click(decline);

    // Declining is not destructive, so unlike the merge it is one click.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Not the same thing' })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Could not record that/)).toBeNull();
  });

  it('keeps the desktop filter row inline', async () => {
    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 3,
        }),
        duplicatesMock(NO_DUPLICATES),
      ],
    });

    expect(await screen.findByLabelText('Codes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /filters/i })).not.toBeInTheDocument();
  });

  it('opens filters from a sheet on mobile instead of stacking every control', async () => {
    const originalMatchMedia = window.matchMedia;

    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([makeThing(THING_A, 'Drill')]), {
          maxUsageCount: 3,
        }),
        mockQuery(
          GET_THINGS,
          { ...BASE_VARIABLES, hasIdentifier: false },
          makeThingsResult([makeThing(THING_B, 'Uncoded lamp')]),
          { maxUsageCount: 3 },
        ),
        duplicatesMock(NO_DUPLICATES, 5),
      ],
    });

    expect(await screen.findByRole('button', { name: /filters/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Codes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(await screen.findByLabelText('Codes'));
    fireEvent.click(await screen.findByRole('option', { name: 'No code' }));

    expect(await screen.findByText('Uncoded lamp')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('button', { name: 'Clear No code' })).toBeInTheDocument();

    window.matchMedia = originalMatchMedia;
  });

  it('does not show a New thing button on a phone — create lives in Add', async () => {
    const originalMatchMedia = window.matchMedia;

    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    renderWithProviders(<ThingsPage />, {
      route: '/memory/things',
      mocks: [
        mockQuery(GET_THINGS, BASE_VARIABLES, makeThingsResult([], 0), { maxUsageCount: 3 }),
        duplicatesMock(NO_DUPLICATES, 5),
      ],
    });

    expect(await screen.findByRole('tab', { name: 'Things' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Review sightings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New thing' })).not.toBeInTheDocument();

    window.matchMedia = originalMatchMedia;
  });

  /**
   * The page used to hand-roll its own cursor pagination; it now goes through
   * the shared useInfiniteConnection hook + InfiniteListFooter, same as
   * PlacesPage. This is the same "sentinel scrolls into view" contract.
   */
  it('appends the next page of things when the sentinel scrolls into view', async () => {
    const observer = captureIntersectionObserver();

    try {
      renderWithProviders(<ThingsPage />, {
        route: '/memory/things',
        mocks: [
          duplicatesMock(NO_DUPLICATES),
          mockQuery(
            GET_THINGS,
            BASE_VARIABLES,
            makeThingsResult([makeThing(THING_A, 'Drill')], 2, {
              hasNextPage: true,
              endCursor: THING_A,
            }),
          ),
          mockQuery(
            GET_THINGS,
            { ...BASE_VARIABLES, after: THING_A },
            makeThingsResult([makeThing(THING_B, 'Desk lamp')], 2),
          ),
        ],
      });

      expect(await screen.findByText('Drill')).toBeInTheDocument();
      expect(screen.queryByText('Desk lamp')).not.toBeInTheDocument();

      await observer.scrollSentinelIntoView();

      expect(await screen.findByText('Desk lamp')).toBeInTheDocument();
      expect(screen.getByText('Drill')).toBeInTheDocument();
      expect(screen.getByText(/loaded/).textContent).toContain('2 of 2 loaded · end');
    } finally {
      observer.restore();
    }
  });

  it('shows a retry button and keeps the failure latched when a further page fails to load', async () => {
    const observer = captureIntersectionObserver();

    try {
      renderWithProviders(<ThingsPage />, {
        route: '/memory/things',
        mocks: [
          duplicatesMock(NO_DUPLICATES),
          mockQuery(
            GET_THINGS,
            BASE_VARIABLES,
            makeThingsResult([makeThing(THING_A, 'Drill')], 2, {
              hasNextPage: true,
              endCursor: THING_A,
            }),
          ),
          {
            request: { query: GET_THINGS, variables: { ...BASE_VARIABLES, after: THING_A } },
            error: new Error('network down'),
          },
        ],
      });

      expect(await screen.findByText('Drill')).toBeInTheDocument();

      await observer.scrollSentinelIntoView();

      expect(await screen.findByText(/Couldn.t load more things: network down/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    } finally {
      observer.restore();
    }
  });
});
