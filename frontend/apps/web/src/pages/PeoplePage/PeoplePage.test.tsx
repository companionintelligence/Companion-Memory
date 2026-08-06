import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PeoplePage } from './PeoplePage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const GET_PEOPLE = gql(`
  query GetPeople($query: String) {
    people(query: $query, first: 500) {
      totalCount
      edges {
        node {
          id
          name
          description
          firstName
          lastName
          avatarUrl
          birthDate
          isSelf
          identifiers {
            kind
            value
            label
          }
          interactionStats {
            eventCount
            communicationCount
            lastInteractionAt
          }
        }
      }
    }
  }
`);

const GET_PERSON_DUPLICATES = gql(`
  query GetPersonDuplicates {
    personDuplicates {
      reason
      value
      people {
        id
        name
        description
        avatarUrl
        isSelf
      }
    }
  }
`);

/**
 * `/people/:id` carries the RAW uuid — `PersonPage` re-encodes it with
 * `GlobalUID.encode('person', id)` before querying. GraphQL `id` fields are
 * global ids (base64 `person:<uuid>`), so routing with one unchanged makes
 * `PersonPage` encode an already-encoded id and render "Person not found".
 */
const PERSON_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6fb';
const PERSON_GLOBAL_ID = btoa(`person:${PERSON_UUID}`);
const DUPLICATE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6fc';
const DUPLICATE_GLOBAL_ID = btoa(`person:${DUPLICATE_UUID}`);

function personNode(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'PersonType' as const,
    id: PERSON_GLOBAL_ID,
    name: 'Ada Lovelace',
    description: null,
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: null,
    birthDate: null,
    isSelf: false,
    identifiers: [],
    interactionStats: {
      __typename: 'PersonInteractionStatsType' as const,
      eventCount: 0,
      communicationCount: 0,
      lastInteractionAt: null,
    },
    ...overrides,
  };
}

function mocks({ duplicates = [] as unknown[] } = {}) {
  return [
    {
      request: { query: GET_PEOPLE, variables: { query: null } },
      result: {
        data: {
          people: {
            __typename: 'PersonConnection' as const,
            totalCount: 1,
            edges: [{ __typename: 'PersonEdge' as const, node: personNode() }],
          },
        },
      },
    },
    {
      request: { query: GET_PERSON_DUPLICATES },
      result: { data: { personDuplicates: duplicates } },
    },
  ];
}

describe('PeoplePage', () => {
  it('routes to the decoded uuid, not the global id, when a person row is opened', async () => {
    navigate.mockClear();
    renderWithProviders(<PeoplePage />, { mocks: mocks() });

    fireEvent.click(await screen.findByText('Ada Lovelace'));

    expect(navigate).toHaveBeenCalledWith(`/people/${PERSON_UUID}`);
    expect(navigate).not.toHaveBeenCalledWith(`/people/${PERSON_GLOBAL_ID}`);
  });

  it('links duplicate-group members by their decoded uuid', async () => {
    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        duplicates: [
          {
            __typename: 'PersonDuplicateGroupType' as const,
            reason: 'email',
            value: 'ada@example.com',
            people: [
              {
                __typename: 'PersonType' as const,
                id: PERSON_GLOBAL_ID,
                name: 'Ada Lovelace',
                description: null,
                avatarUrl: null,
                isSelf: false,
              },
              {
                __typename: 'PersonType' as const,
                id: DUPLICATE_GLOBAL_ID,
                name: 'A. Lovelace',
                description: null,
                avatarUrl: null,
                isSelf: false,
              },
            ],
          },
        ],
      }),
    });

    expect(await screen.findByRole('link', { name: 'A. Lovelace' })).toHaveAttribute(
      'href',
      `/people/${DUPLICATE_UUID}`,
    );
  });
});
