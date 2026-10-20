import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CANDIDATE_PAGE_SIZE, PAGE_SIZE, PeoplePage } from './PeoplePage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children: React.ReactNode }) => children,
}));

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
            rawValue
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

const GET_MERGED_PERSON = gql(`
  query GetMergedPerson($id: ID!) {
    person(id: $id) {
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
        rawValue
        label
      }
      interactionStats {
        eventCount
        communicationCount
        lastInteractionAt
      }
    }
  }
`);

const GET_MERGE_CANDIDATES = gql(`
  query GetMergeCandidates($first: Int, $after: String) {
    mergeCandidates(first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          score
          status
          detectedBy
          createdAt
          evidence {
            kind
            value
            score
          }
          people {
            id
            name
            description
            avatarUrl
            isSelf
            identifiers {
              kind
              value
              rawValue
              label
              source
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
  }
`);

const MERGE_PEOPLE = gql(`
  mutation MergePeople($input: MergePeopleInput!) {
    mergePeople(input: $input) {
      success
      person {
        id
        name
      }
    }
  }
`);

function candidatesResult(
  edges: unknown[],
  { totalCount = edges.length, hasNextPage = false, endCursor = null as string | null } = {},
) {
  return {
    data: {
      mergeCandidates: {
        __typename: 'MergeCandidateConnection' as const,
        totalCount,
        pageInfo: { __typename: 'PageInfo' as const, hasNextPage, endCursor },
        edges,
      },
    },
  };
}

function mergePerson(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'PersonType' as const,
    id: PERSON_GLOBAL_ID,
    name: 'Ada Lovelace',
    description: null,
    avatarUrl: null,
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

/** One `ci.merge_candidates` edge, with sane defaults for the fields the card renders. */
function candidateEdge(people: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'MergeCandidateEdge' as const,
    cursor: 'candidate-1',
    node: {
      __typename: 'MergeCandidateType' as const,
      id: 'candidate-1',
      score: 0.85,
      status: 'pending',
      detectedBy: 'clean.duplicate_detect',
      createdAt: '2026-08-18T00:00:00Z',
      evidence: [
        {
          __typename: 'MergeCandidateEvidenceType' as const,
          kind: 'email',
          value: 'ada@example.com',
          score: 0.85,
        },
      ],
      people,
      ...overrides,
    },
  };
}

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

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/**
 * Renders the current route's query string so a test can assert on it directly
 * — the same technique GlobalSearchBox's suite uses to check what a typed
 * search actually commits to the URL, rather than reaching into router
 * internals.
 */
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
          this.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
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
          callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
      });
    },
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}

function mocks({ candidates = [] as unknown[] } = {}) {
  return [
    {
      request: { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } },
      result: {
        data: {
          people: {
            __typename: 'PersonConnection' as const,
            totalCount: 1,
            pageInfo: pageInfo(),
            edges: [{ __typename: 'PersonEdge' as const, cursor: PERSON_GLOBAL_ID, node: personNode() }],
          },
        },
      },
    },
    {
      request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
      result: candidatesResult(candidates),
    },
  ];
}

