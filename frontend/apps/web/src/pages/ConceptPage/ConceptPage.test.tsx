import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ConceptPage, GET_CONCEPT } from './ConceptPage';

const RAW_ID = 'c-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('concept', id)` before querying.
const CONCEPT_ID = btoa('concept:c-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<ConceptPage />, {
    path: '/concepts/:id',
    route: `/concepts/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('ConceptPage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Concept not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_CONCEPT, { id: CONCEPT_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this concept')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Concept not found')).not.toBeInTheDocument();
  });

  it('still says "Concept not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_CONCEPT, { id: CONCEPT_ID }, { concept: null }));

    expect(await screen.findByText('Concept not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this concept')).not.toBeInTheDocument();
  });
});
