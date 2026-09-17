import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CommunicationPage, GET_COMMUNICATION } from './CommunicationPage';

const RAW_ID = 'cm-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('communication', id)` before querying.
const COMMUNICATION_ID = btoa('communication:cm-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<CommunicationPage />, {
    path: '/communications/:id',
    route: `/communications/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('CommunicationPage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Communication not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_COMMUNICATION, { id: COMMUNICATION_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this communication')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Communication not found')).not.toBeInTheDocument();
  });

  it('still says "Communication not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_COMMUNICATION, { id: COMMUNICATION_ID }, { communication: null }));

    expect(await screen.findByText('Communication not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this communication')).not.toBeInTheDocument();
  });
});
