import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, useDeviceLayout, usePageTitle } from '@ci/common';
import { Badge, Button, Card, Input } from '@ci/shadcn';
import { ChevronDown, LocateFixed, MapPin, Plus } from '@ci/shadcn/icons';
import { Tooltip, useMap as useLeafletMap } from 'react-leaflet';
import { Navigate, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';

import { useAnswersFromDevice } from '@/api/powersync/deviceFallback';
import { ChatAbout } from '@/components/ChatWithAgent';
import { ErrorState } from '@/components/ErrorState';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MAP_IMAGERY_ATTRIBUTION, Map } from '@/components/Map';
import { MemoryHubShell } from '@/components/MemoryHub';
import { MemoryHubPageSkeleton, RowsSkeleton } from '@/components/MemoryHub/MemoryHubSkeletons';
import { AddPlaceModal } from '@/components/modals/AddItemModal';
import { PLACE_KIND_LABELS } from '@/components/PlaceForm';
import { PullToRefresh } from '@/components/PullToRefresh';
import { savedRecordRoute } from '@/components/SearchBox/entityRoute';
import { GET_TAG_SUGGESTIONS, TagInput, useTagSuggestions } from '@/components/TagInput';
import { gql } from '@/graphql';
import type { GetKnownPlacesQuery, GetPlacesQuery } from '@/graphql/graphql';
import { useModalControls } from '@/hooks';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';
import { namedChatContext } from '@/lib/agentChat';
import { LocalTypeList } from '@/pages/MemoryPage/LocalListView/LocalTypeList';

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

export const GET_PLACES = gql(`
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
          tags {
            label
          }
        }
      }
    }
  }
`);

export const GET_KNOWN_PLACES = gql(`
  query GetKnownPlaces {
    geocodingConfigured
    knownPlaces {
      id
      locationId
      label
      kind
      confidence
      source
      activeFrom
      activeTo
      aliases
      tags
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
      presenceDays
      presenceNights
      confidence
      sampleEvents {
        id
        title
        startTime
      }
    }
  }
`);

