import { gql as apolloGql, useQuery } from '@apollo/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { DeleteSavedSearchModal } from './DeleteSavedSearchModal';

const DELETE_SAVED_SEARCH = gql(`
  mutation DeleteSavedSearch($input: DeleteByIdInput!) {
    deleteSavedSearch(input: $input) {
      success
      deletedId
    }
  }
`);

/**
 * A standalone query for this test only (not the real `GET_SAVED_SEARCHES`,
 * which pulls the full `SavedSearchGridItemFragment`). `cache.modify`'s
 * `savedSearches` field function runs for every stored variant of that field
 * name regardless of arguments or which query populated it, so a minimal
 * shape is enough to prove the modal's manual cache surgery — the eviction
 * and the list-edge filter — actually removes the row, not just that the
 * mutation was sent.
 */
const LIST_SAVED_SEARCHES = apolloGql(`
  query ListSavedSearchesForTest {
    savedSearches(first: 10) {
      totalCount
      edges {
        node {
          id
          name
        }
      }
    }
  }
`);

/** The same field under other arguments — the starter list, cached beside the user's own. */
const LIST_STARTER_SEARCHES = apolloGql(`
  query ListStarterSearchesForTest {
    savedSearches(first: 10, isSeed: true) {
      totalCount
      edges {
        node {
          id
          name
        }
      }
    }
  }
`);

interface ListNode {
  id: string;
  name: string;
}

function connectionOf(nodes: ListNode[], totalCount: number) {
  return {
    savedSearches: {
      __typename: 'SavedSearchConnection',
      totalCount,
      edges: nodes.map((n) => ({
        __typename: 'SavedSearchEdge',
        node: { __typename: 'SavedSearchType', ...n },
      })),
    },
  };
}

function listMock(nodes: ListNode[], totalCount = nodes.length) {
  return {
    request: { query: LIST_SAVED_SEARCHES },
    result: { data: connectionOf(nodes, totalCount) },
  };
}

function starterMock(nodes: ListNode[], totalCount = nodes.length) {
  return {
    request: { query: LIST_STARTER_SEARCHES },
    result: { data: connectionOf(nodes, totalCount) },
  };
}

function deleteMock(id: string, deletedId: string | null = id) {
  return {
    request: { query: DELETE_SAVED_SEARCH, variables: { input: { id } } },
    result: {
      data: {
        deleteSavedSearch: { __typename: 'DeleteSavedSearchPayload', success: Boolean(deletedId), deletedId },
      },
    },
  };
}

function ListAndModal({ savedSearchId, onClose }: { savedSearchId: string; onClose: () => void }) {
  const { data } = useQuery<{ savedSearches: { edges: { node: ListNode }[] } }>(LIST_SAVED_SEARCHES);
  const names = data?.savedSearches.edges.map((edge) => edge.node.name) ?? [];

  return (
    <>
      <ul>
        {names.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <DeleteSavedSearchModal savedSearchId={savedSearchId} onClose={onClose} />
    </>
  );
}

/** Both lists the page keeps in the cache, with the totals the header and footer read. */
function TwoListsAndModal({ savedSearchId, onClose }: { savedSearchId: string; onClose: () => void }) {
  const yours = useQuery<{ savedSearches: { totalCount: number } }>(LIST_SAVED_SEARCHES);
  const starters = useQuery<{ savedSearches: { totalCount: number } }>(LIST_STARTER_SEARCHES);

  return (
    <>
      <p>yours: {yours.data?.savedSearches.totalCount}</p>
      <p>starters: {starters.data?.savedSearches.totalCount}</p>
      <DeleteSavedSearchModal savedSearchId={savedSearchId} onClose={onClose} />
    </>
  );
}

describe('DeleteSavedSearchModal', () => {
  it('asks for confirmation before deleting anything', async () => {
    const onClose = vi.fn();
    renderWithProviders(<DeleteSavedSearchModal savedSearchId="s1" onClose={onClose} />, {
      mocks: [deleteMock('s1')],
    });

    expect(screen.getByText('Delete Saved Search')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('cancels without sending a delete', () => {
    const onClose = vi.fn();
    // No delete mock supplied: if Cancel triggered a mutation, MockedProvider
    // would surface an unmatched-request error.
    renderWithProviders(<DeleteSavedSearchModal savedSearchId="s1" onClose={onClose} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deletes on confirm and evicts the row from a cached list, leaving the others', async () => {
    const onClose = vi.fn();

    renderWithProviders(<ListAndModal savedSearchId="s1" onClose={onClose} />, {
      mocks: [
        listMock([
          { id: 's1', name: 'Trips to Tokyo' },
          { id: 's2', name: 'Work emails' },
        ]),
        deleteMock('s1'),
      ],
    });

    await screen.findByText('Trips to Tokyo');
    expect(screen.getByText('Work emails')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The deleted saved search's row is gone from the list query the mutation's
    // `update` reached into by hand — the other one is untouched.
    await waitFor(() => expect(screen.queryByText('Trips to Tokyo')).not.toBeInTheDocument());
    expect(screen.getByText('Work emails')).toBeInTheDocument();
  });

  /**
   * MEM-08 re-test: "2 saved searches" / "1 of 2 loaded" stayed put after a delete,
   * even after leaving the page and coming back — the update trimmed the edges and
   * evicted the node but never touched the connection's `totalCount`, which is what
   * both of those lines print.
   */
  it('lowers the total of the list that held the row, and only that list', async () => {
    const onClose = vi.fn();

    renderWithProviders(<TwoListsAndModal savedSearchId="s1" onClose={onClose} />, {
      mocks: [
        // Two of seven loaded, as on a long list with more pages behind it.
        listMock(
          [
            { id: 's1', name: 'Trips to Tokyo' },
            { id: 's2', name: 'Work emails' },
          ],
          7,
        ),
        starterMock([{ id: 't1', name: 'Recent photos' }], 4),
        deleteMock('s1'),
      ],
    });

    await screen.findByText('yours: 7');
    expect(screen.getByText('starters: 4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('yours: 6')).toBeInTheDocument());
    // The starter list never held the row, so it keeps its count.
    expect(screen.getByText('starters: 4')).toBeInTheDocument();
  });

  it('shows a busy state while the delete is in flight, then completes', async () => {
    const onClose = vi.fn();

    renderWithProviders(<DeleteSavedSearchModal savedSearchId="s1" onClose={onClose} />, {
      mocks: [{ ...deleteMock('s1'), delay: 20 }],
    });

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    // Apollo flips `loading` synchronously on calling the mutate function, before
    // the (delayed) network response resolves — both buttons must reflect it.
    expect(screen.getByText('Deleting...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByText('Deleting...').closest('button')).toBeDisabled();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an error and keeps the dialog open — not a silent close — when the delete fails', async () => {
    const onClose = vi.fn();

    renderWithProviders(<DeleteSavedSearchModal savedSearchId="s1" onClose={onClose} />, {
      mocks: [
        {
          request: { query: DELETE_SAVED_SEARCH, variables: { input: { id: 's1' } } },
          error: new Error('network down'),
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/could not delete this saved search/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Ready to retry, not stuck on "Deleting...".
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });
});
