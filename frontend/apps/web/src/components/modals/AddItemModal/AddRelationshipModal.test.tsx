/**
 * AddRelationshipModal: search an entity, pick a relationship type scoped to
 * what that entity kind allows, and create the edge via CreateRelationship.
 * The search network layer is stubbed (its own coverage lives with
 * GlobalSearchBox/useSearchService) so this suite is about the modal's own
 * wiring — GlobalUID decode into fromNode/toNode, the success reset+close,
 * and what a failed create actually does today.
 */
import type { MockedResponse } from '@apollo/client/testing';
import { GlobalUID } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { AddRelationshipModal } from './AddRelationshipModal';

const CREATE_RELATIONSHIP = gql(`
  mutation CreateRelationship($input: CreateRelationshipInput!) {
    createRelationship(input: $input) {
      success
      relationship {
        id
        fromNodeId
        fromNodeType
        toNodeId
        toNodeType
        type
        properties
        isBidirectional
        startDate
        endDate
      }
    }
  }
`);

const h = vi.hoisted(() => ({
  search: { data: [] as unknown[], tags: [] as unknown[], loading: false, error: undefined as unknown },
}));

vi.mock('@/components/SearchBox/useSearchService.ts', () => ({
  useSearchService: () => h.search,
}));

const PERSON_GID = GlobalUID.encode('person', '42');

beforeEach(() => {
  h.search = {
    data: [{ __typename: 'PersonType', id: PERSON_GID, name: 'Alice', description: null }],
    tags: [],
    loading: false,
    error: undefined,
  };
});

const ALLOWED = { person: ['BUSINESS_PARTNER', 'family_member'] };

function renderModal(mocks: MockedResponse[] = []) {
  const onClose = vi.fn();

  renderWithProviders(
    <AddRelationshipModal
      entityId="event-1"
      entityType="event"
      allowedRelationshipTypes={ALLOWED}
      open
      onClose={onClose}
    />,
    { mocks },
  );

  return { onClose };
}

/** Type a query and select the (single, mocked) search result. */
async function selectAlice() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ali' } });
  fireEvent.click(await screen.findByText('Alice'));
}

/**
 * Radix Select opens on pointerdown, and the option list is portalled. Named
 * lookup: once an entity is selected, the Start/End date calendars each add
 * their own native month/year `<select>`s, which also carry role "combobox".
 */
function openRelationshipType() {
  fireEvent.pointerDown(screen.getByRole('combobox', { name: /relationship type/i }), {
    button: 0,
    pointerType: 'mouse',
  });
}

describe('AddRelationshipModal — picking the related entity', () => {
  it('shows only relationship types the resolved entity type allows, sorted and human-formatted', async () => {
    renderModal();
    await selectAlice();
    openRelationshipType();

    const options = await screen.findAllByRole('option');
    // Sorted case-sensitively (localeCompare) and each underscore/case
    // normalized into a readable label — this is AddRelationshipModal's own
    // formatting, not a passthrough of the raw enum value.
    expect(options.map((o) => o.textContent)).toEqual(['Business partner', 'Family member']);
  });

  it('clearing the selected entity also clears the relationship type', async () => {
    renderModal();
    await selectAlice();
    openRelationshipType();
    fireEvent.click(await screen.findByRole('option', { name: 'Business partner' }));

    fireEvent.click(screen.getByRole('button', { name: /clear selected entity/i }));

    // Back to search mode, and the Add button is disabled again (nothing selected).
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('keeps Add disabled until both an entity and a relationship type are chosen', async () => {
    renderModal();

    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();

    await selectAlice();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();

    openRelationshipType();
    fireEvent.click(await screen.findByRole('option', { name: 'Business partner' }));

    expect(screen.getByRole('button', { name: /^add$/i })).not.toBeDisabled();
  });
});

describe('AddRelationshipModal — creating the edge', () => {
  it('decodes the GlobalUID and sends both ends of the edge, then resets and closes', async () => {
    const createHandler = vi.fn(() => ({
      data: {
        createRelationship: {
          success: true,
          relationship: {
            id: 'rel-1',
            fromNodeId: 'event-1',
            fromNodeType: 'event',
            toNodeId: '42',
            toNodeType: 'person',
            type: 'BUSINESS_PARTNER',
            properties: null,
            isBidirectional: false,
            startDate: null,
            endDate: null,
          },
        },
      },
    }));

    const { onClose } = renderModal([
      {
        request: {
          query: CREATE_RELATIONSHIP,
          variables: (variables: { input: Record<string, unknown> }) => {
            expect(variables.input).toMatchObject({
              fromNodeId: 'event-1',
              fromNodeType: 'event',
              toNodeId: '42',
              toNodeType: 'person',
              type: 'BUSINESS_PARTNER',
            });

            return true;
          },
        },
        result: createHandler,
      } as unknown as MockedResponse,
    ]);

    await selectAlice();
    openRelationshipType();
    fireEvent.click(await screen.findByRole('option', { name: 'Business partner' }));

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(createHandler).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
  });

  it('leaves the selection in place — nothing is silently lost — when the create fails', async () => {
    // There is currently no visible error message on this path (see the
    // follow-up filed alongside this test): the mutation's rejection is only
    // caught to stop it becoming an unhandled promise. What IS real and worth
    // pinning is that the failure does not eat the user's picks the way a
    // reset-then-fail bug would.
    const { onClose } = renderModal([
      {
        request: { query: CREATE_RELATIONSHIP, variables: () => true },
        error: new Error('network down'),
      } as unknown as MockedResponse,
    ]);

    await selectAlice();
    openRelationshipType();
    fireEvent.click(await screen.findByRole('option', { name: 'Business partner' }));

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^add$/i })).not.toBeDisabled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
