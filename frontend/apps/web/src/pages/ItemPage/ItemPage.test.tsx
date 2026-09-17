import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GET_ITEM } from '@/components/entities/itemDocuments';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ItemPage } from './ItemPage';

const RAW_ID = 'i-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('item', id)` before querying.
const ITEM_ID = btoa('item:i-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<ItemPage />, {
    path: '/items/:id',
    route: `/items/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('ItemPage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Thing not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_ITEM, { id: ITEM_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this thing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Thing not found')).not.toBeInTheDocument();
  });

  it('still says "Thing not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_ITEM, { id: ITEM_ID }, { item: null }));

    expect(await screen.findByText('Thing not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this thing')).not.toBeInTheDocument();
  });
});
