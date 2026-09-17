import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ContentPage, GET_CONTENT } from './ContentPage';

const RAW_ID = 'ct-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('content', id)` before querying.
const CONTENT_ID = btoa('content:ct-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<ContentPage />, {
    path: '/content/:id',
    route: `/content/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('ContentPage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Content not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_CONTENT, { id: CONTENT_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Content not found')).not.toBeInTheDocument();
  });

  it('still says "Content not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_CONTENT, { id: CONTENT_ID }, { content: null }));

    expect(await screen.findByText('Content not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this content')).not.toBeInTheDocument();
  });
});
