import type { MockedResponse } from '@apollo/client/testing';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CommunicationPage, GET_COMMUNICATION } from './CommunicationPage';

// The change-history panel runs its own queries and has nothing to do with the
// header under test.
vi.mock('@/components/EntityEvolution/EntityEvolutionPanel', () => ({ EntityEvolutionPanel: () => null }));

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

  /**
   * QA re-test of #2930: a chat message whose text ends in a URL has no break
   * point, so its heading kept the URL's full width and pushed the edit control
   * off the right edge of the page. jsdom does no layout; what can be pinned is the
   * structure that decides it: the title group and the title may shrink, and the
   * title breaks the URL where it must.
   */
  it('lets a long unbroken URL in the heading wrap, so the edit control stays on screen', async () => {
    const url = 'https://www.threads.com/@hannahstocking/post/DZoTALDGmu6';

    renderPage(
      mockQuery(
        GET_COMMUNICATION,
        { id: COMMUNICATION_ID },
        {
          communication: {
            __typename: 'CommunicationType',
            id: COMMUNICATION_ID,
            type: 'instagram_message',
            subject: null,
            preview: `rest in peace to my buddy olivertree ${url}`,
            content: 'rest in peace',
            time: '2026-09-01T12:00:00.000Z',
            direction: 'inbound',
            from: null,
            to: { __typename: 'PersonConnection', edges: [] },
            tags: [],
          },
        },
      ),
    );

    const heading = await screen.findByRole('heading', { name: new RegExp(url.replace(/[.?]/g, '\\$&')) });

    // The heading shrinks below the URL and breaks it…
    expect(heading).toHaveClass('min-w-0', 'break-words');
    // …inside a title group that may shrink too, so the control beside it holds its place…
    expect(heading.parentElement).toHaveClass('min-w-0');
    // …and the icon next to the heading keeps its size rather than being squeezed to a sliver
    // by the same shrinking (measured at 4px of 24 in a 402pt browser pane before this class).
    expect(heading.previousElementSibling).toHaveClass('shrink-0');
  });
});
