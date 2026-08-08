import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PAGE_SIZE, PeoplePage } from './PeoplePage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const GET_PEOPLE = gql(`
  query GetPeople($query: String, $first: Int, $after: String) {
    people(query: $query, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
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

function pageInfo({ hasNextPage = false, endCursor = null as string | null } = {}) {
  return { __typename: 'PageInfo' as const, hasNextPage, endCursor };
}

/**
 * `src/test/setup.ts` stubs IntersectionObserver with a no-op for the whole
 * suite, so a sentinel can never fire on its own. Swap in a version that records
 * its callbacks, and restore the original afterwards — replacing the global
 * permanently would leak into every later test file.
 */
function captureIntersectionObserver({ fireOnObserve = false } = {}) {
  const callbacks: IntersectionObserverCallback[] = [];
  const original = globalThis.IntersectionObserver;
  let observeCount = 0;

  class CapturingObserver {
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      callbacks.push(callback);
    }

    observe() {
      observeCount += 1;

      // A real observer invokes its callback asynchronously when the target is
      // already intersecting. Modelling that is the whole point for the retry
      // test: it is what turns "rebuild the observer" into a request loop.
      if (fireOnObserve) {
        queueMicrotask(() =>
          this.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          ),
        );
      }
    }

    unobserve() {}

    disconnect() {}

    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;

  return {
    observeCount: () => observeCount,
    scrollSentinelIntoView: async () => {
      await act(async () => {
        for (const callback of callbacks) {
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        }
      });
    },
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}

function mocks({ duplicates = [] as unknown[] } = {}) {
  return [
    {
      request: { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } },
      result: {
        data: {
          people: {
            __typename: 'PersonConnection' as const,
            totalCount: 1,
            pageInfo: pageInfo(),
            edges: [
              { __typename: 'PersonEdge' as const, cursor: PERSON_GLOBAL_ID, node: personNode() },
            ],
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

  /**
   * The page used to ask for a hardcoded `first: 500` and never request a second
   * page, so with more people than that you could only ever see the
   * alphabetically-first 500 — in practice every name starting with "A".
   */
  it('loads the next page when the sentinel scrolls into view', async () => {
    const BEATRICE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6fd';
    const BEATRICE_GLOBAL_ID = btoa(`person:${BEATRICE_UUID}`);
    const observer = captureIntersectionObserver();

    renderWithProviders(<PeoplePage />, {
      mocks: [
        {
          request: { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } },
          result: {
            data: {
              people: {
                __typename: 'PersonConnection' as const,
                totalCount: 2,
                pageInfo: pageInfo({ hasNextPage: true, endCursor: PERSON_GLOBAL_ID }),
                edges: [
                  {
                    __typename: 'PersonEdge' as const,
                    cursor: PERSON_GLOBAL_ID,
                    node: personNode(),
                  },
                ],
              },
            },
          },
        },
        {
          request: {
            query: GET_PEOPLE,
            variables: { query: null, first: PAGE_SIZE, after: PERSON_GLOBAL_ID },
          },
          result: {
            data: {
              people: {
                __typename: 'PersonConnection' as const,
                totalCount: 2,
                pageInfo: pageInfo(),
                edges: [
                  {
                    __typename: 'PersonEdge' as const,
                    cursor: BEATRICE_GLOBAL_ID,
                    node: personNode({
                      id: BEATRICE_GLOBAL_ID,
                      name: 'Beatrice Clarke',
                      firstName: 'Beatrice',
                      lastName: 'Clarke',
                    }),
                  },
                ],
              },
            },
          },
        },
        {
          request: { query: GET_PERSON_DUPLICATES },
          result: { data: { personDuplicates: [] } },
        },
      ],
    });

    try {
      // Page one only.
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.queryByText('Beatrice Clarke')).not.toBeInTheDocument();

      await observer.scrollSentinelIntoView();

      // Page two is appended, not swapped in.
      expect(await screen.findByText('Beatrice Clarke')).toBeInTheDocument();
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    } finally {
      observer.restore();
    }
  });

  /**
   * A failed next-page fetch must not retry on its own. The sentinel is still on
   * screen when the request fails, so simply clearing the in-flight flag rebuilds
   * the observer, which re-fires on observe() and spins a request loop — measured
   * at ~220 requests in 300ms before this was latched.
   */
  it('stops after one failed page and offers a retry instead of looping', async () => {
    const observer = captureIntersectionObserver({ fireOnObserve: true });

    const failingPage = {
      request: {
        query: GET_PEOPLE,
        variables: { query: null, first: PAGE_SIZE, after: PERSON_GLOBAL_ID },
      },
      error: new Error('network boom'),
    };

    try {
      renderWithProviders(<PeoplePage />, {
        mocks: [
          {
            request: { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } },
            result: {
              data: {
                people: {
                  __typename: 'PersonConnection' as const,
                  totalCount: 99,
                  pageInfo: pageInfo({ hasNextPage: true, endCursor: PERSON_GLOBAL_ID }),
                  edges: [
                    {
                      __typename: 'PersonEdge' as const,
                      cursor: PERSON_GLOBAL_ID,
                      node: personNode(),
                    },
                  ],
                },
              },
            },
          },
          // Deliberately only ONE failing mock. A retry loop would blow past it
          // and start logging "No more mocked responses".
          failingPage,
          {
            request: { query: GET_PERSON_DUPLICATES },
            result: { data: { personDuplicates: [] } },
          },
        ],
      });

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

      // The retry affordance replaces the sentinel once the page fails.
      expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();

      const settled = observer.observeCount();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // No further observers are attached while the error is latched, so nothing
      // re-requests the failed cursor.
      expect(observer.observeCount()).toBe(settled);
      // And the footer is not wedged mid-load.
      expect(screen.getByText(/loaded/).textContent).not.toContain('loading');
    } finally {
      observer.restore();
    }
  });
});
