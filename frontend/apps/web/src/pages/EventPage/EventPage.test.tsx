import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { EventPage, GET_EVENT } from './EventPage';

const RAW_ID = 'e-1';
// The route carries the raw id; the page re-encodes it with
// `GlobalUID.encode('event', id)` before querying.
const EVENT_ID = btoa('event:e-1');

function renderPage(mock: MockedResponse) {
  return renderWithProviders(<EventPage />, {
    path: '/events/:id',
    route: `/events/${RAW_ID}`,
    mocks: [mock],
  });
}

describe('EventPage', () => {
  /**
   * The page dropped the query's `error`, so a 500, a dead connection or an
   * expired session all landed on the "Event not found" empty state — the
   * appliance telling the owner their own data does not exist. The shared
   * ErrorState says the fetch failed instead, and offers a retry.
   */
  it('renders the shared ErrorState with a retry when the query fails, not the not-found state', async () => {
    renderPage(mockQuery(GET_EVENT, { id: EVENT_ID }, { error: new Error('network down') }));

    expect(await screen.findByText('Could not load this event')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Event not found')).not.toBeInTheDocument();
  });

  it('still says "Event not found" when the server answers with no such record', async () => {
    renderPage(mockQuery(GET_EVENT, { id: EVENT_ID }, { event: null }));

    expect(await screen.findByText('Event not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this event')).not.toBeInTheDocument();
  });
});
