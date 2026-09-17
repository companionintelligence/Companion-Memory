import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_PERSON, PersonPage } from './PersonPage';

const RAW_ID = 'p-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('person', id)` before querying.
const PERSON_ID = btoa('person:p-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<PersonPage />, {
    path: '/people/:id',
    route: `/people/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('PersonPage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Person not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_PERSON, { id: PERSON_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this person')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Person not found')).not.toBeInTheDocument();
  });

  it('still says "Person not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_PERSON, { id: PERSON_ID }, { person: null }));

    expect(await screen.findByText('Person not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this person')).not.toBeInTheDocument();
  });
});
