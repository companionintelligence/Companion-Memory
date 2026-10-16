import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GetSavedSearchesDocument } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { SavedSearchesPage } from './SavedSearchesPage';

// SavedSearch (the row) reads useFeatures() to gate the sharing UI — unrelated
// to what this page's own tests cover, but it needs a provider to render.
vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return {
    ...actual,
    useFeatures: () => ({ isFeatureEnabled: () => false }),
  };
});

const BASE_VARIABLES = { first: 30, after: undefined, query: undefined, isSeed: false };
const STARTER_VARIABLES = { first: 20, after: undefined, query: undefined, isSeed: true };

function makeSavedSearch(rawId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'SavedSearchType' as const,
    id: btoa(`saved-search:${rawId}`),
    name,
    description: null,
    query: 'q',
    entityTypes: [],
    tags: [],
    filters: null,
    isPublic: false,
    shareToken: null,
    isSeed: false,
    ...overrides,
  };
}

function connectionOf(
  nodes: ReturnType<typeof makeSavedSearch>[],
  totalCount = nodes.length,
  pageInfoOverrides: { hasNextPage?: boolean; endCursor?: string | null } = {},
) {
  return {
    savedSearches: {
      __typename: 'SavedSearchConnection' as const,
      totalCount,
      pageInfo: {
        __typename: 'PageInfo' as const,
        hasNextPage: pageInfoOverrides.hasNextPage ?? false,
        endCursor: pageInfoOverrides.endCursor ?? null,
      },
      edges: nodes.map((node) => ({
        __typename: 'SavedSearchEdge' as const,
        cursor: node.id,
        node,
      })),
    },
  };
}

describe('SavedSearchesPage', () => {
  it('renders the user’s own searches, counted, without the starter library mixed in', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [
        mockQuery(
          GetSavedSearchesDocument,
          BASE_VARIABLES,
          connectionOf([makeSavedSearch('a', 'My trip'), makeSavedSearch('b', 'Work stuff')]),
        ),
      ],
    });

    expect(await screen.findByText('My trip')).toBeInTheDocument();
    expect(screen.getByText('Work stuff')).toBeInTheDocument();
    expect(screen.getByText('2 saved searches')).toBeInTheDocument();
    // The starter library is not fetched (and so not rendered) until the
    // disclosure below is opened.
    expect(screen.queryByText('Yoga for the Power Mad')).not.toBeInTheDocument();
  });

  it('shows a real empty state, not the zero-results message, when the user truly has none', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [mockQuery(GetSavedSearchesDocument, BASE_VARIABLES, connectionOf([]))],
    });

    expect(await screen.findByText("You don't have any Saved Searches yet.")).toBeInTheDocument();
  });

  it('shows the shared ErrorState with a working retry when the query fails, not a silent empty state', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [
        { request: { query: GetSavedSearchesDocument, variables: BASE_VARIABLES }, error: new Error('down') },
        mockQuery(GetSavedSearchesDocument, BASE_VARIABLES, connectionOf([makeSavedSearch('a', 'My trip')])),
      ],
    });

    expect(await screen.findByText('Could not load your saved searches')).toBeInTheDocument();
    expect(screen.queryByText("You don't have any Saved Searches yet.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('My trip')).toBeInTheDocument();
  });

  it('writes typed search text into ?q= and sends it as the query filter', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [
        mockQuery(GetSavedSearchesDocument, BASE_VARIABLES, connectionOf([makeSavedSearch('a', 'My trip')])),
        mockQuery(
          GetSavedSearchesDocument,
          { ...BASE_VARIABLES, query: 'trip' },
          connectionOf([makeSavedSearch('a', 'My trip')]),
        ),
      ],
    });

    const input = await screen.findByPlaceholderText(
      'Search your saved searches by name, description or tag...',
    );
    fireEvent.change(input, { target: { value: 'trip' } });

    await waitFor(() => expect(screen.getByText('My trip')).toBeInTheDocument());
  });

  it('keeps the starter library collapsed until opened, then fetches and shows it, badged as a starter', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [
        mockQuery(GetSavedSearchesDocument, BASE_VARIABLES, connectionOf([makeSavedSearch('a', 'My trip')])),
        mockQuery(
          GetSavedSearchesDocument,
          STARTER_VARIABLES,
          connectionOf([makeSavedSearch('seed-1', 'Yoga for the Power Mad', { isSeed: true })]),
        ),
      ],
    });

    expect(await screen.findByText('My trip')).toBeInTheDocument();
    expect(screen.queryByText('Yoga for the Power Mad')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Starter searches/ }));

    expect(await screen.findByText('Yoga for the Power Mad')).toBeInTheDocument();
    expect(screen.getByText('Starter')).toBeInTheDocument();
  });

  /**
   * QA MEM-08: on an account with no searches of its own, opening Starter
   * searches drew the "You don't have any Saved Searches yet" block ON TOP of the
   * starter rows. `EmptyState` is an `absolute inset-0` overlay on its nearest
   * positioned ancestor, and that was the whole scrolling page — the very box the
   * starter list opens into. jsdom does no layout, so the assertion is on the
   * structure that decides it: the overlay's positioning box must be a slot of
   * its own that the starter rows are not inside.
   */
  it('keeps the empty state in a box of its own, so the starter searches open below it, not under it', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [
        mockQuery(GetSavedSearchesDocument, BASE_VARIABLES, connectionOf([])),
        mockQuery(
          GetSavedSearchesDocument,
          STARTER_VARIABLES,
          connectionOf([makeSavedSearch('seed-1', 'Recent Images', { isSeed: true })]),
        ),
      ],
    });

    const message = await screen.findByText("You don't have any Saved Searches yet.");

    fireEvent.click(screen.getByRole('button', { name: /Starter searches/ }));

    const starter = await screen.findByText('Recent Images');
    const overlay = message.closest('.absolute');
    const box = overlay?.parentElement;

    expect(overlay).not.toBeNull();
    expect(box).toHaveClass('relative');
    expect(box).not.toContainElement(starter);
    // …and it is not the page itself, which is where the overlay used to land.
    expect(box).not.toHaveAttribute('data-page-scroll');
  });

  it('gives the no-match state the same box, for the same reason', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      route: '/saved-searches?q=zzz',
      mocks: [
        mockQuery(GetSavedSearchesDocument, { ...BASE_VARIABLES, query: 'zzz' }, connectionOf([])),
        mockQuery(
          GetSavedSearchesDocument,
          { ...STARTER_VARIABLES, query: 'zzz' },
          connectionOf([makeSavedSearch('seed-2', 'Zzz starter', { isSeed: true })]),
        ),
      ],
    });

    const message = await screen.findByText('No saved searches match "zzz".');

    fireEvent.click(screen.getByRole('button', { name: /Starter searches/ }));

    const starter = await screen.findByText('Zzz starter');
    const box = message.closest('.absolute')?.parentElement;

    expect(box).toHaveClass('relative');
    expect(box).not.toContainElement(starter);
  });

  it('opens the editor from the pencil instead of sending the search to the explorer', async () => {
    renderWithProviders(<SavedSearchesPage />, {
      mocks: [
        mockQuery(GetSavedSearchesDocument, BASE_VARIABLES, connectionOf([makeSavedSearch('a', 'My trip')])),
      ],
    });

    await screen.findByText('My trip');
    fireEvent.click(screen.getByRole('button', { name: 'Edit saved search' }));

    // The editor, not a navigation: the row's pencil used to fall through to
    // /memory?saved_search=, where the only save made a second search.
    const dialog = await screen.findByRole('dialog', { name: 'Update Saved Search' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('My trip');
  });
});