describe('PeoplePage', () => {
  afterEach(() => setViewport(false));

  // The first page used to load behind a full-screen spinner that covered
  // the Memory section strip too.
  it('shows person-shaped placeholder rows while the first page loads', async () => {
    renderWithProviders(<PeoplePage />, { mocks: mocks() });

    const status = screen.getByRole('status');

    expect(status).toHaveTextContent('Loading people');
    expect(status.querySelectorAll('[data-slot="skeleton"].rounded-full')).toHaveLength(8);
    expect(document.querySelector('.animate-spin')).toBeNull();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('routes to the decoded uuid, not the global id, when a person row is opened', async () => {
    navigate.mockClear();
    renderWithProviders(<PeoplePage />, { mocks: mocks() });

    fireEvent.click(await screen.findByText('Ada Lovelace'));

    expect(navigate).toHaveBeenCalledWith(`/people/${PERSON_UUID}`);
    expect(navigate).not.toHaveBeenCalledWith(`/people/${PERSON_GLOBAL_ID}`);
  });

  it('links merge-candidate members by their decoded uuid', async () => {
    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        candidates: [
          candidateEdge([
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
          ]),
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
          request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
          result: candidatesResult([]),
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
   * PersonService.findAll ranks a name that looks implausible — a bare digit
   * string, a phone number, a call-log heading like "Missed call from" — behind
   * real names, as its PRIMARY sort key (see commit 451f13e13). That fix exists
   * because these garbage-named rows are exactly the ones most likely to carry
   * fresh interactionStats: they are typically call-log stubs, so they have
   * recent communications while a freshly-imported real contact may have none
   * at all. A client-side re-sort keyed on interaction recency would put the
   * garbage name right back on top — reintroducing the bug the backend fix
   * corrected. The page must trust the server's order, not fight it.
   */
  it('keeps the server-provided order instead of re-sorting by interaction recency', async () => {
    const DIGIT_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff700';
    const DIGIT_GLOBAL_ID = btoa(`person:${DIGIT_UUID}`);
    const BEATRICE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff701';
    const BEATRICE_GLOBAL_ID = btoa(`person:${BEATRICE_UUID}`);

    renderWithProviders(<PeoplePage />, {
      mocks: [
        {
          request: { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } },
          result: {
            data: {
              people: {
                __typename: 'PersonConnection' as const,
                totalCount: 3,
                pageInfo: pageInfo(),
                edges: [
                  // Server order after the name-plausibility fix: real names
                  // first, regardless of interaction recency.
                  {
                    __typename: 'PersonEdge' as const,
                    cursor: PERSON_GLOBAL_ID,
                    node: personNode(), // Ada Lovelace, no interaction at all
                  },
                  {
                    __typename: 'PersonEdge' as const,
                    cursor: BEATRICE_GLOBAL_ID,
                    node: personNode({
                      id: BEATRICE_GLOBAL_ID,
                      name: 'Beatrice Clarke',
                      firstName: 'Beatrice',
                      lastName: 'Clarke',
                      interactionStats: {
                        __typename: 'PersonInteractionStatsType' as const,
                        eventCount: 0,
                        communicationCount: 2,
                        lastInteractionAt: '2026-01-01T00:00:00Z',
                      },
                    }),
                  },
                  // Garbage name ranked LAST by the server despite having the
                  // most recent interaction of the three — the call-log-stub
                  // shape the backend fix specifically demotes.
                  {
                    __typename: 'PersonEdge' as const,
                    cursor: DIGIT_GLOBAL_ID,
                    node: personNode({
                      id: DIGIT_GLOBAL_ID,
                      name: '1003',
                      firstName: null,
                      lastName: null,
                      interactionStats: {
                        __typename: 'PersonInteractionStatsType' as const,
                        eventCount: 0,
                        communicationCount: 9,
                        lastInteractionAt: '2026-08-18T00:00:00Z',
                      },
                    }),
                  },
                ],
              },
            },
          },
        },
        {
          request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
          result: candidatesResult([]),
        },
      ],
    });

    await screen.findByText('Ada Lovelace');

    const names = ['Ada Lovelace', 'Beatrice Clarke', '1003'];
    const rows = screen
      .getAllByRole('button')
      .filter((button) => names.some((name) => button.textContent?.includes(name)));

    expect(rows.map((row) => names.find((name) => row.textContent?.includes(name)))).toEqual(names);
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
            request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
            result: candidatesResult([]),
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

  it('offers one clear merge action and names the record that will be kept', async () => {
    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        candidates: [
          candidateEdge([
            {
              __typename: 'PersonType' as const,
              id: PERSON_GLOBAL_ID,
              name: 'Ada Lovelace',
              description: null,
              avatarUrl: null,
              isSelf: true,
            },
            {
              __typename: 'PersonType' as const,
              id: DUPLICATE_GLOBAL_ID,
              name: 'A. Lovelace',
              description: null,
              avatarUrl: null,
              isSelf: false,
            },
          ]),
        ],
      }),
    });

    expect(await screen.findByRole('button', { name: 'Merge into one person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Ada Lovelace as the kept person' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep this one' })).not.toBeInTheDocument();
    expect(screen.queryByText('Merge into one person?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('keeps the people list near the top on phones and reveals more merge cards on request', async () => {
    setViewport(true);

    const liamId = btoa('person:019fd7c0-641c-76dd-8ed7-a5053faff711');
    const stevenId = btoa('person:019fd7c0-641c-76dd-8ed7-a5053faff712');
    const graceId = btoa('person:019fd7c0-641c-76dd-8ed7-a5053faff713');
    const hopperId = btoa('person:019fd7c0-641c-76dd-8ed7-a5053faff714');

    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        candidates: [
          candidateEdge([
            mergePerson({ id: liamId, name: 'Liam Broza' }),
            mergePerson({ id: stevenId, name: 'Steven Berry' }),
          ]),
          {
            ...candidateEdge(
              [
                mergePerson({ id: graceId, name: 'Grace Hopper' }),
                mergePerson({ id: hopperId, name: 'G. Hopper' }),
              ],
              { id: 'candidate-2' },
            ),
            cursor: 'candidate-2',
          },
        ],
      }),
    });

    expect(await screen.findByText('Liam Broza')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Grace Hopper' })).not.toBeInTheDocument();

    const keep = screen.getByRole('button', { name: 'Use Liam Broza as the kept person' });
    expect(keep).toHaveTextContent('Keep');
    expect(keep.className).toContain('border');

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));

    expect(await screen.findByRole('link', { name: 'Grace Hopper' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show only one' })).toHaveAttribute('aria-expanded', 'true');
  });

  /**
   * Regression: the page used to call refetch() after a merge. refetch replays
   * the hook's ORIGINAL variables (first: PAGE_SIZE, no cursor), so it
   * overwrote the cache entry fetchMore had been appending to and collapsed the
   * list back to page one — on 21k people, throwing the user back to row 30 on
   * every merge of a 2,947-group backlog.
   */
  it('keeps scrolled-in pages after a merge instead of collapsing back to page one', async () => {
    const BEATRICE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff710';
    const BEATRICE_GLOBAL_ID = btoa(`person:${BEATRICE_UUID}`);
    const observer = captureIntersectionObserver();

    const candidate = candidateEdge([
      {
        __typename: 'PersonType' as const,
        id: PERSON_GLOBAL_ID,
        name: 'Ada Lovelace',
        description: null,
        avatarUrl: null,
        isSelf: true,
      },
      {
        __typename: 'PersonType' as const,
        id: DUPLICATE_GLOBAL_ID,
        name: 'A. Lovelace',
        description: null,
        avatarUrl: null,
        isSelf: false,
      },
    ]);

    try {
      renderWithProviders(<PeoplePage />, {
        mocks: [
          {
            request: { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } },
            result: {
              data: {
                people: {
                  __typename: 'PersonConnection' as const,
                  totalCount: 3,
                  pageInfo: pageInfo({ hasNextPage: true, endCursor: PERSON_GLOBAL_ID }),
                  edges: [
                    { __typename: 'PersonEdge' as const, cursor: PERSON_GLOBAL_ID, node: personNode() },
                    {
                      __typename: 'PersonEdge' as const,
                      cursor: DUPLICATE_GLOBAL_ID,
                      node: personNode({ id: DUPLICATE_GLOBAL_ID, name: 'A. Lovelace' }),
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
                  totalCount: 3,
                  pageInfo: pageInfo(),
                  edges: [
                    {
                      __typename: 'PersonEdge' as const,
                      cursor: BEATRICE_GLOBAL_ID,
                      node: personNode({ id: BEATRICE_GLOBAL_ID, name: 'Beatrice Clarke' }),
                    },
                  ],
                },
              },
            },
          },
          {
            request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
            result: candidatesResult([candidate]),
          },
          {
            request: {
              query: MERGE_PEOPLE,
              variables: { input: { targetId: PERSON_GLOBAL_ID, sourceIds: [DUPLICATE_GLOBAL_ID] } },
            },
            result: {
              data: {
                mergePeople: {
                  __typename: 'MergePeoplePayload' as const,
                  success: true,
                  person: {
                    __typename: 'PersonType' as const,
                    id: PERSON_GLOBAL_ID,
                    name: 'Ada Lovelace',
                  },
                },
              },
            },
          },
          // The one row whose aggregates the merge changed is re-read on its
          // own — NOT by re-running the list query.
          {
            request: { query: GET_MERGED_PERSON, variables: { id: PERSON_GLOBAL_ID } },
            result: {
              data: {
                person: personNode({
                  interactionStats: {
                    __typename: 'PersonInteractionStatsType' as const,
                    eventCount: 7,
                    communicationCount: 4,
                    lastInteractionAt: null,
                  },
                }),
              },
            },
          },
          // The candidate queue is re-read after the merge; it does not
          // re-run the people list.
          {
            request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
            result: candidatesResult([]),
          },
        ],
      });

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

      await observer.scrollSentinelIntoView();
      expect(await screen.findByText('Beatrice Clarke')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Merge into one person' }));

      // The merged-away row goes; the page-two row that refetch() used to wipe
      // out stays, and the kept row picks up its new aggregates.
      await waitFor(() => expect(screen.queryByText('A. Lovelace')).not.toBeInTheDocument());
      expect(screen.getByText('Beatrice Clarke')).toBeInTheDocument();
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
      await screen.findByText(/7 events · 4 messages/);
      // totalCount is decremented too, so the footer does not claim a row it dropped.
      expect(screen.getByText(/loaded/).textContent).toContain('2 of 2 loaded');
    } finally {
      observer.restore();
    }
  });

  /**
   * `ci.merge_candidates` was write-only: the pipeline scored pairs nobody could
   * read. The queue has to render the score and the evidence, because that is
   * the only thing distinguishing it from the cruder recomputed groups.
   */
  it('renders the scored merge-candidate queue with its evidence', async () => {
    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        candidates: [
          {
            __typename: 'MergeCandidateEdge' as const,
            cursor: 'cursor-1',
            node: {
              __typename: 'MergeCandidateType' as const,
              id: 'candidate-1',
              score: 0.85,
              status: 'pending',
              detectedBy: 'clean.duplicate_detect',
              createdAt: '2026-08-18T00:00:00Z',
              evidence: [
                {
                  __typename: 'MergeCandidateEvidenceType' as const,
                  kind: 'phone',
                  value: '9145826767',
                  score: 0.85,
                },
              ],
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
                  name: '+19145826767',
                  description: null,
                  avatarUrl: null,
                  isSelf: false,
                },
              ],
            },
          },
        ],
      }),
    });

    expect(await screen.findByText('Suggested merges')).toBeInTheDocument();
    expect(screen.getByText('85% match')).toBeInTheDocument();
    expect(screen.getByText(/Same phone digits: 914-582-6767/)).toBeInTheDocument();
    expect(screen.queryByText(/Detected by/)).not.toBeInTheDocument();
  });

  /**
   * The report: "Same phone number, but names differ" above two people whose
   * listed numbers were each marked "only here". The shared number sat in one
   * record's contact-card list, which `identifiers` cannot show — it reads an
   * index that holds a number for only one person. The card now names the
   * number and lists it under both people.
   */
  it('names the shared number and shows it under both people, not as two unrelated numbers', async () => {
    const phone = (value: string, rawValue: string) => ({
      __typename: 'PersonIdentifierType' as const,
      kind: 'phone',
      value,
      rawValue,
      label: null,
      source: 'import',
    });

    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        candidates: [
          candidateEdge(
            [
              mergePerson({ name: 'Ada Quill', identifiers: [phone('2125550118', '(212) 555-0118')] }),
              mergePerson({
                id: DUPLICATE_GLOBAL_ID,
                name: 'Bo Brightwater',
                identifiers: [phone('2125550110', '212-555-0110')],
              }),
            ],
            {
              evidence: [
                {
                  __typename: 'MergeCandidateEvidenceType' as const,
                  kind: 'phone',
                  value: '+12125550118',
                  score: 0.85,
                },
                {
                  __typename: 'MergeCandidateEvidenceType' as const,
                  kind: 'phone_check',
                  value: 'given_name_conflict',
                  score: 0,
                },
              ],
            },
          ),
        ],
      }),
    });

    const heading = await screen.findByText('Same phone number +1 (212) 555-0118, but names differ');
    // The card, not the People list below it (which shares Ada's cache entry).
    const card = within(heading.closest('[data-merge-candidate]') as HTMLElement);

    // Ada's own row, and the evidence number under Bo — both "shared".
    const adaRow = card.getByText('(212) 555-0118').closest('div');
    expect(adaRow).toHaveTextContent('shared');
    expect(adaRow).not.toHaveTextContent('only here');
    expect(card.getByText('+1 (212) 555-0118').closest('div')).toHaveTextContent('shared');

    // Bo's main line is genuinely his alone.
    expect(card.getByText('212-555-0110').closest('div')).toHaveTextContent('only here');
    // And the differences line no longer lists the shared number as Ada's alone.
    expect(card.queryByText(/Ada Quill has \(212\) 555-0118/)).not.toBeInTheDocument();
    expect(card.getByText(/Bo Brightwater has 212-555-0110/)).toBeInTheDocument();
  });

  it('shows a merging spinner on the merge button until the request finishes', async () => {
    renderWithProviders(<PeoplePage />, {
      mocks: [
        ...mocks({
          candidates: [
            candidateEdge([
              mergePerson({ isSelf: true }),
              mergePerson({ id: DUPLICATE_GLOBAL_ID, name: 'A. Lovelace' }),
            ]),
          ],
        }),
        {
          request: {
            query: MERGE_PEOPLE,
            variables: { input: { targetId: PERSON_GLOBAL_ID, sourceIds: [DUPLICATE_GLOBAL_ID] } },
          },
          delay: 10_000,
          result: {
            data: {
              mergePeople: {
                __typename: 'MergePeoplePayload' as const,
                success: true,
                person: { __typename: 'PersonType' as const, id: PERSON_GLOBAL_ID, name: 'Ada Lovelace' },
              },
            },
          },
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Merge into one person' }));
    expect(await screen.findByRole('button', { name: 'Merging' })).toBeDisabled();
  });

  it('groups a bare given name against several fuller people as a picker', async () => {
    const smithId = btoa('person:019fd7c0-641c-76dd-8ed7-a5053faff6fe');
    const clusterEvidence = [
      {
        __typename: 'MergeCandidateEvidenceType' as const,
        kind: 'name_cluster',
        value: 'william',
        score: 0.5,
      },
    ];

    renderWithProviders(<PeoplePage />, {
      mocks: mocks({
        candidates: [
          candidateEdge(
            [
              mergePerson({ name: 'william' }),
              mergePerson({ id: DUPLICATE_GLOBAL_ID, name: 'William Broza' }),
            ],
            { evidence: clusterEvidence },
          ),
          candidateEdge(
            [mergePerson({ name: 'william' }), mergePerson({ id: smithId, name: 'William Smith' })],
            { id: 'candidate-2', evidence: clusterEvidence },
          ),
        ],
      }),
    });

    expect(await screen.findByText(/might be one of these people/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'This is them' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'None of these' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge into one person' })).not.toBeInTheDocument();
  });

  /**
   * Search text is the header search box's `?search=` param — the page has no
   * input of its own — so a page mounted at that URL (navigated back to from
   * the Memory hub tabs, or opened from a shared link) runs that search, not
   * an empty one that silently re-queries everyone.
   */
  it('runs the search from the ?search= URL param on mount', async () => {
    renderWithProviders(<PeoplePage />, {
      route: '/?search=Ada',
      mocks: [
        {
          request: { query: GET_PEOPLE, variables: { query: 'Ada', first: PAGE_SIZE } },
          result: {
            data: {
              people: {
                __typename: 'PersonConnection' as const,
                totalCount: 1,
                pageInfo: pageInfo(),
                edges: [{ __typename: 'PersonEdge' as const, cursor: PERSON_GLOBAL_ID, node: personNode() }],
              },
            },
          },
        },
        {
          request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
          result: candidatesResult([]),
        },
      ],
    });

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search people and communications...')).not.toBeInTheDocument();
  });

  /**
   * Regression: both the error branch and the genuine-empty branch used to
   * render the same wording-agnostic `<EmptyState>` with no way to retry, so a
   * transient network failure read exactly like "you have no people" — the
   * false-emptiness failure mode ErrorState exists to end. Only the error
   * branch changes; "No people found" (covered by other suites' EmptyState
   * usage) is untouched.
   */
  it('shows ErrorState with a working retry instead of the old generic empty-state text on a query error', async () => {
    const failingRequest = { query: GET_PEOPLE, variables: { query: null, first: PAGE_SIZE } };

    renderWithProviders(<PeoplePage />, {
      mocks: [
        { request: failingRequest, error: new Error('network boom') },
        {
          request: { query: GET_MERGE_CANDIDATES, variables: { first: CANDIDATE_PAGE_SIZE } },
          result: candidatesResult([]),
        },
        // What Retry re-issues: the exact same query, this time succeeding.
        {
          request: failingRequest,
          result: {
            data: {
              people: {
                __typename: 'PersonConnection' as const,
                totalCount: 1,
                pageInfo: pageInfo(),
                edges: [{ __typename: 'PersonEdge' as const, cursor: PERSON_GLOBAL_ID, node: personNode() }],
              },
            },
          },
        },
      ],
    });

    expect(await screen.findByText('Could not load people')).toBeInTheDocument();
    expect(
      screen.getByText('Your people are still here — this device could not reach them just now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load people: network boom/)).not.toBeInTheDocument();
    expect(screen.queryByText('No people found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Ada Lovelace');
  });
});
