import { Sheet } from '@ci/shadcn';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { EntityDrawerHostProvider } from './drawerHost';
import { EventDetails } from './EventDetails';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints; the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

/** A photo event linked by `promote.place` to a reverse-geocoded place. */
function photoAtPlace() {
  return {
    __typename: 'EventType' as const,
    id: btoa('event:01a17686-4703-735d-9dc7-98cea86ed33d'),
    title: 'PXL_20261022_125400_018.jpg',
    description: null,
    startTime: '2026-10-22T12:54:00.000Z',
    endTime: null,
    eventType: 'media',
    sourceSystem: 'generic',
    tags: [],
    contents: { edges: [] },
    mapCoordinates: { type: 'Point', coordinates: [-122.393617, 37.795353] },
    location: {
      __typename: 'PlaceType' as const,
      id: btoa('place:01a1777c-bcc9-7efb-acc7-179bc5264939'),
      name: 'The Embarcadero & Ferry Building',
      // The typed pair is the place's location_point at full precision; the
      // bag's `lat`/`lng` are the geocoder's 3-decimal snap cell.
      latitude: 37.795412 as number | null,
      longitude: -122.393781 as number | null,
      properties: {
        lat: 37.795,
        lng: -122.394,
        type: 'address',
        source: 'reverse_geocode',
        place_id: 'ChIJibSPmmaAhYARm8omtXU9Go8',
        promote: {
          at: '2026-10-26T10:25:28.80773+00:00',
          stage: 'promote.place',
          version: 1,
          boundary_metres: 55.66,
        },
      } as Record<string, unknown>,
    },
  };
}

function renderLocationCard(entity: ReturnType<typeof photoAtPlace>) {
  renderWithProviders(
    <EntityDrawerHostProvider value={host}>
      <Sheet open>
        <EventDetails entity={entity as never} />
      </Sheet>
    </EntityDrawerHostProvider>,
  );

  // Scoped to the Location card: the drawer's Raw data panel shows the whole record on purpose.
  return within(screen.getByRole('heading', { name: 'Location' }).closest('section')!);
}

describe('EventDetails location', () => {
  it('names the place and its coordinates without the place record’s internal fields', () => {
    const location = renderLocationCard(photoAtPlace());

    expect(location.getByText('The Embarcadero & Ferry Building')).toBeInTheDocument();
    expect(location.getByText('37.795353, -122.393617')).toBeInTheDocument();

    for (const label of ['Promote', 'Source', 'Place Id', 'Lat', 'Lng', 'Type']) {
      expect(location.queryByText(label, { exact: true })).not.toBeInTheDocument();
    }

    expect(location.queryByText(/promote\.place/)).not.toBeInTheDocument();
    expect(location.queryByText('reverse_geocode')).not.toBeInTheDocument();
    expect(location.queryByText('ChIJibSPmmaAhYARm8omtXU9Go8')).not.toBeInTheDocument();
  });

  it('falls back to the place’s full-precision point when the event has no point of its own', () => {
    const location = renderLocationCard({ ...photoAtPlace(), mapCoordinates: null as never });

    expect(location.getByText('The Embarcadero & Ferry Building')).toBeInTheDocument();
    expect(location.getByText('37.795412, -122.393781')).toBeInTheDocument();
    expect(location.queryByText('37.795000, -122.394000')).not.toBeInTheDocument();
    expect(location.queryByText('Lat', { exact: true })).not.toBeInTheDocument();
  });

  it('shows a hand-made place’s coordinate, which lives only in its location_point', () => {
    const event = photoAtPlace();
    const location = renderLocationCard({
      ...event,
      mapCoordinates: null as never,
      location: { ...event.location, properties: { address: '1 Ferry Building, San Francisco' } },
    });

    expect(location.getByText('1 Ferry Building, San Francisco')).toBeInTheDocument();
    expect(location.getByText('37.795412, -122.393781')).toBeInTheDocument();
  });

  it('uses the bag’s `lat`/`lng` only when the place has no typed point', () => {
    const event = photoAtPlace();
    const location = renderLocationCard({
      ...event,
      mapCoordinates: null as never,
      location: { ...event.location, latitude: null, longitude: null },
    });

    expect(location.getByText('37.795000, -122.394000')).toBeInTheDocument();
  });

  it('skips an address that is not a string instead of crashing the drawer', () => {
    const event = photoAtPlace();
    const location = renderLocationCard({
      ...event,
      location: { ...event.location, properties: { address: { street: '1 Ferry Building' } } },
    });

    expect(location.queryByText('Address', { exact: true })).not.toBeInTheDocument();
    expect(location.getByText('37.795353, -122.393617')).toBeInTheDocument();
  });
});
