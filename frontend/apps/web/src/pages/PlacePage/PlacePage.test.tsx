import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_PLACE, PlacePage } from './PlacePage';

const RAW_ID = 'pl-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('place', id)` before querying.
const PLACE_ID = btoa('place:pl-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<PlacePage />, {
    path: '/places/:id',
    route: `/places/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('PlacePage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Place not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_PLACE, { id: PLACE_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this place')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Place not found')).not.toBeInTheDocument();
  });

  it('still says "Place not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_PLACE, { id: PLACE_ID }, { place: null }));

    expect(await screen.findByText('Place not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this place')).not.toBeInTheDocument();
  });
});
