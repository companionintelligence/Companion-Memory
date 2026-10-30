import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_PERSON, PersonPage } from './PersonPage';

// The page's neighbours are not under test: each is a stub, so what is left is how the page wires
// the Edit Person save to the Change History panel.
vi.mock('@/components/EntityEvolution/EntityEvolutionPanel', () => ({
  EntityEvolutionPanel: ({ refreshKey }: { refreshKey?: number }) => (
    <div data-testid="change-history" data-refresh-key={refreshKey} />
  ),
}));
vi.mock('@/components/modals/AddItemModal/EditPersonModal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/modals/AddItemModal/EditPersonModal')>()),
  EditPersonModal: ({ onSaved }: { onSaved?: () => void }) => (
    <button type="button" onClick={onSaved}>
      Save person
    </button>
  ),
}));
vi.mock('@/components/PersonForm', () => ({ PersonProfileCard: () => null }));
vi.mock('@/components/EntityGraph', () => ({ EntityGraph: () => null }));
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', () => ({
  EntityRelationshipCards: () => null,
}));
vi.mock('@/components/EntityTagsDescriptionCard', () => ({
  EntityEditToggle: () => null,
  EntityTagsDescriptionCard: () => null,
}));
vi.mock('@/components/ChatWithAgent', () => ({ ChatWithAgentMenu: () => null }));
vi.mock('@/components/modals/AddItemModal/AddRelationshipModal', () => ({
  AddRelationshipModal: () => null,
}));

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

  /**
   * The panel loads its rows once, on mount, so a save on this page left Change History showing the
   * old list until the page was reloaded. Saving bumps the panel's `refreshKey`, which makes it fetch
   * again.
   */
  it('has Change History fetch again after Edit Person saves', async () => {
    const person = {
      __typename: 'PersonType',
      id: PERSON_ID,
      name: 'Robin Hale',
      description: null,
      tags: [],
      firstName: 'Robin',
      middleName: null,
      lastName: 'Hale',
      nickname: 'Rob',
      pronouns: null,
      gender: null,
      birthDate: null,
      jobTitle: null,
      organization: null,
      department: null,
      website: null,
      avatarUrl: null,
      addresses: [],
      identifiers: [],
    };

    renderPage(mockQuery(GET_PERSON, { id: PERSON_ID }, { person } as never));

    const panel = await screen.findByTestId('change-history');
    expect(panel).toHaveAttribute('data-refresh-key', '0');

    fireEvent.click(screen.getByRole('button', { name: 'Save person' }));

    expect(screen.getByTestId('change-history')).toHaveAttribute('data-refresh-key', '1');
  });
});
