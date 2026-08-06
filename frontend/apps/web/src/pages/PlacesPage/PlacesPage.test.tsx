import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PlacesPage } from './PlacesPage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const GET_PLACES = gql(`
  query GetPlaces($query: String) {
    places(query: $query, first: 500) {
      totalCount
      edges {
        node {
          id
          name
          description
          placeKind
          latitude
          longitude
          parent {
            id
            name
            placeKind
          }
          visitStats {
            visitCount
            firstVisitAt
            lastVisitAt
          }
        }
      }
    }
  }
`);

const GET_KNOWN_PLACES = gql(`
  query GetKnownPlaces {
    knownPlaces {
      id
      locationId
      label
      kind
      confidence
      source
      coordinates {
        lat
        lng
      }
    }
    knownPlaceCandidates {
      locationId
      label
      kind
      lat
      lng
      eventCount
      confidence
    }
  }
`);

/**
 * `/places/:id` carries the RAW uuid — `PlacePage` re-encodes it with
 * `GlobalUID.encode('place', id)` before querying. GraphQL `id` fields are
 * global ids (base64 `place:<uuid>`), so routing with one unchanged makes
 * `PlacePage` encode an already-encoded id and render "Place not found".
 */
const PLACE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6fd';
const PLACE_GLOBAL_ID = btoa(`place:${PLACE_UUID}`);

const mocks = [
  {
    request: { query: GET_PLACES, variables: { query: null } },
    result: {
      data: {
        places: {
          __typename: 'PlaceConnection' as const,
          totalCount: 1,
          edges: [
            {
              __typename: 'PlaceEdge' as const,
              node: {
                __typename: 'PlaceType' as const,
                id: PLACE_GLOBAL_ID,
                name: 'Bletchley Park',
                description: null,
                placeKind: null,
                latitude: null,
                longitude: null,
                parent: null,
                visitStats: {
                  __typename: 'PlaceVisitStatsType' as const,
                  visitCount: 0,
                  firstVisitAt: null,
                  lastVisitAt: null,
                },
              },
            },
          ],
        },
      },
    },
  },
  {
    request: { query: GET_KNOWN_PLACES },
    result: { data: { knownPlaces: [], knownPlaceCandidates: [] } },
  },
];

describe('PlacesPage', () => {
  it('routes to the decoded uuid, not the global id, when a place row is opened', async () => {
    navigate.mockClear();
    renderWithProviders(<PlacesPage />, { mocks });

    fireEvent.click(await screen.findByText('Bletchley Park'));

    expect(navigate).toHaveBeenCalledWith(`/places/${PLACE_UUID}`);
    expect(navigate).not.toHaveBeenCalledWith(`/places/${PLACE_GLOBAL_ID}`);
  });
});
