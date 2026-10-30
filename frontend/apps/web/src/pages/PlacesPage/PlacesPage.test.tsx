import type { MockedResponse } from '@apollo/client/testing';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET_TAG_SUGGESTIONS } from '@/components/TagInput';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_PLACE_DUPLICATES, PLACE_DUPLICATE_PAGE_SIZE } from './PlaceDuplicatesCard';
import { CONFIRM_KNOWN_PLACE, GET_KNOWN_PLACES, GET_PLACES, PAGE_SIZE, PlacesPage } from './PlacesPage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children: React.ReactNode }) => children,
}));

/** See PeoplePage.test.tsx — the suite stubs IntersectionObserver with a no-op. */
function captureIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  const original = globalThis.IntersectionObserver;

  class CapturingObserver {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }

    observe() {}

    unobserve() {}

    disconnect() {}

    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;

  return {
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

function pageInfo(overrides: { hasNextPage?: boolean; endCursor?: string | null } = {}) {
  return {
    __typename: 'PageInfo' as const,
    hasNextPage: overrides.hasNextPage ?? false,
    endCursor: overrides.endCursor ?? null,
  };
}

/** An empty places list — these tests exercise KnownPlacesCard, not the list/map below it. */
function emptyPlacesMock() {
  return placesMock({ totalCount: 0, edges: [] });
}

/** The duplicates card queries on mount; an empty page keeps it out of the way. */
function noDuplicatesMock() {
  return {
    request: { query: GET_PLACE_DUPLICATES, variables: { limit: PLACE_DUPLICATE_PAGE_SIZE, offset: 0 } },
    result: {
      data: {
        placeDuplicates: {
          __typename: 'PlaceDuplicatesPayload' as const,
          totalCount: 0,
          hasMore: false,
          groups: [],
        },
      },
    },
    maxUsageCount: 5,
  };
}

function tagSuggestionsMock(labels: string[] = []): MockedResponse {
  return {
    request: { query: GET_TAG_SUGGESTIONS },
    result: {
      data: {
        tags: {
          __typename: 'TagConnection' as const,
          edges: labels.map((label, index) => ({
            __typename: 'TagEdge' as const,
            node: { __typename: 'TagType' as const, id: `tag-${index}`, label },
          })),
        },
      },
    },
    maxUsageCount: 20,
  };
}

function renderPlaces(mocks: MockedResponse[], tagSuggestions: string[] = []) {
  return renderWithProviders(<PlacesPage />, {
    mocks: [tagSuggestionsMock(tagSuggestions), ...mocks],
  });
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

function knownPlacesMock(
  overrides: {
    knownPlaces?: unknown[];
    knownPlaceCandidates?: unknown[];
    geocodingConfigured?: boolean;
  } = {},
) {
  return {
    request: { query: GET_KNOWN_PLACES },
    result: {
      data: {
        geocodingConfigured: overrides.geocodingConfigured ?? true,
        knownPlaces: overrides.knownPlaces ?? [],
        knownPlaceCandidates: overrides.knownPlaceCandidates ?? [],
      },
    },
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'KnownPlaceCandidateType' as const,
    locationId: 'loc-1',
    label: 'Corner Cafe',
    kind: 'other',
    lat: 37.7749,
    lng: -122.4194,
    eventCount: 12,
    presenceDays: 0,
    presenceNights: 0,
    confidence: 0.8,
    sampleEvents: [] as Array<{ id: string; title: string; startTime: string }>,
    ...overrides,
  };
}

function knownPlace(overrides: Record<string, unknown> = {}) {
  const kind = typeof overrides.kind === 'string' ? overrides.kind : 'home';

  return {
    __typename: 'KnownPlaceType' as const,
    id: 'kp-1',
    locationId: 'loc-home',
    label: 'Home',
    kind,
    confidence: 1,
    source: 'confirmed',
    activeFrom: null,
    activeTo: null,
    aliases: [],
    tags: [kind],
    coordinates: { __typename: 'KnownPlaceCoordinates' as const, lat: 37.7, lng: -122.4 },
    ...overrides,
  };
}

/**
 * `/places/:id` carries the RAW uuid — `PlacePage` re-encodes it with
 * `GlobalUID.encode('place', id)` before querying. GraphQL `id` fields are
 * global ids (base64 `place:<uuid>`), so routing with one unchanged makes
 * `PlacePage` encode an already-encoded id and render "Place not found".
 */
const PLACE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6fd';
const PLACE_GLOBAL_ID = btoa(`place:${PLACE_UUID}`);

function placeEdge({
  id = PLACE_GLOBAL_ID,
  name = 'Bletchley Park',
  visitStats,
}: { id?: string; name?: string; visitStats?: Record<string, unknown> } = {}) {
  return {
    __typename: 'PlaceEdge' as const,
    cursor: id,
    node: {
      __typename: 'PlaceType' as const,
      id,
      name,
      description: null,
      placeKind: null,
      latitude: null,
      longitude: null,
      parent: null,
      visitStats: visitStats ?? {
        __typename: 'PlaceVisitStatsType' as const,
        visitCount: 0,
        firstVisitAt: null,
        lastVisitAt: null,
        status: 'confirmed' as const,
      },
      tags: [],
    },
  };
}

function placesMock({
  totalCount = 1,
  hasNextPage = false,
  after,
  edges = [placeEdge()],
}: {
  totalCount?: number;
  hasNextPage?: boolean;
  after?: string;
  edges?: ReturnType<typeof placeEdge>[];
} = {}) {
  return {
    request: {
      query: GET_PLACES,
      variables: { query: null, first: PAGE_SIZE, ...(after == null ? {} : { after }) },
    },
    result: {
      data: {
        places: {
          __typename: 'PlaceConnection' as const,
          totalCount,
          pageInfo: pageInfo({ hasNextPage, endCursor: hasNextPage ? edges.at(-1)?.cursor : null }),
          edges,
        },
      },
    },
  };
}

const mocks = [placesMock(), knownPlacesMock(), noDuplicatesMock()];

describe('PlacesPage', () => {
  afterEach(() => setViewport(false));

  it('opens the drawer route (decoded uuid, not the global id) when a place row is clicked, not the full page', async () => {
    navigate.mockClear();
    renderPlaces(mocks);

    fireEvent.click(await screen.findByText('Bletchley Park'));

    expect(navigate).toHaveBeenCalledWith(`/memory/places/${PLACE_UUID}`);
    expect(navigate).not.toHaveBeenCalledWith(`/places/${PLACE_UUID}`);
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining(PLACE_GLOBAL_ID));
  });

  /**
   * Regression: the query asked for a fixed `first: 500` while the header
   * rendered `totalCount`, so on 1,179 places the page announced a number and
   * then withheld 679 of them with no "load more" and no explanation.
   */
  it('says how many of the counted places are actually listed', async () => {
    renderPlaces([
      placesMock({ totalCount: 1179, hasNextPage: true }),
      knownPlacesMock(),
      noDuplicatesMock(),
    ]);

    expect(await screen.findByText('Bletchley Park')).toBeInTheDocument();
    expect(screen.getByText('1179 places')).toBeInTheDocument();
    // The header count no longer stands alone — the footer says what is loaded.
    expect(screen.getByText(/loaded/).textContent).toContain('1 of 1179 loaded');
  });

  /**
   * A zero-visit place used to render identically to "0 visits" whether that
   * was a genuine measurement or enrichment hadn't finished linking events to
   * it yet. `status: 'pending_enrichment'` must read differently.
   */
  it('shows "Visits pending" instead of "0 visits" for a place not yet enriched', async () => {
    renderPlaces([
      noDuplicatesMock(),
      placesMock({
        edges: [
          placeEdge({
            visitStats: {
              __typename: 'PlaceVisitStatsType',
              visitCount: 0,
              firstVisitAt: null,
              lastVisitAt: null,
              status: 'pending_enrichment',
            },
          }),
        ],
      }),
      knownPlacesMock(),
    ]);

    expect(await screen.findByText('Bletchley Park')).toBeInTheDocument();
    expect(screen.getByText('Visits pending')).toBeInTheDocument();
    expect(screen.queryByText('0 visits')).not.toBeInTheDocument();
  });

  it('still shows "0 visits" for a confirmed zero — enrichment being caught up is not enough to hide it', async () => {
    renderPlaces(mocks);

    expect(await screen.findByText('Bletchley Park')).toBeInTheDocument();
    expect(screen.getByText('0 visits')).toBeInTheDocument();
  });

  it('appends the next page when the sentinel scrolls into view', async () => {
    const SECOND_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6fe';
    const SECOND_GLOBAL_ID = btoa(`place:${SECOND_UUID}`);
    const observer = captureIntersectionObserver();

    try {
      renderPlaces([
        noDuplicatesMock(),
        placesMock({ totalCount: 2, hasNextPage: true }),
        placesMock({
          totalCount: 2,
          after: PLACE_GLOBAL_ID,
          edges: [placeEdge({ id: SECOND_GLOBAL_ID, name: 'Enigma Cottage' })],
        }),
        knownPlacesMock(),
      ]);

      expect(await screen.findByText('Bletchley Park')).toBeInTheDocument();
      expect(screen.queryByText('Enigma Cottage')).not.toBeInTheDocument();

      await observer.scrollSentinelIntoView();

      expect(await screen.findByText('Enigma Cottage')).toBeInTheDocument();
      expect(screen.getByText('Bletchley Park')).toBeInTheDocument();
      expect(screen.getByText(/loaded/).textContent).toContain('2 of 2 loaded · end');
    } finally {
      observer.restore();
    }
  });

  /**
   * The error branch used to reuse the same confident EmptyState the genuine
   * "No places found" branch renders — a fetch failure read identically to
   * "you have none", with no way to retry. It must render the shared
   * ErrorState instead, with a Try again button that actually refetches.
   */
  it('shows the shared ErrorState with a working retry when the query fails, not a silent empty state', async () => {
    renderPlaces([
      {
        request: { query: GET_PLACES, variables: { query: null, first: PAGE_SIZE } },
        error: new Error('network down'),
      },
      // Consumed only after a successful retry remounts the rest of the page.
      knownPlacesMock(),
      noDuplicatesMock(),
      placesMock(),
    ]);

    expect(await screen.findByText('Could not load places')).toBeInTheDocument();
    expect(
      screen.getByText('Your places are still here — this device could not reach them just now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load places:/)).not.toBeInTheDocument();
    expect(screen.queryByText('No places found')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Bletchley Park')).toBeInTheDocument();
  });

  describe('KnownPlacesCard', () => {
    /**
     * Every candidate defaults to "Unknown place", kind "other", when
     * reverse-geocoding hasn't named it — which used to read as a fact about
     * the places rather than as configuration work not yet done.
     */
    it('explains why candidates are unnamed when geocoding is not configured', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({ knownPlaceCandidates: [candidate()], geocodingConfigured: false }),
      ]);

      expect(await screen.findByDisplayValue('Corner Cafe')).toBeInTheDocument();
      expect(screen.getByText(/Geocoding isn.t configured/)).toBeInTheDocument();
    });

    it('says nothing about geocoding once it is configured', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({ knownPlaceCandidates: [candidate()], geocodingConfigured: true }),
      ]);

      expect(await screen.findByDisplayValue('Corner Cafe')).toBeInTheDocument();
      expect(screen.queryByText(/Geocoding isn.t configured/)).not.toBeInTheDocument();
    });

    it('saves multiple selected tags and lets the newest default category control the semantic role', async () => {
      renderPlaces(
        [
          noDuplicatesMock(),
          emptyPlacesMock(),
          knownPlacesMock({ knownPlaceCandidates: [candidate()] }),
          {
            request: {
              query: CONFIRM_KNOWN_PLACE,
              variables: {
                input: {
                  label: 'Corner Cafe (Office)',
                  kind: 'work',
                  tags: ['other', 'work', 'client'],
                  locationId: 'loc-1',
                  coordinates: { lat: 37.7749, lng: -122.4194 },
                  confidence: 0.8,
                  source: 'inferred',
                },
              },
            },
            result: {
              data: {
                updateKnownPlace: {
                  __typename: 'KnownPlaceType' as const,
                  id: 'kp-2',
                  label: 'Corner Cafe (Office)',
                  kind: 'work',
                  tags: ['other', 'work', 'client'],
                },
              },
            },
          },
          // Post-mutation refetch: the candidate is now a confirmed known place,
          // and the server no longer returns it as a candidate.
          knownPlacesMock({
            knownPlaces: [
              knownPlace({
                id: 'kp-2',
                locationId: 'loc-1',
                label: 'Corner Cafe (Office)',
                kind: 'work',
                tags: ['other', 'work', 'client'],
              }),
            ],
            knownPlaceCandidates: [],
          }),
        ],
        ['client'],
      );

      const nameInput = await screen.findByDisplayValue('Corner Cafe');
      fireEvent.change(nameInput, { target: { value: 'Corner Cafe (Office)' } });
      const tagInput = screen.getByRole('textbox', {
        name: 'Categories and tags for Corner Cafe (Office)',
      });
      fireEvent.focus(tagInput);
      fireEvent.click(await screen.findByRole('button', { name: 'work' }));
      fireEvent.focus(tagInput);
      fireEvent.click(await screen.findByRole('button', { name: 'client' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('Corner Cafe (Office)')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      });
    });

    it('starts an "Unknown place" candidate with an empty name and will not save until one is typed', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({
          knownPlaceCandidates: [
            candidate({
              locationId: null,
              label: 'Unknown place',
              kind: 'other',
              lat: 34.0769,
              lng: -118.4744,
              sampleEvents: [
                { id: 'evt-1', title: 'Morning coffee', startTime: '2026-08-19T15:00:00.000Z' },
                { id: 'evt-2', title: 'Evening walk', startTime: '2026-08-18T02:00:00.000Z' },
              ],
            }),
          ],
        }),
      ]);

      const nameInput = await screen.findByPlaceholderText('Name this place');
      expect(nameInput).toHaveValue('');
      // The coordinates are the only handle the user has on an unnamed cluster.
      // The supporting events open from the map pin, not a list under the name.
      expect(screen.getByText(/near 34\.0769, -118\.4744/)).toBeInTheDocument();
      expect(screen.queryByText(/Morning coffee/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Evening walk/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.change(nameInput, { target: { value: '   ' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.change(nameInput, { target: { value: 'Home' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.getByText('other')).toBeInTheDocument();
    });

    it('drops a labelled pin on the map when a candidate is located, and lifts it when toggled off', async () => {
      renderPlaces([
        noDuplicatesMock(),
        // No places with coordinates, so the map is absent until a pin asks for it.
        emptyPlacesMock(),
        knownPlacesMock({
          knownPlaceCandidates: [
            candidate({
              locationId: null,
              label: 'Unknown place',
              kind: 'other',
              lat: 34.0769,
              lng: -118.4744,
            }),
          ],
        }),
      ]);

      const locate = await screen.findByRole('button', { name: 'Locate' });
      expect(locate).toHaveAttribute('aria-pressed', 'false');
      // The candidate is already a pin, so the map is up before Locate highlights it.
      await waitFor(() => {
        expect(document.querySelector('.leaflet-container')).not.toBeNull();
      });
      expect(screen.getByTestId('map-root')).toHaveClass('[&_.leaflet-control-attribution]:opacity-[0.65]');
      expect(document.querySelector('.leaflet-control-attribution')).not.toBeNull();
      expect(screen.queryByTestId('mobile-map-attribution')).not.toBeInTheDocument();
      expect(screen.queryByText('Unknown place · 12 events')).not.toBeInTheDocument();

      fireEvent.click(locate);

      expect(screen.getByRole('button', { name: 'Located' })).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => {
        expect(document.querySelector('.leaflet-container')).not.toBeNull();
      });
      expect(await screen.findByText('Unknown place · 12 events')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Located' }));

      expect(screen.getByRole('button', { name: 'Locate' })).toHaveAttribute('aria-pressed', 'false');
      await waitFor(() => {
        expect(screen.queryByText('Unknown place · 12 events')).not.toBeInTheDocument();
      });
    });

    it('says what a GPS-only candidate rests on, in its row and on its pin, instead of "0 events"', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({
          knownPlaceCandidates: [
            candidate({
              locationId: null,
              label: 'Unknown place',
              kind: 'home',
              lat: 35.66,
              lng: 139.75,
              eventCount: 0,
              presenceDays: 172,
              presenceNights: 12,
            }),
          ],
        }),
      ]);

      expect(
        await screen.findByText(/^GPS on 172 days \(12 nights\) near 35\.6600, 139\.7500$/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/0 events/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Locate' }));

      expect(await screen.findByText('Unknown place · GPS on 172 days (12 nights)')).toBeInTheDocument();
    });

    it('opens the place details from an unknown place pin when that cluster is already a place', async () => {
      navigate.mockClear();
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({
          knownPlaceCandidates: [
            candidate({
              locationId: PLACE_UUID,
              label: 'Unknown place',
              lat: 34.0769,
              lng: -118.4744,
            }),
          ],
        }),
      ]);

      await screen.findByPlaceholderText('Name this place');
      await waitFor(() => {
        expect(document.querySelector('.leaflet-marker-icon')).not.toBeNull();
      });

      fireEvent.click(document.querySelector('.leaflet-marker-icon') as Element);

      expect(navigate).toHaveBeenCalledWith(`/memory/places/${PLACE_UUID}`);
    });

    it('shows a real error and keeps the candidate listed when the confirm mutation fails', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({ knownPlaceCandidates: [candidate()] }),
        {
          request: {
            query: CONFIRM_KNOWN_PLACE,
            variables: {
              input: {
                label: 'Corner Cafe',
                kind: 'other',
                tags: ['other'],
                locationId: 'loc-1',
                coordinates: { lat: 37.7749, lng: -122.4194 },
                confidence: 0.8,
                source: 'inferred',
              },
            },
          },
          error: new Error('locationId already claimed'),
        },
      ]);

      expect(await screen.findByDisplayValue('Corner Cafe')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('locationId already claimed')).toBeInTheDocument();
      // The failed candidate is still there to retry, not silently dropped.
      expect(screen.getByDisplayValue('Corner Cafe')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });

    it('accepts a typed custom-only category and maps its semantic role to other', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({ knownPlaceCandidates: [candidate()] }),
        {
          request: {
            query: CONFIRM_KNOWN_PLACE,
            variables: {
              input: {
                label: 'Corner Cafe',
                kind: 'other',
                tags: ['gym'],
                locationId: 'loc-1',
                coordinates: { lat: 37.7749, lng: -122.4194 },
                confidence: 0.8,
                source: 'inferred',
              },
            },
          },
          result: {
            data: {
              updateKnownPlace: {
                __typename: 'KnownPlaceType' as const,
                id: 'kp-gym',
                label: 'Corner Cafe',
                kind: 'other',
                tags: ['gym'],
              },
            },
          },
        },
        knownPlacesMock({
          knownPlaces: [
            knownPlace({
              id: 'kp-gym',
              locationId: 'loc-1',
              label: 'Corner Cafe',
              kind: 'other',
              tags: ['gym'],
            }),
          ],
          knownPlaceCandidates: [],
        }),
      ]);

      await screen.findByDisplayValue('Corner Cafe');
      fireEvent.click(screen.getByRole('button', { name: 'Remove tag “other”' }));

      const tagInput = screen.getByPlaceholderText('Add category or tag…');
      fireEvent.change(tagInput, { target: { value: 'gym' } });
      fireEvent.submit(tagInput.closest('form')!);

      expect(await screen.findByRole('button', { name: 'Remove tag “gym”' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      });
    });

    it('creates a typed custom tag and offers it on the next mobile review item', async () => {
      setViewport(true);
      const first = candidate({ locationId: 'loc-first', label: 'First Place' });
      const second = candidate({
        locationId: 'loc-second',
        label: 'Second Place',
        lat: 40,
        lng: -120,
      });

      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({ knownPlaceCandidates: [first, second] }),
        {
          request: {
            query: CONFIRM_KNOWN_PLACE,
            variables: {
              input: {
                label: 'First Place',
                kind: 'other',
                tags: ['other', 'family'],
                locationId: 'loc-first',
                coordinates: { lat: 37.7749, lng: -122.4194 },
                confidence: 0.8,
                source: 'inferred',
              },
            },
          },
          result: {
            data: {
              updateKnownPlace: {
                __typename: 'KnownPlaceType' as const,
                id: 'kp-first',
                label: 'First Place',
                kind: 'other',
                tags: ['other', 'family'],
              },
            },
          },
        },
        knownPlacesMock({
          knownPlaces: [
            knownPlace({
              id: 'kp-first',
              locationId: 'loc-first',
              label: 'First Place',
              kind: 'other',
              tags: ['other', 'family'],
              coordinates: {
                __typename: 'KnownPlaceCoordinates' as const,
                lat: 37.7749,
                lng: -122.4194,
              },
            }),
          ],
          knownPlaceCandidates: [second],
        }),
      ]);

      await screen.findByDisplayValue('First Place');
      const firstTagInput = screen.getByRole('textbox', {
        name: 'Categories and tags for First Place',
      });
      fireEvent.change(firstTagInput, { target: { value: 'family' } });
      fireEvent.submit(firstTagInput.closest('form')!);
      expect(await screen.findByRole('button', { name: 'Remove tag “family”' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByDisplayValue('Second Place')).toBeInTheDocument();
      const secondTagInput = screen.getByRole('textbox', {
        name: 'Categories and tags for Second Place',
      });
      fireEvent.focus(secondTagInput);

      expect(await screen.findByRole('button', { name: 'family' })).toBeInTheDocument();
    });

    it('starts legacy known places with their semantic tag and safely recategorizes by relationship id', async () => {
      setViewport(true);
      const legacy = knownPlace({ tags: [] });
      const recategorized = knownPlace({ kind: 'school', tags: ['home', 'school'] });

      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({ knownPlaces: [legacy] }),
        {
          request: {
            query: CONFIRM_KNOWN_PLACE,
            variables: {
              input: {
                knownPlaceId: 'kp-1',
                label: 'Home',
                kind: 'school',
                tags: ['home', 'school'],
                locationId: 'loc-home',
                coordinates: { lat: 37.7, lng: -122.4 },
                confidence: 1,
                activeTo: null,
                aliases: [],
                source: 'confirmed',
              },
            },
          },
          result: {
            data: {
              updateKnownPlace: {
                __typename: 'KnownPlaceType' as const,
                id: 'kp-1',
                label: 'Home',
                kind: 'school',
                tags: ['home', 'school'],
              },
            },
          },
        },
        knownPlacesMock({ knownPlaces: [recategorized] }),
      ]);

      expect(await screen.findByText('Known places')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Categories and tags for Home' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Show$/ }));

      const tagInput = await screen.findByRole('textbox', {
        name: 'Categories and tags for Home',
      });
      expect(screen.getByRole('button', { name: 'Remove tag “home”' })).toBeInTheDocument();
      fireEvent.focus(tagInput);
      fireEvent.click(await screen.findByRole('button', { name: 'school' }));

      expect(await screen.findByRole('button', { name: 'Remove tag “school”' })).toBeInTheDocument();
    });

    it('progressively reveals mobile review queues and keeps the map ahead of the full list', async () => {
      setViewport(true);
      renderPlaces([
        noDuplicatesMock(),
        placesMock({ totalCount: 0, edges: [] }),
        knownPlacesMock({
          knownPlaceCandidates: [
            candidate({ locationId: 'candidate-a', label: 'Candidate A', lat: 1, lng: 1 }),
            candidate({ locationId: 'candidate-b', label: 'Candidate B', lat: 2, lng: 2 }),
            candidate({ locationId: 'candidate-c', label: 'Candidate C', lat: 3, lng: 3 }),
          ],
          knownPlaces: [
            knownPlace({ id: 'known-a', locationId: 'known-location-a', label: 'Saved A' }),
            knownPlace({ id: 'known-b', locationId: 'known-location-b', label: 'Saved B' }),
            knownPlace({ id: 'known-c', locationId: 'known-location-c', label: 'Saved C' }),
            knownPlace({ id: 'known-d', locationId: 'known-location-d', label: 'Saved D' }),
          ],
        }),
      ]);

      expect(await screen.findByDisplayValue('Candidate A')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Candidate B')).not.toBeInTheDocument();
      const locate = screen.getByRole('button', { name: 'Locate' });
      expect(locate.parentElement).toHaveClass('grid-cols-2');

      fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
      expect(await screen.findByDisplayValue('Candidate C')).toBeInTheDocument();

      expect(screen.queryByText('Saved A')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Show$/ }));
      expect(await screen.findByText('Saved C')).toBeInTheDocument();
      expect(screen.queryByText('Saved D')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
      expect(await screen.findByText('Saved D')).toBeInTheDocument();

      const review = screen.getByText('Needs review');
      const known = screen.getByText('Known places');
      expect(review.closest('[data-slot="card"]')).toHaveClass('py-0');
      expect(known.closest('[data-slot="card"]')).toHaveClass('py-0');
      const map = document.querySelector('.leaflet-container');
      const allPlaces = screen.getByText('All places');
      expect(document.querySelector('.leaflet-control-attribution')).toBeNull();
      expect(screen.getByTestId('mobile-map-attribution')).toHaveTextContent(
        'Leaflet | Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      );
      expect(review.compareDocumentPosition(known) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(known.compareDocumentPosition(map!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(map!.compareDocumentPosition(allPlaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('hides a candidate that duplicates an already-confirmed place by name or by nearby coordinates', async () => {
      renderPlaces([
        noDuplicatesMock(),
        emptyPlacesMock(),
        knownPlacesMock({
          knownPlaces: [
            knownPlace({ id: 'kp-home', locationId: 'loc-home', label: 'Home', kind: 'home' }),
            knownPlace({
              id: 'kp-work',
              locationId: 'loc-work',
              label: 'Acme Corp',
              kind: 'work',
              coordinates: { __typename: 'KnownPlaceCoordinates' as const, lat: 37.8, lng: -122.5 },
            }),
          ],
          knownPlaceCandidates: [
            // Same label as the confirmed "Home", different casing, no shared
            // locationId — must still be recognised as a duplicate.
            candidate({ locationId: 'loc-2', label: 'home', lat: 10, lng: 10 }),
            // ~11m from the confirmed "Acme Corp" coordinates — well inside the
            // 150m proximity match, no shared label.
            candidate({ locationId: 'loc-3', label: 'Acme Corp Annex', lat: 37.8001, lng: -122.5001 }),
            // A genuinely new place: neither label nor location overlaps.
            candidate({ locationId: 'loc-4', label: 'New Bakery', lat: 1, lng: 1 }),
          ],
        }),
      ]);

      expect(await screen.findByDisplayValue('New Bakery')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('home')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('Acme Corp Annex')).not.toBeInTheDocument();
    });
  });
});
