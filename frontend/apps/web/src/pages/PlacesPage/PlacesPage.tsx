import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { Badge, Button, Card, Input } from '@ci/shadcn';
import { LocateFixed, MapPin, Plus } from '@ci/shadcn/icons';
import { Tooltip, useMap as useLeafletMap } from 'react-leaflet';
import { useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';

import { ChatAbout } from '@/components/ChatWithAgent';
import { ErrorState } from '@/components/ErrorState';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { Map } from '@/components/Map';
import { MemoryHubShell } from '@/components/MemoryHub';
import { AddPlaceModal } from '@/components/modals/AddItemModal';
import { PLACE_KIND_LABELS } from '@/components/PlaceForm';
import { PullToRefresh } from '@/components/PullToRefresh';
import { gql } from '@/graphql';
import type { GetKnownPlacesQuery, GetPlacesQuery } from '@/graphql/graphql';
import { useModalControls } from '@/hooks';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';
import { namedChatContext } from '@/lib/agentChat';

import { PlaceDuplicatesCard } from './PlaceDuplicatesCard';
import { PlaceSheet } from './PlaceSheet';

/**
 * Each row costs a `visitStats` aggregate, so this stays well under the old
 * fixed `first: 500` — the rest now arrives by scrolling instead of being
 * silently withheld.
 */
export const PAGE_SIZE = 200;

/**
 * Leaflet degrades badly past a few hundred individual markers. The cap stays,
 * but the page now says so instead of quietly dropping pins.
 */
const MAX_MAP_MARKERS = 300;

const GET_PLACES = gql(`
  query GetPlaces($query: String, $first: Int, $after: String) {
    places(query: $query, first: $first, after: $after) {
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
            status
          }
        }
      }
    }
  }
`);

const GET_KNOWN_PLACES = gql(`
  query GetKnownPlaces {
    geocodingConfigured
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
      sampleEvents {
        id
        title
        startTime
      }
    }
  }
`);

const CONFIRM_KNOWN_PLACE = gql(`
  mutation ConfirmKnownPlace($input: UpdateKnownPlaceInput!) {
    updateKnownPlace(input: $input) {
      id
      label
      kind
    }
  }
`);

type PlaceNode = GetPlacesQuery['places']['edges'][number]['node'];

function formatDate(value: string | Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

function PlaceRow({ place, onOpen }: { place: PlaceNode; onOpen: () => void }) {
  const lastVisit = formatDate(place.visitStats.lastVisitAt);

  return (
    <ChatAbout
      context={namedChatContext({
        title: place.name,
        body: [place.parent?.name, place.description, place.placeKind].filter(Boolean).join(' · ') || null,
        sourceKind: 'PlaceType',
        sourceId: place.id,
      })}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left transition hover:bg-accent"
      >
        <MapPin className="h-5 w-5 shrink-0 text-muted-foreground" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{place.name || 'Unnamed place'}</span>
            {place.placeKind && (
              <Badge variant="secondary">{PLACE_KIND_LABELS[place.placeKind] ?? place.placeKind}</Badge>
            )}
          </div>

          <div className="truncate text-sm text-muted-foreground">
            {[place.parent?.name, place.description].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>

        <div className="hidden shrink-0 text-right text-sm text-muted-foreground sm:block">
          {place.visitStats.visitCount === 0 && place.visitStats.status === 'pending_enrichment' ? (
            // A zero here isn't yet a measurement (geocoding unconfigured, or
            // this place's events haven't finished linking) — distinct from a
            // place that is genuinely never visited, which reads "0 visits".
            <div title="Geocoding isn't finished linking events to this place yet">Visits pending</div>
          ) : (
            <div>
              {place.visitStats.visitCount} {place.visitStats.visitCount === 1 ? 'visit' : 'visits'}
            </div>
          )}
          {lastVisit && <div>Last {lastVisit}</div>}
        </div>
      </button>
    </ChatAbout>
  );
}

/** Rough metres between two lat/lng pairs (equirectangular is plenty here). */
function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const x = toRad(bLng - aLng) * Math.cos(toRad((aLat + bLat) / 2));
  const y = toRad(bLat - aLat);

  return Math.sqrt(x * x + y * y) * 6371000;
}

/** A candidate within this radius of a confirmed place is that place. */
const CONFIRMED_MATCH_METERS = 150;

/** The roles the API accepts for a known place (KnownPlacesResolver.KNOWN_PLACE_KINDS). */
const KNOWN_PLACE_KINDS = ['home', 'work', 'school', 'social', 'other'] as const;
type KnownPlaceKind = (typeof KNOWN_PLACE_KINDS)[number];

const KNOWN_PLACE_KIND_LABELS: Record<KnownPlaceKind, string> = {
  home: 'Home',
  work: 'Work',
  school: 'School',
  social: 'Social',
  other: 'Other',
};

/** The server's label for a cluster it could not name — never worth saving verbatim. */
const UNNAMED_CANDIDATE_LABEL = 'unknown place';

function isKnownPlaceKind(kind: string): kind is KnownPlaceKind {
  return (KNOWN_PLACE_KINDS as readonly string[]).includes(kind);
}

interface KnownPlaceCandidateDraft {
  label: string;
  kind: KnownPlaceKind;
}

type KnownPlaceCandidate = NonNullable<GetKnownPlacesQuery['knownPlaceCandidates']>[number];

/**
 * A candidate the user asked to see on the map. Unnamed candidates are only
 * ever shown as coordinates, which nobody can place by eye — the pin is how
 * they find out which cluster is the office and which is the gym.
 */
export interface LocatedCandidate {
  lat: number;
  lng: number;
  label: string;
  eventCount: number;
}

/** Close enough to read street-level context around one cluster. */
const LOCATE_ZOOM = 16;

/**
 * `MapContainer`'s `center` is only the initial view, so moving the map after
 * mount has to go through the Leaflet instance. Lives inside `<Map>` so it can
 * reach it.
 */
function FlyToLocated({ target }: { target: LocatedCandidate | null }) {
  const map = useLeafletMap();

  useEffect(() => {
    if (target) {
      map.flyTo([target.lat, target.lng], LOCATE_ZOOM);
    }
  }, [map, target]);

  return null;
}

function sameSpot(a: LocatedCandidate | null, candidate: KnownPlaceCandidate): boolean {
  return a != null && a.lat === candidate.lat && a.lng === candidate.lng;
}

/**
 * One inferred place, editable before it is saved. The server can only guess
 * a name (often it can't — "Unknown place") and a role (usually "other"), so
 * confirming verbatim would just file a meaningless record; instead the row
 * asks for the name and role and saves those.
 */
function KnownPlaceCandidateRow({
  candidate,
  saving,
  located,
  onLocate,
  onSave,
}: {
  candidate: KnownPlaceCandidate;
  saving: boolean;
  /** Whether this row's pin is the one currently on the map. */
  located: boolean;
  onLocate: (candidate: KnownPlaceCandidate) => void;
  onSave: (candidate: KnownPlaceCandidate, draft: KnownPlaceCandidateDraft) => void;
}) {
  const unnamed = candidate.label.trim().toLowerCase() === UNNAMED_CANDIDATE_LABEL;
  const [label, setLabel] = useState(unnamed ? '' : candidate.label);
  const [kind, setKind] = useState<KnownPlaceKind>(
    isKnownPlaceKind(candidate.kind) ? candidate.kind : 'other',
  );
  const trimmed = label.trim();
  const inputId = `known-place-${candidate.locationId ?? `${candidate.lat},${candidate.lng}`}`;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="text-sm text-muted-foreground">
          {candidate.eventCount} events
          {unnamed ? ` near ${candidate.lat.toFixed(4)}, ${candidate.lng.toFixed(4)}` : ''} · looks like{' '}
          <span className="capitalize">{candidate.kind}</span>
        </label>
        <Input
          id={inputId}
          value={label}
          placeholder="Name this place"
          onChange={(event) => setLabel(event.target.value)}
          disabled={saving}
        />
        {candidate.sampleEvents.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {candidate.sampleEvents.map((event) => {
              const when = formatDate(event.startTime);

              return (
                <li key={event.id} className="truncate">
                  {event.title}
                  {when ? ` · ${when}` : ''}
                </li>
              );
            })}
            {candidate.eventCount > candidate.sampleEvents.length && (
              <li>and {candidate.eventCount - candidate.sampleEvents.length} more</li>
            )}
          </ul>
        )}
      </div>
      <select
        aria-label="Kind"
        value={kind}
        onChange={(event) => setKind(event.target.value as KnownPlaceKind)}
        disabled={saving}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
      >
        {KNOWN_PLACE_KINDS.map((option) => (
          <option key={option} value={option}>
            {KNOWN_PLACE_KIND_LABELS[option]}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant={located ? 'secondary' : 'ghost'}
        aria-pressed={located}
        title={located ? 'Remove the pin from the map' : 'Show this place on the map'}
        onClick={() => onLocate(candidate)}
      >
        <LocateFixed className="h-4 w-4" />
        {located ? 'Located' : 'Locate'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={saving || trimmed === ''}
        onClick={() => onSave(candidate, { label: trimmed, kind })}
      >
        Save
      </Button>
    </div>
  );
}

function KnownPlacesCard({
  located,
  onLocate,
}: {
  located: LocatedCandidate | null;
  onLocate: (candidate: LocatedCandidate | null) => void;
}) {
  const { data, refetch } = useQuery(GET_KNOWN_PLACES);
  const [confirmKnownPlace, { loading }] = useMutation(CONFIRM_KNOWN_PLACE);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const knownPlaces = useMemo(() => data?.knownPlaces ?? [], [data]);
  const confirmedLocationIds = useMemo(
    () => new Set(knownPlaces.map((place) => place.locationId)),
    [knownPlaces],
  );

  // Grid-cluster candidates always carry locationId: null and are regenerated
  // by every buildKnownPlaces call, so an id-only filter would show a
  // just-confirmed cluster forever. Also drop candidates that match a confirmed
  // place by label or by proximity to its coordinates.
  const candidates = useMemo(
    () =>
      (data?.knownPlaceCandidates ?? []).filter((candidate) => {
        if (candidate.locationId != null && confirmedLocationIds.has(candidate.locationId)) {
          return false;
        }

        return !knownPlaces.some((place) => {
          if (place.label.trim().toLowerCase() === candidate.label.trim().toLowerCase()) {
            return true;
          }

          const coordinates = place.coordinates;

          return (
            coordinates != null &&
            distanceMeters(coordinates.lat, coordinates.lng, candidate.lat, candidate.lng) <=
              CONFIRMED_MATCH_METERS
          );
        });
      }),
    [data, knownPlaces, confirmedLocationIds],
  );

  if (knownPlaces.length === 0 && candidates.length === 0) {
    return null;
  }

  const confirm = async (candidate: KnownPlaceCandidate, draft: KnownPlaceCandidateDraft) => {
    try {
      setConfirmError(null);
      await confirmKnownPlace({
        variables: {
          input: {
            label: draft.label,
            kind: draft.kind,
            locationId: candidate.locationId,
            coordinates: { lat: candidate.lat, lng: candidate.lng },
            confidence: candidate.confidence,
            source: 'inferred',
          },
        },
      });
      // The pin was a temporary aid for naming this cluster; once saved it
      // shows up as a confirmed place instead.
      if (sameSpot(located, candidate)) {
        onLocate(null);
      }

      await refetch();
    } catch (error) {
      setConfirmError(
        error instanceof Error ? error.message : 'Could not save that place. Please try again.',
      );
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Known places</Card.Title>
        <Card.Description>
          Frequent places detected from your events. Name them and pick what they are so home and work anchor
          your memory.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {confirmError && <div className="text-sm text-destructive">{confirmError}</div>}

        {data?.geocodingConfigured === false && candidates.length > 0 && (
          // Every candidate below defaults to "Unknown place · looks like
          // Other" when reverse-geocoding hasn't named it — which, without
          // this note, reads as a fact about the places rather than as
          // configuration work not yet done.
          <div className="text-sm text-muted-foreground">
            Geocoding isn&apos;t configured on this appliance, so these places haven&apos;t been named yet.
          </div>
        )}

        {knownPlaces.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {knownPlaces.map((place) => (
              <Badge key={place.id} variant="secondary" className="capitalize">
                {place.kind}: {place.label}
              </Badge>
            ))}
          </div>
        )}

        {candidates.slice(0, 6).map((candidate) => (
          <KnownPlaceCandidateRow
            key={`${candidate.locationId ?? ''}:${candidate.lat}:${candidate.lng}`}
            candidate={candidate}
            saving={loading}
            located={sameSpot(located, candidate)}
            onLocate={(target) =>
              onLocate(
                sameSpot(located, target)
                  ? null
                  : { lat: target.lat, lng: target.lng, label: target.label, eventCount: target.eventCount },
              )
            }
            onSave={(target, draft) => void confirm(target, draft)}
          />
        ))}
      </Card.Content>
    </Card>
  );
}

export function PlacesPage() {
  usePageTitle('Places - Companion Memory');

  const { isMobile } = useDeviceLayout();
  const navigate = useNavigate();
  const { placeId } = useParams<{ placeId: string }>();
  // The header search box's `?search=`: it edits this page's query in place
  // (see GlobalSearchBox / isLiveSearchPath), so the page has no input of its own.
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') ?? '';
  const [locatedCandidate, setLocatedCandidate] = useState<LocatedCandidate | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // Bring the map on screen when a pin is dropped: on narrow layouts it sits
  // below the candidate card, off the bottom of the viewport.
  useEffect(() => {
    if (locatedCandidate) {
      mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [locatedCandidate]);

  const [{ isOpen: isAddPlaceOpen }, { open: openAddPlace, close: closeAddPlace }] = useModalControls();

  const { data, previousData, loading, error, refetch, fetchMore } = useQuery(GET_PLACES, {
    variables: { query: searchQuery.trim() === '' ? null : searchQuery.trim(), first: PAGE_SIZE },
    notifyOnNetworkStatusChange: true,
  });

  // A hand-typed or stale id still encodes fine; the drawer simply stays
  // closed when the query returns nothing.
  const selectedGlobalId = useMemo(() => (placeId ? GlobalUID.encode('place', placeId) : null), [placeId]);
  // Same rule as the content library: the drawer is a path segment and the
  // filters are query params, so opening and closing carry `location.search`.
  const { search: queryString } = useLocation();
  const openPlace = useCallback(
    (globalId: string) => navigate(`/memory/places/${GlobalUID.parse('place', globalId)}${queryString}`),
    [navigate, queryString],
  );
  const closePlace = useCallback(() => navigate(`/memory/places${queryString}`), [navigate, queryString]);
  const handleChanged = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Keep the previous result rendered while a new query variable is in flight;
  // swapping to a full-page loader would unmount the search input and drop
  // focus on the first keystroke of every new query.
  const view = data ?? previousData;
  const places = useMemo(() => (view?.places.edges ?? []).map((edge) => edge.node), [view]);

  const fetchNextPage = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.places) {
            return prev;
          }

          const prevEdges = prev.places?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));
          const nextEdges = fetchMoreResult.places.edges.filter((edge) => !seen.has(edge.cursor));

          return {
            places: {
              ...fetchMoreResult.places,
              edges: [...prevEdges, ...nextEdges],
            },
          };
        },
      }),
    [fetchMore],
  );

  const pagination = useInfiniteConnection({
    connection: view?.places,
    loadedCount: places.length,
    fetchNextPage,
  });

  const locatedPlaces = useMemo(
    () =>
      places.filter(
        (place): place is PlaceNode & { latitude: number; longitude: number } =>
          typeof place.latitude === 'number' && typeof place.longitude === 'number',
      ),
    [places],
  );

  const mapCenter = useMemo<[number, number]>(() => {
    if (locatedPlaces.length === 0) {
      return [37.7749, -122.4194];
    }

    const lat = locatedPlaces.reduce((sum, place) => sum + place.latitude, 0) / locatedPlaces.length;
    const lng = locatedPlaces.reduce((sum, place) => sum + place.longitude, 0) / locatedPlaces.length;

    return [lat, lng];
  }, [locatedPlaces]);

  let content: ReactNode | null = null;

  if (loading && view == null) {
    content = <LoadingPage />;
  } else if (error && view == null) {
    // Was the same confident EmptyState the genuine "No places found" branch
    // below uses — a fetch failure read identically to "you have none", with
    // no retry. ErrorState is the shared alternative (see its docblock).
    content = (
      <ErrorState
        title="Could not load places"
        description="Your places are still here — this device could not reach them just now."
        onRetry={() => void refetch()}
      />
    );
  } else {
    content = (
      <PullToRefresh onRefresh={refetch}>
        <PageContent ref={pagination.scrollRef} className="gap-4 p-0">
          <MemoryHubShell
            actions={
              isMobile ? undefined : (
                <Button size="sm" onClick={openAddPlace}>
                  <Plus className="h-4 w-4" />
                  New place
                </Button>
              )
            }
          >
            <div className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
              <div className="flex items-center gap-2">
                <div className="text-sm text-muted-foreground">{pagination.totalCount} places</div>
              </div>

              <KnownPlacesCard located={locatedCandidate} onLocate={setLocatedCandidate} />

              <PlaceDuplicatesCard onMerged={handleChanged} />

              <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                {(locatedPlaces.length > 0 || locatedCandidate != null) && (
                  <div ref={mapRef} className="flex-1 lg:sticky lg:top-4">
                    <div className="h-72 overflow-hidden rounded-md border lg:h-[calc(100vh-14rem)] lg:min-h-72">
                      <Map center={mapCenter} zoom={locatedPlaces.length === 1 ? 13 : 3}>
                        <FlyToLocated target={locatedCandidate} />
                        {locatedCandidate && (
                          <Map.Marker
                            key={`located:${locatedCandidate.lat}:${locatedCandidate.lng}`}
                            variant="default"
                            position={[locatedCandidate.lat, locatedCandidate.lng]}
                            zIndexOffset={1000}
                          >
                            <Tooltip permanent direction="top" offset={[0, -56]}>
                              {locatedCandidate.label} · {locatedCandidate.eventCount} events
                            </Tooltip>
                          </Map.Marker>
                        )}
                        {locatedPlaces.slice(0, MAX_MAP_MARKERS).map((place) => (
                          <Map.Marker
                            key={place.id}
                            variant="place"
                            position={[place.latitude, place.longitude]}
                            onClick={() => openPlace(place.id)}
                          />
                        ))}
                      </Map>
                    </div>

                    {locatedPlaces.length > MAX_MAP_MARKERS && (
                      <div className="pt-1 text-xs text-muted-foreground">
                        Map shows the first {MAX_MAP_MARKERS} of {locatedPlaces.length} places with
                        coordinates.
                      </div>
                    )}
                  </div>
                )}

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {places.length === 0 ? (
                    <EmptyState message="No places found" />
                  ) : (
                    <>
                      {places.map((place) => (
                        <PlaceRow key={place.id} place={place} onOpen={() => openPlace(place.id)} />
                      ))}

                      <InfiniteListFooter pagination={pagination} noun="places" />
                    </>
                  )}
                </div>
              </div>
            </div>
          </MemoryHubShell>
        </PageContent>
      </PullToRefresh>
    );
  }

  return (
    <>
      {content}

      <PlaceSheet placeId={selectedGlobalId} onClose={closePlace} onChanged={handleChanged} />

      {/* A created place has no connection for Apollo to write into — the list
          is a fresh `places(query:)` result — so refetch rather than trying to
          patch the cache. refetch replays the hook's original variables
          (`first: PAGE_SIZE`, no cursor), so the accumulated list goes back to
          its first page; reset() clears any latched load-more failure with it,
          otherwise the sentinel would stay gated over a brand-new cursor space. */}
      <AddPlaceModal
        open={isAddPlaceOpen}
        onClose={closeAddPlace}
        onCreated={() => {
          pagination.reset();
          void refetch();
        }}
      />
    </>
  );
}