export const CONFIRM_KNOWN_PLACE = gql(`
  mutation ConfirmKnownPlace($input: UpdateKnownPlaceInput!) {
    updateKnownPlace(input: $input) {
      id
      label
      kind
      tags
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
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="truncate font-medium">{place.name || 'Unnamed place'}</div>
            {place.tags.slice(0, 2).map((tag) => (
              <Badge
                key={tag.label}
                variant="outline"
                className="h-5 max-w-24 shrink-0 truncate px-1.5 text-[10px] font-normal"
              >
                {tag.label}
              </Badge>
            ))}
            {place.tags.length > 2 && (
              <span className="shrink-0 text-xs text-muted-foreground">+{place.tags.length - 2}</span>
            )}
          </div>

          <div className="truncate text-sm text-muted-foreground">
            {[
              place.placeKind && place.placeKind !== 'address'
                ? (PLACE_KIND_LABELS[place.placeKind] ?? place.placeKind)
                : null,
              place.parent?.name,
              place.description,
            ]
              .filter(Boolean)
              .join(' · ') || '—'}
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

/** Always shown first in the combined category/tag suggestion list. */
export const DEFAULT_KNOWN_PLACE_TAGS: readonly KnownPlaceKind[] = KNOWN_PLACE_KINDS;
const RECENT_PLACE_TAG_LIMIT = 10;

/** The server's label for a cluster it could not name — never worth saving verbatim. */
const UNNAMED_CANDIDATE_LABEL = 'unknown place';

function isKnownPlaceKind(kind: string): kind is KnownPlaceKind {
  return (KNOWN_PLACE_KINDS as readonly string[]).includes(kind);
}

/** Put newly used custom tags directly after the five fixed role suggestions. */
function prependRecentPlaceTags(current: readonly string[], used: readonly string[]): string[] {
  const seen = new Set(DEFAULT_KNOWN_PLACE_TAGS.map((tag) => tag.toLowerCase()));
  const next: string[] = [];

  // Selection order is meaningful elsewhere on this form, so the last custom
  // tag selected is also the first recent suggestion for the next candidate.
  for (const value of [...used].reverse().concat(current)) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();

    if (trimmed !== '' && !seen.has(normalized)) {
      seen.add(normalized);
      next.push(trimmed);
    }
  }

  return next.slice(0, RECENT_PLACE_TAG_LIMIT);
}

interface KnownPlaceCandidateDraft {
  label: string;
  tags: string[];
}

type KnownPlaceCandidate = NonNullable<GetKnownPlacesQuery['knownPlaceCandidates']>[number];
type KnownPlace = GetKnownPlacesQuery['knownPlaces'][number];

export const MOBILE_CANDIDATE_LIMIT = 1;
export const MOBILE_KNOWN_PLACE_LIMIT = 3;

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
  /** Days and nights of GPS in the candidate's area; see {@link candidateEvidence}. */
  presenceDays: number;
  presenceNights: number;
  /** Place entity id when this cluster is already a place. Null for a coordinate-only cluster. */
  locationId: string | null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Tags are ordered by selection. The newest built-in category wins the hidden
 * semantic role used by Home/Work inference; custom-only sets remain `other`.
 */
export function knownPlaceKindForTags(tags: readonly string[]): KnownPlaceKind {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const normalized = tags[index]?.trim().toLowerCase() ?? '';

    if (isKnownPlaceKind(normalized)) {
      return normalized;
    }
  }

  return 'other';
}

/** Preserve the saved semantic role when older records have no real tags yet. */
function knownPlaceTags(tags: readonly string[], kind: string): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  const semanticKind = isKnownPlaceKind(kind) ? kind : 'other';
  const currentRoleIndex = normalized.findIndex((tag) => tag.toLowerCase() === semanticKind);

  if (currentRoleIndex === -1) {
    return normalized.length === 0 ? [semanticKind] : normalized;
  }

  // Make the role represented by the relationship the newest built-in tag.
  return [
    ...normalized.slice(0, currentRoleIndex),
    ...normalized.slice(currentRoleIndex + 1),
    normalized[currentRoleIndex]!,
  ];
}

/**
 * What a candidate rests on: "4 events · GPS on 172 days (12 nights)". A
 * candidate can come from GPS alone, and "0 events" would read as no evidence.
 */
function candidateEvidence(candidate: {
  eventCount: number;
  presenceDays: number;
  presenceNights: number;
}): string {
  const parts: string[] = [];

  if (candidate.eventCount > 0 || candidate.presenceDays === 0) {
    parts.push(plural(candidate.eventCount, 'event'));
  }

  if (candidate.presenceDays > 0) {
    const nights = candidate.presenceNights > 0 ? ` (${plural(candidate.presenceNights, 'night')})` : '';
    parts.push(`GPS on ${plural(candidate.presenceDays, 'day')}${nights}`);
  }

  return parts.join(' · ');
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
  suggestions,
  onLocate,
  onSave,
}: {
  candidate: KnownPlaceCandidate;
  saving: boolean;
  /** Whether this row's pin is the one currently on the map. */
  located: boolean;
  suggestions: string[];
  onLocate: (candidate: KnownPlaceCandidate) => void;
  onSave: (candidate: KnownPlaceCandidate, draft: KnownPlaceCandidateDraft) => void;
}) {
  const unnamed = candidate.label.trim().toLowerCase() === UNNAMED_CANDIDATE_LABEL;
  const [label, setLabel] = useState(unnamed ? '' : candidate.label);
  const [tags, setTags] = useState<string[]>([isKnownPlaceKind(candidate.kind) ? candidate.kind : 'other']);
  const trimmed = label.trim();
  const inputId = `known-place-${candidate.locationId ?? `${candidate.lat},${candidate.lng}`}`;
  const evidence = `${candidateEvidence(candidate)}${
    unnamed ? ` near ${candidate.lat.toFixed(4)}, ${candidate.lng.toFixed(4)}` : ''
  }`;

  return (
    <div className="grid gap-2 rounded-lg border border-border/70 bg-background/60 p-2.5 sm:grid-cols-[minmax(10rem,1fr)_minmax(14rem,1.15fr)_auto] sm:items-end sm:p-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          Name
        </label>
        <p className="truncate text-sm text-muted-foreground">{evidence}</p>
        <Input
          id={inputId}
          value={label}
          placeholder="Name this place"
          onChange={(event) => setLabel(event.target.value)}
          disabled={saving}
        />
      </div>

      <div className="min-w-0">
        <div className="mb-1 text-sm font-medium">Categories and tags</div>
        <TagInput
          tags={tags}
          suggestions={suggestions}
          inputPlaceholder="Add category or tag…"
          inputAriaLabel={`Categories and tags for ${trimmed || 'unnamed place'}`}
          className="min-h-9 p-1.5"
          onTagAdded={(tag) => {
            setTags((current) => [...current, tag]);

            return true;
          }}
          onTagRemoved={(tag) => {
            setTags((current) => current.filter((value) => value !== tag));

            return true;
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button
          size="sm"
          variant={located ? 'secondary' : 'outline'}
          className="w-full sm:w-auto"
          aria-pressed={located}
          title={located ? 'Remove the pin from the map' : 'Show this place on the map'}
          onClick={() => onLocate(candidate)}
        >
          <LocateFixed className="h-4 w-4" />
          {located ? 'Located' : 'Locate'}
        </Button>
        <Button
          size="sm"
          className="w-full sm:w-auto"
          disabled={saving || trimmed === '' || tags.length === 0}
          onClick={() => onSave(candidate, { label: trimmed, tags })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function KnownPlaceRow({
  place,
  suggestions,
  saving,
  onUpdate,
}: {
  place: KnownPlace;
  suggestions: string[];
  saving: boolean;
  onUpdate: (place: KnownPlace, tags: string[]) => Promise<boolean>;
}) {
  const tags = useMemo(() => knownPlaceTags(place.tags, place.kind), [place.kind, place.tags]);

  return (
    <div className="rounded-lg border border-border/70 bg-background/60 p-2.5 sm:p-3">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{place.label}</div>
          <div className="text-xs text-muted-foreground">Saved place</div>
        </div>
        {saving && <span className="shrink-0 text-xs text-muted-foreground">Saving…</span>}
      </div>

      <TagInput
        key={`${place.id}:${tags.join('|')}`}
        tags={tags}
        suggestions={suggestions}
        inputPlaceholder="Add category or tag…"
        inputAriaLabel={`Categories and tags for ${place.label}`}
        className="min-h-9 p-1.5"
        onTagAdded={(tag) => onUpdate(place, [...tags, tag])}
        onTagRemoved={(tag) => {
          const next = tags.filter((value) => value !== tag);

          return next.length > 0 ? onUpdate(place, next) : false;
        }}
      />
    </div>
  );
}

function KnownPlacesCard({
  located,
  onLocate,
  onCandidates,
}: {
  located: LocatedCandidate | null;
  onLocate: (candidate: LocatedCandidate | null) => void;
  /** The candidates on screen, so the map can open the same details a named place does. */
  onCandidates: (candidates: LocatedCandidate[]) => void;
}) {
  const { isMobile } = useDeviceLayout();
  const [recentTags, setRecentTags] = useState<string[]>([]);
  const pinnedSuggestions = useMemo(() => [...DEFAULT_KNOWN_PLACE_TAGS, ...recentTags], [recentTags]);
  const suggestions = useTagSuggestions(pinnedSuggestions);
  const { data, refetch } = useQuery(GET_KNOWN_PLACES);
  const [confirmKnownPlace, { loading }] = useMutation(CONFIRM_KNOWN_PLACE, {
    // replaceEntityTags creates custom tags server-side. Refresh this
    // connection too so the new vocabulary survives leaving and returning to
    // Places instead of remaining absent from Apollo's cached tag list.
    refetchQueries: [GET_TAG_SUGGESTIONS],
  });
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [expandedCandidates, setExpandedCandidates] = useState(false);
  const [knownExpanded, setKnownExpanded] = useState(!isMobile);
  const [expandedKnownPlaces, setExpandedKnownPlaces] = useState(false);
  const [updatingKnownPlaceId, setUpdatingKnownPlaceId] = useState<string | null>(null);

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

  const pins = useMemo(
    () =>
      candidates.slice(0, 6).map((candidate) => ({
        lat: candidate.lat,
        lng: candidate.lng,
        label: candidate.label,
        eventCount: candidate.eventCount,
        presenceDays: candidate.presenceDays,
        presenceNights: candidate.presenceNights,
        locationId: candidate.locationId ?? null,
      })),
    [candidates],
  );

  useEffect(() => {
    onCandidates(pins);

    return () => onCandidates([]);
  }, [pins, onCandidates]);

  useEffect(() => {
    if (!isMobile) {
      setKnownExpanded(true);
    }
  }, [isMobile]);

  const rememberTags = useCallback((tags: readonly string[]) => {
    setRecentTags((current) => prependRecentPlaceTags(current, tags));
  }, []);

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
            kind: knownPlaceKindForTags(draft.tags),
            tags: draft.tags,
            locationId: candidate.locationId,
            coordinates: { lat: candidate.lat, lng: candidate.lng },
            confidence: candidate.confidence,
            source: 'inferred',
          },
        },
      });
      rememberTags(draft.tags);
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

  const updateKnownPlace = async (place: KnownPlace, tags: string[]): Promise<boolean> => {
    if (updatingKnownPlaceId != null) {
      return false;
    }

    try {
      setUpdateError(null);
      setUpdatingKnownPlaceId(place.id);
      await confirmKnownPlace({
        variables: {
          input: {
            knownPlaceId: place.id,
            label: place.label,
            kind: knownPlaceKindForTags(tags),
            tags,
            locationId: place.locationId,
            coordinates: place.coordinates
              ? { lat: place.coordinates.lat, lng: place.coordinates.lng }
              : null,
            confidence: place.confidence,
            ...(place.activeFrom ? { activeFrom: place.activeFrom } : {}),
            activeTo: place.activeTo,
            aliases: place.aliases,
            source: place.source,
          },
        },
      });
      rememberTags(tags);
      await refetch();

      return true;
    } catch (error) {
      setUpdateError(
        error instanceof Error ? error.message : 'Could not update that place. Please try again.',
      );

      return false;
    } finally {
      setUpdatingKnownPlaceId(null);
    }
  };

  const visibleCandidates =
    isMobile && !expandedCandidates ? candidates.slice(0, MOBILE_CANDIDATE_LIMIT) : candidates;
  const visibleKnownPlaces =
    isMobile && !expandedKnownPlaces ? knownPlaces.slice(0, MOBILE_KNOWN_PLACE_LIMIT) : knownPlaces;

  return (
    <>
      {candidates.length > 0 && (
        <Card className="gap-0 py-0">
          <Card.Header className="p-3 pb-2 sm:p-6 sm:pb-3">
            <Card.Title className="flex items-center gap-2 text-base">
              Needs review
              <Badge variant="secondary">{candidates.length}</Badge>
            </Card.Title>
            <Card.Description className="hidden sm:block">
              Name frequent places and add any categories or tags that help you recognize them.
            </Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-2 p-3 pt-0 sm:gap-3 sm:p-6 sm:pt-0">
            {confirmError && <div className="text-sm text-destructive">{confirmError}</div>}

            {data?.geocodingConfigured === false && (
              <div className="text-xs text-muted-foreground sm:text-sm">
                Geocoding isn&apos;t configured, so some places still need a name.
              </div>
            )}

            {visibleCandidates.map((candidate) => (
              <KnownPlaceCandidateRow
                key={`${candidate.locationId ?? ''}:${candidate.lat}:${candidate.lng}`}
                candidate={candidate}
                saving={loading}
                located={sameSpot(located, candidate)}
                suggestions={suggestions}
                onLocate={(target) =>
                  onLocate(
                    sameSpot(located, target)
                      ? null
                      : {
                          lat: target.lat,
                          lng: target.lng,
                          label: target.label,
                          eventCount: target.eventCount,
                          presenceDays: target.presenceDays,
                          presenceNights: target.presenceNights,
                          locationId: target.locationId ?? null,
                        },
                  )
                }
                onSave={(target, draft) => void confirm(target, draft)}
              />
            ))}

            {isMobile && candidates.length > MOBILE_CANDIDATE_LIMIT && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => setExpandedCandidates((current) => !current)}
              >
                {expandedCandidates ? 'Show less' : `Show ${candidates.length - MOBILE_CANDIDATE_LIMIT} more`}
              </Button>
            )}
          </Card.Content>
        </Card>
      )}

      {knownPlaces.length > 0 && (
        <Card className="gap-0 py-0">
          <Card.Header className="p-3 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <Card.Title className="flex items-center gap-2 text-base">
                Known places
                <Badge variant="secondary">{knownPlaces.length}</Badge>
              </Card.Title>
              {isMobile && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={knownExpanded}
                  onClick={() => setKnownExpanded((current) => !current)}
                >
                  {knownExpanded ? 'Hide' : 'Show'}
                  <ChevronDown
                    className={`size-4 transition-transform ${knownExpanded ? 'rotate-180' : ''}`}
                  />
                </Button>
              )}
            </div>
            <Card.Description className="hidden sm:block">
              Add or remove tags at any time. The newest Home, Work, School, Social, or Other tag controls the
              place&apos;s memory role.
            </Card.Description>
          </Card.Header>

          {knownExpanded && (
            <Card.Content className="flex flex-col gap-2 p-3 pt-0 sm:gap-3 sm:p-6 sm:pt-0">
              {updateError && <div className="text-sm text-destructive">{updateError}</div>}
              {visibleKnownPlaces.map((place) => (
                <KnownPlaceRow
                  key={place.id}
                  place={place}
                  suggestions={suggestions}
                  saving={updatingKnownPlaceId === place.id}
                  onUpdate={updateKnownPlace}
                />
              ))}
              {isMobile && knownPlaces.length > MOBILE_KNOWN_PLACE_LIMIT && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() => setExpandedKnownPlaces((current) => !current)}
                >
                  {expandedKnownPlaces
                    ? 'Show fewer'
                    : `Show ${knownPlaces.length - MOBILE_KNOWN_PLACE_LIMIT} more`}
                </Button>
              )}
            </Card.Content>
          )}
        </Card>
      )}
    </>
  );
}

/**
 * The places page. While the Memory server does not answer and this phone holds a synced
 * replica, the list comes from the phone (LocalTypeList) and a place in the URL opens its
 * saved record; otherwise from the appliance, with the map and the duplicate queue. See
 * api/powersync/deviceFallback.ts.
 */
export function PlacesPage() {
  const offline = useAnswersFromDevice();
  const { placeId } = useParams<{ placeId?: string }>();

  if (!offline) {
    return <RemotePlacesPage />;
  }

  if (placeId) {
    return <Navigate to={savedRecordRoute('place', placeId)} replace />;
  }

  return (
    <LocalTypeList entityType="place" heading="Places" pageTitle="Places - Companion Memory" order="title" />
  );
}

function RemotePlacesPage() {
  usePageTitle('Places - Companion Memory');

  const { isMobile } = useDeviceLayout();
  const navigate = useNavigate();
  const { placeId } = useParams<{ placeId: string }>();
  // The header search box's `?search=`: it edits this page's query in place
  // (see GlobalSearchBox / isLiveSearchPath), so the page has no input of its own.
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') ?? '';
  const [locatedCandidate, setLocatedCandidate] = useState<LocatedCandidate | null>(null);
  const [candidatePins, setCandidatePins] = useState<LocatedCandidate[]>([]);
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
  // A known-place candidate's locationId is already the raw place uuid the
  // route expects. Named-place markers pass a global id through openPlace.
  const openCandidatePlace = useCallback(
    (locationId: string | null) => {
      if (locationId) {
        navigate(`/memory/places/${locationId}${queryString}`);
      }
    },
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

  const mappedPlaceIds = useMemo(() => {
    const ids = new Set<string>();

    for (const place of locatedPlaces.slice(0, MAX_MAP_MARKERS)) {
      try {
        ids.add(GlobalUID.parse('place', place.id));
      } catch {
        // A marker that is not a place global id stays on the map either way.
      }
    }

    return ids;
  }, [locatedPlaces]);

  // Candidates already drawn as named-place markers open that marker. The rest
  // get their own pin so an unknown place can be opened the same way.
  const extraCandidatePins = useMemo(
    () => candidatePins.filter((pin) => pin.locationId == null || !mappedPlaceIds.has(pin.locationId)),
    [candidatePins, mappedPlaceIds],
  );

  // Also on the loading frame, so the strip's "New place" is there from the start.
  const pageActions = isMobile ? undefined : (
    <Button size="sm" onClick={openAddPlace}>
      <Plus className="h-4 w-4" />
      New place
    </Button>
  );

  let content: ReactNode | null = null;

  if (loading && view == null) {
    content = (
      <MemoryHubPageSkeleton label="Loading places" actions={pageActions}>
        <RowsSkeleton />
      </MemoryHubPageSkeleton>
    );
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
          <MemoryHubShell actions={pageActions}>
            <div className="flex flex-col gap-3 px-2 pb-3 sm:gap-4 sm:px-4 sm:pb-4">
              <div className="flex items-center gap-2">
                <div className="text-sm text-muted-foreground">{pagination.totalCount} places</div>
              </div>

              <KnownPlacesCard
                located={locatedCandidate}
                onLocate={setLocatedCandidate}
                onCandidates={setCandidatePins}
              />

              <PlaceDuplicatesCard onMerged={handleChanged} />

              <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                {(locatedPlaces.length > 0 || locatedCandidate != null || extraCandidatePins.length > 0) && (
                  <div ref={mapRef} className="flex-1 lg:sticky lg:top-4">
                    <div className="h-64 overflow-hidden rounded-md border sm:h-72 lg:h-[calc(100vh-14rem)] lg:min-h-72">
                      <Map
                        center={mapCenter}
                        zoom={locatedPlaces.length === 1 ? 13 : 3}
                        attributionControl={!isMobile}
                      >
                        <FlyToLocated target={locatedCandidate} />
                        {locatedCandidate && (
                          <Map.Marker
                            key={`located:${locatedCandidate.lat}:${locatedCandidate.lng}`}
                            variant="default"
                            position={[locatedCandidate.lat, locatedCandidate.lng]}
                            zIndexOffset={1000}
                            onClick={() => openCandidatePlace(locatedCandidate.locationId)}
                          >
                            <Tooltip permanent direction="top" offset={[0, -56]}>
                              {locatedCandidate.label} · {candidateEvidence(locatedCandidate)}
                            </Tooltip>
                          </Map.Marker>
                        )}
                        {extraCandidatePins.map((pin) => (
                          <Map.Marker
                            key={`candidate:${pin.locationId ?? ''}:${pin.lat}:${pin.lng}`}
                            variant="place"
                            position={[pin.lat, pin.lng]}
                            onClick={() => openCandidatePlace(pin.locationId)}
                          />
                        ))}
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

                    {isMobile && (
                      <div
                        data-testid="mobile-map-attribution"
                        className="px-1 pt-1 text-[10px] leading-tight text-muted-foreground/60"
                      >
                        <a
                          href="https://leafletjs.com"
                          target="_blank"
                          rel="noreferrer"
                          className="underline-offset-2 hover:underline"
                        >
                          Leaflet
                        </a>{' '}
                        | {MAP_IMAGERY_ATTRIBUTION}
                      </div>
                    )}

                    {locatedPlaces.length > MAX_MAP_MARKERS && (
                      <div className="pt-1 text-xs text-muted-foreground">
                        Map shows the first {MAX_MAP_MARKERS} of {locatedPlaces.length} places with
                        coordinates.
                      </div>
                    )}
                  </div>
                )}

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="text-sm font-semibold">All places</div>
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
