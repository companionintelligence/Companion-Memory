import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import { useQuery } from '@apollo/client';
import { Button, cn } from '@ci/shadcn';
import { Calendar, Clock, Loader2, MapPin, Pencil, Search as SearchIcon, Square, X } from '@ci/shadcn/icons';
import L, { type LatLngExpression } from 'leaflet';
import { Marker as LeafletMarker, Popup, useMap as useLeafletMap, useMapEvents } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';

import { ChatAbout, ChatAboutSheet } from '@/components/ChatWithAgent';
import { Map, MapAttribution } from '@/components/Map';
import { useMapIsolation } from '@/components/Map/mapIsolation';
import { type MarkerVariant } from '@/components/Map/Marker';
import { gql, useFragment } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { namedChatContext, type AgentChatContext } from '@/lib/agentChat';
import { type DateTimeFormatter } from '@/lib/dateTimeFormat';
import { entityToAgentChatContext } from '@/lib/entityToAgentChatContext';

import { useEntityService, type EntityItem } from '../../MemoryPage/useEntityService';
import { boundsToBbox, unionBbox, type Bbox } from '../bbox';
import { Empty, ErrorState, formatEventTimeRange, INGEST_TIME_SOURCE } from '../Components';
import { EVENT_FRAGMENT } from '../Components/EntityCard/EventCard';
import { countActiveFilters } from '../Components/ExplorerToolbar/filterParams';
import {
  EMPTY_TRACK_SOURCE,
  PlaybackBar,
  PlaybackProvider,
  PlaybackTrackLayer,
  useOptionalPlayback,
  usePlaybackControls,
  usePlayheadPin,
  useRevealedPins,
  type PlaybackPin,
} from '../Playback';
import { TimelineView } from '../TimelineView';

import { AreaLayer, useSearchAreas, type AreaMode } from './AreaLayer';
import { clusterDiameterPx, mergeCollidingClusters, type PixelCluster } from './clusterOverlap';
import { LocationAlwaysBanner } from './LocationAlwaysBanner';
import { readCoordinates, readGeoJsonPoint } from './mapCoordinates';
import { fitActionFor, fitSignature, mostRecentDatedPin, pinsInBounds, routePoints } from './pinSet';
import { PositionTraceLayer, TraceToggleControl } from './TraceLayer';
import { HOME_MAP_ZOOM, useHomeMapCenter } from './useHomeMapCenter';
import './memory-map.css';

// Colour/icon-code each marker by what it represents, like the old LifeScope map.
const MARKER_VARIANT_BY_TYPENAME: Record<string, MarkerVariant> = {
  PlaceType: 'place',
  EventType: 'event',
  PersonType: 'person',
  ContentType: 'content',
  FileType: 'file',
  ConceptType: 'concept',
  BrowserActivityType: 'browser-activity',
  ItemType: 'item',
  NoteType: 'note',
  CommunicationType: 'communication',
  AnswerType: 'answer',
  ThreadType: 'thread',
};

function markerVariant(entity: EntityItem): MarkerVariant {
  return MARKER_VARIANT_BY_TYPENAME[entity.__typename] ?? 'default';
}

/**
 * Every located event for the current filters, in one bounded read.
 *
 * NOT the explorer feed. The map used to plot `useEntityService`'s page of 30
 * (`PAGE_SIZE`), which meant ~350 presses of "Load more pins" to see a library
 * of ten thousand located events — and each new page landed outside the
 * viewport that had been fitted to the first one. `mapPins` answers the whole
 * located set for the same filters at once, projected down to a point and a
 * label; the pins are clustered client-side and the detail of any one event is
 * fetched when the user opens it.
 */
const MAP_PINS_QUERY = gql(`
  query MapPins($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $connectors: [String!], $people: [String!], $places: [String!], $areas: [[Float!]!], $semantic: Boolean) {
    mapPins(
      input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, connectors: $connectors, people: $people, places: $places, areas: $areas, semantic: $semantic }
    ) {
      totalCount
      truncated
      pins {
        id
        title
        latitude
        longitude
        startTime
        endTime
        eventType
        locationName
        timeSource
      }
    }
  }
`);

/**
 * The event behind a pin, fetched only when one is opened.
 *
 * This is the other half of the slim-pin trade: the detail sheet wants the same
 * hydrated event an explorer row carries, and paying for that up front for
 * every pin is what the pin cap was protecting us from. One pin, one fetch, on
 * click.
 */
const MAP_PIN_EVENT_QUERY = gql(`
  query MapPinEvent($id: ID!) {
    event(id: $id) {
      ...TimelineEventCardData
      eventType
      # Aliased to the key EventDetails reads first for the location line.
      mapCoordinates: locationCoordinates
    }
  }
`);

/**
 * A drawable marker, whatever it came from.
 *
 * `entity` is the hydrated explorer node when the pin came from the shared
 * result set (the read-only /shared viewer, which has no `mapPins` access and
 * keeps reading the owner's feed), and null when it came from `mapPins` — in
 * which case opening it fetches the event by id.
 */
type Pin = {
  id: string;
  coords: { lat: number; lng: number };
  title: string;
  timeLabel: string | null;
  /** Sort key (epoch ms) — the route line follows visit order, not latitude. */
  sortTime: number;
  variant: MarkerVariant;
  entity: EntityItem | null;
};

function pinChatContext(pin: Pin, fmt: DateTimeFormatter): AgentChatContext {
  if (pin.entity) {
    return entityToAgentChatContext(pin.entity, fmt);
  }

  return namedChatContext({
    title: pin.title,
    body: pin.timeLabel,
    sourceKind: 'EventType',
    sourceId: pin.id,
  });
}

/**
 * Resolve a marker position for any entity in the explorer result set. Events
 * carry a PostGIS Point in `mapCoordinates` (GeoJSON) — often with no resolved
 * `location` PlaceType, which is why reading `location.properties` alone yielded
 * "0 pins". Places carry lat/lng in `mapProperties`; a resolved `location`
 * PlaceType is the final fallback.
 */
function getEntityCoordinates(entity: EntityItem): { lat: number; lng: number } | null {
  const point = readGeoJsonPoint((entity as { mapCoordinates?: unknown }).mapCoordinates);

  if (point) {
    return point;
  }

  if (entity.__typename === 'PlaceType') {
    return readCoordinates((entity as { mapProperties?: unknown }).mapProperties);
  }

  if ('location' in entity && entity.location) {
    return readCoordinates((entity.location as { properties?: unknown }).properties);
  }

  return null;
}

function entityTime(entity: EntityItem): number {
  const value =
    'time' in entity ? (entity.time as string) : 'startTime' in entity ? (entity.startTime as string) : null;

  const date = value ? new Date(value) : null;

  return date && !isNaN(date.getTime()) ? date.getTime() : 0;
}

// The map issues its own read (`mapPins`) instead of deriving pins from the
// explorer's paged feed, and that read is located-only and events-only by
// construction — hence "Search events in this area".
//
// Because of that, the map no longer depends on a `hasLocation` filter being
// present: it plots the whole located set either way. Clicking the Map tab still
// applies "Has a location" as a real, chipped, removable filter
// (applyViewFilterDefaults in MemoryPage) so the explorer feed behind the
// timeline panel agrees with the pins, but removing that chip widens the panel,
// not the map. This supersedes LocatedScopeNotice, which used to explain a map
// left sparse by un-located feed rows — with `mapPins` there is no such gap to
// explain, and its "N of M loaded results" count would compare two different
// reads. Historical hazard worth not repeating: an earlier version wrote the
// `?hasLocation` param from this file with an unmount cleanup, and that cleanup's
// setSearchParams fired mid-route-change and snapped navigation back to /memory.
// Nothing here writes on unmount.

/** Pins from the map's own `mapPins` read — the signed-in user's whole located set. */
function useMapPins({ skip }: { skip: boolean }) {
  const [{ searchVariables }] = useEntityService();
  const fmt = useDateTimeFormat();
  // Paging and the explorer-only knobs (sort order, includeFiles, hasLocation —
  // which mapPins forces on) are dropped: the map asks for a set, not a page.
  const {
    query,
    includeTypes,
    excludeTypes,
    eventTypes,
    tags,
    startTime,
    endTime,
    connectors,
    people,
    places,
    areas,
    semantic,
  } = searchVariables;

  const { data, loading, error, refetch } = useQuery(MAP_PINS_QUERY, {
    variables: {
      query,
      includeTypes,
      excludeTypes,
      eventTypes,
      tags,
      startTime,
      endTime,
      connectors,
      people,
      places,
      areas,
      semantic,
    },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    skip,
  });

  const pins = useMemo<Pin[]>(() => {
    const rows = data?.mapPins?.pins ?? [];

    return rows
      .map((pin) => {
        // `timeSource === 'ingest'` means `startTime` is only the import wall
        // clock (a Google Maps saved place, an undated Reddit affiliation, …),
        // not a real moment — same rule getEntityTimestamp applies on the
        // timeline/explorer side. Without this a saved place captioned itself
        // "Yesterday 9:56 PM" using the instant the import happened to run.
        const dated = pin.startTime && pin.timeSource !== INGEST_TIME_SOURCE;

        return {
          id: pin.id,
          coords: { lat: pin.latitude, lng: pin.longitude },
          title: pin.title || 'Untitled event',
          timeLabel: dated ? formatEventTimeRange(pin.startTime, pin.endTime, fmt) : null,
          sortTime: dated ? new Date(pin.startTime as string).getTime() : 0,
          variant: 'event' as MarkerVariant,
          entity: null,
        };
      })
      .sort((a, b) => a.sortTime - b.sortTime);
  }, [data, fmt]);

  const refetchPins = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    pins,
    // The map areas this set was fetched with, or null. Read beside `data`,
    // which Apollo only hands back for the CURRENT variables, so the two
    // never disagree.
    areas: data != null && Array.isArray(areas) ? areas : null,
    loading,
    error: error != null,
    refetch: refetchPins,
    totalCount: data?.mapPins?.totalCount ?? 0,
    truncated: data?.mapPins?.truncated ?? false,
  };
}

/**
 * Pins derived from the shared explorer feed — the read-only /shared viewer's
 * path. A shared saved search resolves as its owner through `search`, so its
 * map keeps reading that feed (and its "Load more pins" control) rather than
 * `mapPins`, which answers for the signed-in caller's own memories.
 */
function useFeedPins() {
  const [{ data, loading, error }] = useEntityService();
  const fmt = useDateTimeFormat();

  const pins = useMemo<Pin[]>(() => {
    return data
      .map((entity) => ({ entity, coords: getEntityCoordinates(entity) }))
      .filter((item): item is { entity: EntityItem; coords: { lat: number; lng: number } } => {
        return item.coords != null;
      })
      .map(({ entity, coords }) => ({
        id: entity.id,
        coords,
        title: clusterItemTitle(entity),
        timeLabel: clusterItemTime(entity, fmt),
        sortTime: entityTime(entity),
        variant: markerVariant(entity),
        entity,
      }))
      .sort((a, b) => a.sortTime - b.sortTime);
  }, [data, fmt]);

  return { pins, loading, error: error != null };
}

// ── Marker clustering ───────────────────────────────────────────────────────
// Dense areas would otherwise render hundreds of overlapping pins. We bucket
// the pins IN THE CURRENT VIEWPORT into a fixed pixel grid at the current zoom.
// Buckets of one render the normal entity pin; larger buckets render a count
// bubble that zooms to fit its members on click.
//
// The grid alone is not enough: its edges are hard, so two dense neighbouring
// cells can place their centroids a few pixels apart and draw one bubble on top
// of another. Everything below therefore works in PROJECTED PIXELS — the space
// the collision actually happens in — and mergeCollidingClusters folds any two
// markers whose discs would touch into one before we unproject back to lat/lng.
//
// Viewport-scoping is what makes this safe now that the map holds the whole
// located set rather than a page of 30: mergeCollidingClusters compares every
// surviving pair once per merge, so its cost is quadratic in the CLUSTER count.
// A screen holds at most (width/80)·(height/80) grid cells — a few hundred —
// however many pins the set has, whereas clustering ten thousand scattered pins
// at street zoom would have produced ten thousand clusters and hung the tab.
const CLUSTER_CELL_PX = 80;
// Pad the viewport so a pin just off-screen is already clustered when it pans
// in, instead of popping into existence at the edge.
const VIEWPORT_PAD = 0.25;

/**
 * Most recent pins the route line will connect. See `useMapView.routeLocations`
 * — every consecutive pair costs one Google Directions request.
 */
const MAX_ROUTE_POINTS = 50;
/** Regional context around the latest located event, rather than the whole memory globe. */
const MOBILE_RECENT_MAP_ZOOM = 10;

type Cluster = { id: string; lat: number; lng: number; items: Pin[] };

function clusterize(map: L.Map, pins: Pin[], zoom: number): Cluster[] {
  const cells = new globalThis.Map<string, PixelCluster<Pin>>();

  for (const item of pins) {
    const point = map.project([item.coords.lat, item.coords.lng], zoom);
    const key = `${Math.floor(point.x / CLUSTER_CELL_PX)}:${Math.floor(point.y / CLUSTER_CELL_PX)}`;
    const bucket = cells.get(key);

    if (bucket) {
      bucket.x += point.x;
      bucket.y += point.y;
      bucket.items.push(item);
    } else {
      cells.set(key, { x: point.x, y: point.y, items: [item] });
    }
  }

  // Cell sums become cell centroids, still in pixels.
  const gridded = [...cells.values()].map(({ x, y, items }) => ({
    x: x / items.length,
    y: y / items.length,
    items,
  }));

  return mergeCollidingClusters(gridded).map((cluster) => {
    const { lat, lng } = map.unproject([cluster.x, cluster.y], zoom);

    // The id has to change with membership AND position: it keys the React list,
    // so a merged cluster reusing its old cell key would keep a stale icon
    // showing the old count. Two clusters cannot share this one — same size at
    // the same rounded pixel would have collided and been merged.
    return {
      id: `${cluster.items.length}@${Math.round(cluster.x)},${Math.round(cluster.y)}`,
      lat,
      lng,
      items: cluster.items,
    };
  });
}

function makeClusterIcon(count: number): L.DivIcon {
  const size = clusterDiameterPx(count);

  // Inline styles (not Tailwind) so the size can scale with the count without
  // relying on dynamically-generated utility classes.
  const html = `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:9999px;background:var(--primary);color:var(--primary-foreground);font-weight:600;font-size:13px;border:3px solid var(--background);box-shadow:var(--ci-button-shadow),0 1px 4px rgba(0,0,0,0.4);">${count}</div>`;

  return L.divIcon({
    html,
    className: 'memory-map-cluster',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

type ClusterListEntity = {
  title?: string | null;
  name?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  time?: string | null;
  bucketStartTime?: string | null;
  bucketTime?: string | null;
};

function clusterItemTitle(entity: EntityItem): string {
  const item = entity as ClusterListEntity;

  return (
    item.title || item.name || (entity.__typename === 'EventType' ? 'Untitled event' : 'Untitled memory')
  );
}

function clusterItemTime(entity: EntityItem, fmt: DateTimeFormatter): string | null {
  const item = entity as ClusterListEntity;

  if (entity.__typename === 'EventType') {
    const start = item.startTime ?? item.bucketStartTime;

    return start ? formatEventTimeRange(start, item.endTime, fmt) : null;
  }

  const raw = item.time ?? item.bucketTime;

  if (!raw) {
    return null;
  }

  const time = new Date(raw);

  return isNaN(time.getTime())
    ? null
    : fmt.dateTime(
        time,
        {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        },
        'en-US',
      );
}

function ClusterPopupContent({
  cluster,
  onSelect,
  onZoom,
}: {
  cluster: Cluster;
  onSelect: (pin: Pin) => void;
  onZoom: () => void;
}) {
  const fmt = useDateTimeFormat();

  return (
    <div className="w-72 overflow-hidden text-card-foreground" onClick={(event) => event.stopPropagation()}>
      <div className="max-h-72 overflow-y-auto py-2">
        {cluster.items.map((pin) => (
          <ChatAbout key={pin.id} context={pinChatContext(pin, fmt)}>
            <button
              type="button"
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-card-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => onSelect(pin)}
            >
              <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{pin.title}</span>
                {pin.timeLabel && (
                  <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {pin.timeLabel}
                  </span>
                )}
              </span>
            </button>
          </ChatAbout>
        ))}
      </div>

      <div className="border-t border-border p-0">
        <Button type="button" size="sm" className="w-full rounded-none border-0" onClick={onZoom}>
          Zoom to group
        </Button>
      </div>
    </div>
  );
}

function ClusterMarker({
  position,
  count,
  cluster,
  onSelect,
  onZoom,
}: {
  position: [number, number];
  count: number;
  cluster: Cluster;
  onSelect: (pin: Pin) => void;
  onZoom: () => void;
}) {
  const map = useLeafletMap();
  const icon = useMemo(() => makeClusterIcon(count), [count]);
  const handleSelect = useCallback(
    (pin: Pin) => {
      map.closePopup();
      onSelect(pin);
    },
    [map, onSelect],
  );

  const eventHandlers = useMemo(
    () => ({
      click: (event: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(event);
      },
    }),
    [],
  );

  return (
    <LeafletMarker position={position} icon={icon} eventHandlers={eventHandlers} zIndexOffset={300}>
      <Popup className="custom-popup memory-map-cluster-popup" minWidth={288} maxWidth={320}>
        <ClusterPopupContent cluster={cluster} onSelect={handleSelect} onZoom={onZoom} />
      </Popup>
    </LeafletMarker>
  );
}

function zoomToCluster(map: L.Map, cluster: Cluster) {
  const points = cluster.items.map((item) => [item.coords.lat, item.coords.lng] as [number, number]);
  const bounds = L.latLngBounds(points);

  // All members share (nearly) the same point — zooming can't separate them, so
  // just step in towards them.
  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.setView(points[0], Math.min(map.getZoom() + 2, 18));

    return;
  }

  map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 17 });
}

/**
 * Max-wait on the viewport re-sync. A human gesture ends in exactly one
 * `moveend`, so this is invisible in normal use — but the playback camera calls
 * `setView` on every animation frame, and each of those fires `moveend` too.
 * Without coalescing, a fly-through would re-project and re-cluster every pin
 * in the viewport sixty times a second.
 *
 * This has to be a leading+trailing THROTTLE, not a pure trailing debounce.
 * A trailing debounce reschedules on every call and only fires once the calls
 * stop — which they never do during playback, since the camera's per-frame
 * `setView` keeps `moveend` firing faster than the delay could ever elapse.
 * That froze `view` for the entire playback and, with it, ClusteredMarkers'
 * viewport-bounds filter: no marker in the region the camera was flying
 * through ever rendered. A throttle instead guarantees a sync at most
 * {@link VIEW_SYNC_DELAY_MS} apart no matter how densely `moveend` fires.
 */
const VIEW_SYNC_DELAY_MS = 120;

function ClusteredMarkers({
  pins,
  onSelect,
  onHoverPin,
}: {
  pins: Pin[];
  onSelect: (pin: Pin) => void;
  onHoverPin?: (pin: Pin | null) => void;
}) {
  const map = useLeafletMap();
  const fmt = useDateTimeFormat();
  const [chatPin, setChatPin] = useState<Pin | null>(null);
  // One state for both, because clustering depends on both: zoom decides the
  // projection, the viewport decides which pins are candidates at all.
  const [view, setView] = useState(() => ({ zoom: map.getZoom(), bounds: map.getBounds() }));
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Epoch ms of the last actual sync. Starts at 0 so the very first call — the
  // common, non-playback case — runs on the leading edge instead of waiting
  // out a delay nobody asked for.
  const lastSyncAtRef = useRef(0);

  const syncView = useCallback(() => {
    const run = () => {
      lastSyncAtRef.current = Date.now();
      setView({ zoom: map.getZoom(), bounds: map.getBounds() });
    };

    if (syncTimerRef.current != null) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    const elapsed = Date.now() - lastSyncAtRef.current;

    if (elapsed >= VIEW_SYNC_DELAY_MS) {
      // Leading edge: nothing has synced recently, so do it now rather than
      // making an isolated human gesture wait out the delay too.
      run();
    } else {
      // Trailing/max-wait edge: something synced too recently to run again
      // immediately, but this call still has to land within the delay —
      // otherwise a continuous stream of calls (the playback camera) would
      // keep pushing the timer out and never fire, exactly the bug above.
      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = null;
        run();
      }, VIEW_SYNC_DELAY_MS - elapsed);
    }
  }, [map]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current != null) {
        clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  // `moveend` covers panning AND zooming (Leaflet fires it after a zoom too);
  // `zoomend` is kept so a zoom with no pan still resyncs on every path.
  useMapEvents({ moveend: syncView, zoomend: syncView });

  const visible = useMemo(() => pinsInBounds(pins, view.bounds.pad(VIEWPORT_PAD)), [pins, view]);

  const clusters = useMemo(() => clusterize(map, visible, view.zoom), [map, visible, view.zoom]);

  return (
    <>
      {clusters.map((cluster) => {
        if (cluster.items.length === 1) {
          const pin = cluster.items[0];

          return (
            <Map.Marker
              key={pin.id}
              position={[pin.coords.lat, pin.coords.lng]}
              variant={pin.variant}
              onClick={() => onSelect(pin)}
              onContextMenu={() => setChatPin(pin)}
              onMouseEnter={() => onHoverPin?.(pin)}
              onMouseLeave={() => onHoverPin?.(null)}
            />
          );
        }

        return (
          <ClusterMarker
            key={cluster.id}
            position={[cluster.lat, cluster.lng]}
            count={cluster.items.length}
            cluster={cluster}
            onSelect={onSelect}
            onZoom={() => zoomToCluster(map, cluster)}
          />
        );
      })}
      <ChatAboutSheet
        open={chatPin != null}
        onOpenChange={(open) => {
          if (!open) {
            setChatPin(null);
          }
        }}
        context={chatPin ? pinChatContext(chatPin, fmt) : { title: 'This memory' }}
      />
    </>
  );
}

// ── The searched areas: the top-bar buttons ─────────────────────────────────
// Every button writes the `?areas` URL param (AreaLayer.useSearchAreas), which
// flows through MemoryPage into the Search and MapPins queries as a server-side
// ST_Within filter, ORed across rectangles. The server applies it through its
// event filter, so — like the map's hasLocation:true scope — it narrows to
// events inside the boxes; the quick button is labelled "Search events in this
// area" to make that scope explicit rather than silently dropping other pins.
//
// Three ways in: the quick button takes the viewport as THE area (replacing
// whatever was drawn — it is the one-shot path; the drawn boxes are the
// deliberate one), "Draw area" turns on the rectangle tool, "Edit areas" turns
// on move / resize / remove handles. The areas stay until "Clear areas" —
// panning away never drops them, so a person can look around and come back.
function SearchAreaControl({
  compact = false,
  mode,
  onModeChange,
}: {
  compact?: boolean;
  mode: AreaMode;
  onModeChange: (mode: AreaMode) => void;
}) {
  const [areas, setAreas] = useSearchAreas();
  const [movedSinceSearch, setMovedSinceSearch] = useState(false);
  const map = useLeafletMap();
  // Read imperatively, never subscribed to: this control must know whether a
  // move came from the viewer or from the playback camera, and subscribing to
  // the playhead would re-render it on every frame.
  const playback = useOptionalPlayback();

  // On each pan/zoom, flag that the view moved so the quick button comes back.
  useMapEvents({
    moveend: () => {
      // A fly-through drives the camera across the whole world; that is not
      // the person looking for a new area to search.
      if (playback?.store.getState().status === 'playing') {
        return;
      }

      setMovedSinceSearch(true);
    },
  });

  // Escape leaves whichever tool is on, the way it closes a popover.
  useEffect(() => {
    if (mode == null) {
      return;
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onModeChange(null);
      }
    };

    document.addEventListener('keydown', handleKey);

    return () => document.removeEventListener('keydown', handleKey);
  }, [mode, onModeChange]);

  const hasAreas = areas.length > 0;
  const showSearch = !hasAreas || movedSinceSearch;
  const buttonClass = cn(
    'border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent',
    compact && 'h-9 px-3 text-xs',
  );
  // A tool that is on wears the primary surface, the same green as Save, so
  // the map says which mode it is in without a legend.
  const activeClass = cn('shadow-md', compact && 'h-9 px-3 text-xs');
  const toggle = (next: AreaMode) => onModeChange(mode === next ? null : next);

  return (
    <>
      {showSearch && (
        <Button
          variant="outline"
          size="sm"
          aria-label={compact ? 'Search events in this map area' : undefined}
          onClick={() => {
            setAreas([boundsToBbox(map.getBounds())]);
            setMovedSinceSearch(false);
            onModeChange(null);
          }}
          className={cn(buttonClass, compact && 'max-w-full')}
        >
          <SearchIcon className="mr-1 h-4 w-4 shrink-0" />
          {compact ? 'Search this area' : 'Search events in this area'}
        </Button>
      )}

      <Button
        variant={mode === 'draw' ? 'default' : 'outline'}
        size="sm"
        aria-pressed={mode === 'draw'}
        onClick={() => toggle('draw')}
        className={mode === 'draw' ? activeClass : buttonClass}
      >
        <Square className="mr-1 h-4 w-4 shrink-0" />
        {compact ? 'Draw' : 'Draw area'}
      </Button>

      {hasAreas && (
        <Button
          variant={mode === 'edit' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={mode === 'edit'}
          onClick={() => toggle('edit')}
          className={mode === 'edit' ? activeClass : buttonClass}
        >
          <Pencil className="mr-1 h-4 w-4 shrink-0" />
          {compact ? 'Edit' : 'Edit areas'}
        </Button>
      )}

      {hasAreas && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAreas([]);
            setMovedSinceSearch(false);
            onModeChange(null);
          }}
          className={buttonClass}
        >
          <X className="mr-1 h-4 w-4 shrink-0" />
          {compact ? 'Clear' : areas.length === 1 ? 'Clear area' : 'Clear areas'}
        </Button>
      )}
    </>
  );
}

/** The signed-in map's rectangles: read from and written to the URL, with the active tool applied. */
function OwnedAreaLayer({ mode, onModeChange }: { mode: AreaMode; onModeChange: (mode: AreaMode) => void }) {
  const [areas, setAreas] = useSearchAreas();

  return <AreaLayer areas={areas} mode={mode} onChange={setAreas} onModeChange={onModeChange} />;
}

// ── The top bar: every control along the map's top edge ─────────────────────
// One row for the area-search buttons and the location-history toggle. They
// used to be three separately-positioned absolutes (the toggle pinned just
// right of the timeline panel, the search pair centred), which read as a gap
// of no particular size between them. On a phone the row scrolls sideways.
//
// The bar itself lets pointer events through, so the map still pans from the
// gaps; its children take them back. Presses on it must not reach the map
// (useMapIsolation) — and that is on the BAR, so every button in it is covered
// without each one asking.
function MapTopBar({ children, className }: { children: ReactNode; className?: string }) {
  const isolate = useMapIsolation();

  return (
    <div
      ref={isolate}
      className={cn(
        // -m-2 / p-2: the row clips its own overflow, and the buttons' shadows
        // and focus rings would be cut off flush against them otherwise.
        'scrollbar-none pointer-events-none absolute right-16 top-3 z-400 -m-2 flex gap-2 overflow-x-auto overscroll-x-contain p-2 *:pointer-events-auto',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── "Load more pins" control (shared-search viewer only) ────────────────────
// The owner's map is not paged any more — `mapPins` answers the whole located
// set — but the read-only /shared viewer still plots the owner's paginated feed,
// where the desktop timeline panel's IntersectionObserver only pages when its
// own cards scroll into view (and mobile has no panel at all). This keeps that
// surface able to reach past page one.
function LoadMorePinsControl({
  shown,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: {
  shown: number;
  hasNextPage: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const isolate = useMapIsolation();

  if (!hasNextPage) {
    return null;
  }

  return (
    <div ref={isolate} className="absolute bottom-4 left-1/2 z-400 -translate-x-1/2">
      <Button
        variant="outline"
        size="sm"
        onClick={onLoadMore}
        disabled={loadingMore}
        className="border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent"
      >
        {loadingMore ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <MapPin className="mr-1 h-4 w-4" />
        )}
        {loadingMore ? 'Loading…' : `Load more pins (${shown} shown)`}
      </Button>
    </div>
  );
}

/**
 * Says how much of the located set is on screen when the pin cap cut it short,
 * so a partial world is never presented as the whole one.
 */
function PinCountNotice({ shown, totalCount }: { shown: number; totalCount: number }) {
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-400 -translate-x-1/2">
      <div className="rounded-md border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md">
        Showing {shown.toLocaleString()} of {totalCount.toLocaleString()} pins — narrow the dates, or search
        this area, to see the rest.
      </div>
    </div>
  );
}

/**
 * Loading / error / empty states for the map surface.
 *
 * Without these a failed query, a slow one and a filter combination that
 * matches nothing all rendered the same thing: an empty world map at the
 * default centre, indistinguishable from "you have no located memories". The
 * desktop timeline panel carried its own states, but the mobile map has no
 * panel at all, so it said nothing whatsoever.
 */
function MapStatusOverlay({
  loading,
  error,
  empty,
  filtered,
  onRetry,
  className,
}: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  filtered: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  const isolate = useMapIsolation();
  const [searchParams] = useSearchParams();
  // The card covers most of a phone's map, so a person who only wants to pan
  // can put it away. Dismissal is per result: a change of filters or query
  // (the URL) brings the card back for the new answer, and so does a reload.
  const [dismissed, setDismissed] = useState(false);
  const resultKey = searchParams.toString();

  useEffect(() => {
    setDismissed(false);
  }, [resultKey]);

  if ((!loading && !error && !empty) || (dismissed && !loading)) {
    return null;
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-500 flex items-center justify-center p-6',
        className,
      )}
    >
      <div
        ref={isolate}
        role="status"
        aria-live="polite"
        className="pointer-events-auto relative max-w-sm rounded-lg border border-border bg-card/95 p-2 shadow-lg backdrop-blur"
      >
        {!loading && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
            className="absolute right-1 top-1 h-7 w-7 text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        {loading ? (
          <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your places…
          </div>
        ) : error ? (
          <ErrorState
            title="Couldn't load the map"
            description="We couldn't load your located memories. Check your connection and try again."
            onRetry={onRetry}
            className="px-4 py-6"
          />
        ) : (
          <Empty
            title={filtered ? 'No located memories match these filters' : 'Nothing to map yet'}
            description={
              filtered
                ? 'The map only shows memories that carry coordinates. Try widening the dates, clearing a filter, or clearing the searched area.'
                : 'Memories appear here once something you import carries a location — a photo with GPS, a place visit, a calendar entry with an address.'
            }
            icon={filtered ? '🔍' : '🗺️'}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Fit the viewport to the pins whenever a NEW set arrives — pins are often
 * scattered far from the default centre (different cities, countries), which is
 * what made the map look empty.
 *
 * Keyed on the set rather than fitted once: the map used to fit its first page
 * of 30 and never move again, so everything paged in afterwards landed
 * off-screen with no indication. It no longer pages, but the set still changes
 * when filters do, and a filter the user just applied should be what the
 * viewport shows. Panning inside an unchanged set is never overridden.
 */
function FitBoundsToPins({
  pins,
  areas,
  skip = false,
}: {
  pins: Pin[];
  /** The map areas `pins` were fetched with, or null — see `fitActionFor`. Framed as one: their union. */
  areas: readonly Bbox[] | null;
  skip?: boolean;
}) {
  const map = useLeafletMap();
  const fittedSignature = useRef<string | null>(null);
  const lastAreaBound = useRef(false);
  const lastAreaKey = useRef<string | null>(null);
  const signature = fitSignature(pins);
  const areaBound = areas != null && areas.length > 0;
  const areaKey = areaBound ? areas.map((area) => area.join(',')).join(';') : null;

  useEffect(() => {
    if (skip) {
      return;
    }

    const union = areaBound ? unionBbox(areas) : undefined;
    const areaBounds = union != null ? L.latLngBounds([union[1], union[0]], [union[3], union[2]]) : null;
    // "In view" is ANY rectangle touching the viewport, not the union inside
    // it: a box just drawn or just resized is on screen by construction even
    // while its siblings are off it, and framing the union then would zoom
    // the person out of the box they were working on. A saved search that
    // arrives from elsewhere has none of its boxes on screen, so it frames.
    const viewport = map.getBounds().pad(0.05);
    const areaInView =
      areaBound &&
      areas.some(([minLon, minLat, maxLon, maxLat]) =>
        viewport.intersects(L.latLngBounds([minLat, minLon], [maxLat, maxLon])),
      );

    const action = fitActionFor({
      signature,
      fitted: fittedSignature.current,
      areaBound,
      previousAreaBound: lastAreaBound.current,
      areaChanged: areaKey !== lastAreaKey.current,
      areaInView,
    });

    if (action === 'pins') {
      const points = pins.map((pin) => [pin.coords.lat, pin.coords.lng] as [number, number]);

      map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 13 });
    } else if (action === 'area' && areaBounds != null) {
      map.fitBounds(areaBounds);
    }

    // Adopted even when nothing moved: this set (and this area) is now the one
    // the viewport answers for, so only a DIFFERENT one can move it later.
    fittedSignature.current = signature;
    lastAreaBound.current = areaBound;
    lastAreaKey.current = areaKey;
  }, [skip, signature, pins, areas, areaBound, areaKey, map]);

  return null;
}

/** Apply Self home as the camera once, after the async lookup. MapContainer only honours its initial center. */
function HomeCamera({ center }: { center: [number, number] | null }) {
  const map = useLeafletMap();
  const applied = useRef(false);

  useEffect(() => {
    if (!center || applied.current) {
      return;
    }

    applied.current = true;
    map.setView(center, HOME_MAP_ZOOM);
  }, [center, map]);

  return null;
}

/** Re-focus once per latest event, while leaving ordinary pans alone. */
function RecentPinCamera({ pin }: { pin: Pin | null }) {
  const map = useLeafletMap();
  const appliedPinId = useRef<string | null>(null);

  useEffect(() => {
    if (!pin || appliedPinId.current === pin.id) {
      return;
    }

    appliedPinId.current = pin.id;
    map.setView([pin.coords.lat, pin.coords.lng], MOBILE_RECENT_MAP_ZOOM);
  }, [map, pin]);

  return null;
}

type ConnectorLine = { x1: number; y1: number; x2: number; y2: number } | null;

function MapTimelineConnector({
  active,
  rowElementsRef,
}: {
  active: Pin | null;
  rowElementsRef: MutableRefObject<globalThis.Map<string, HTMLDivElement>>;
}) {
  const map = useLeafletMap();
  const [line, setLine] = useState<ConnectorLine>(null);

  const updateLine = useCallback(() => {
    if (!active) {
      setLine(null);

      return;
    }

    const row = rowElementsRef.current.get(active.id);

    if (!row) {
      setLine(null);

      return;
    }

    const containerRect = map.getContainer().getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const markerPoint = map.latLngToContainerPoint([active.coords.lat, active.coords.lng]);

    setLine({
      x1: rowRect.right - containerRect.left,
      y1: rowRect.top + rowRect.height / 2 - containerRect.top,
      x2: markerPoint.x,
      y2: markerPoint.y,
    });
  }, [active, map, rowElementsRef]);

  useMapEvents({
    move: updateLine,
    moveend: updateLine,
    zoom: updateLine,
    zoomend: updateLine,
  });

  useEffect(() => {
    updateLine();

    const row = active ? rowElementsRef.current.get(active.id) : null;
    const scrollRoot = row?.closest('[data-radix-scroll-area-viewport]');

    scrollRoot?.addEventListener('scroll', updateLine, { passive: true });
    window.addEventListener('resize', updateLine);

    return () => {
      scrollRoot?.removeEventListener('scroll', updateLine);
      window.removeEventListener('resize', updateLine);
    };
  }, [active, rowElementsRef, updateLine]);

  if (!line) {
    return null;
  }

  return (
    <svg className="pointer-events-none absolute inset-0 z-[450] overflow-visible" aria-hidden="true">
      <line
        x1={line.x1}
        y1={line.y1}
        x2={line.x2}
        y2={line.y2}
        stroke="rgb(56 189 248)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="8 6"
      />
    </svg>
  );
}

/**
 * Everything a map view needs, resolved from whichever pin source applies.
 *
 * `readOnly` is the shared-search viewer: its results belong to the owner and
 * only `search` can resolve them, so it keeps the feed-derived pins (and their
 * paging control). The signed-in map reads `mapPins`.
 */
function useMapView(readOnly: boolean, sharedAreas: readonly Bbox[] | null = null) {
  const [{ hasNextPage, loadingMore, loadMore }, { setActiveEntity }] = useEntityService();
  const feed = useFeedPins();
  const owned = useMapPins({ skip: readOnly });
  const [searchParams] = useSearchParams();

  // Opening a pin from `mapPins` needs the hydrated event the detail sheet
  // renders; the pin itself carries only what a marker draws.
  const [openingPinId, setOpeningPinId] = useState<string | null>(null);
  const { data: openingData, loading: openingLoading } = useQuery(MAP_PIN_EVENT_QUERY, {
    variables: { id: openingPinId ?? '' },
    skip: openingPinId == null,
  });
  // `useFragment` is the codegen unmasking cast, not a hook — at runtime this is
  // the query's own event object, so the fields selected alongside the fragment
  // (eventType, mapCoordinates) travel with it into the detail sheet.
  const openingEvent = useFragment(EVENT_FRAGMENT, openingData?.event ?? null);

  useEffect(() => {
    if (openingPinId == null || openingLoading) {
      return;
    }

    // The id check matters: Apollo can hand back the previously-opened event for
    // a moment after the variables change, and opening pin B must never show
    // event A. Either way the request is finished, so the pin stops pending —
    // otherwise an event that no longer resolves would wedge the next open.
    if (openingEvent != null && openingEvent.id === openingPinId) {
      setActiveEntity({
        ...openingEvent,
        __typename: 'EventType',
        bucketStartTime: openingEvent.startTime,
      });
    }

    setOpeningPinId(null);
  }, [openingEvent, openingLoading, openingPinId, setActiveEntity]);

  const selectPin = useCallback(
    (pin: Pin) => {
      if (pin.entity != null) {
        setActiveEntity(pin.entity);

        return;
      }

      setOpeningPinId(pin.id);
    },
    [setActiveEntity],
  );

  const source = readOnly ? feed : owned;
  const pins = source.pins;

  // Route polyline input: the most recent pins' own coordinates, in visit-time
  // order (`pins` is already time-sorted ascending). Driving routes from these
  // points — rather than the markers Leaflet has on the map — keeps cluster
  // centroids out of the path and orders segments by time instead of latitude.
  //
  // Hard-capped, and that cap is load-bearing: RouteLayer issues ONE billed
  // Google Directions request per consecutive pair. The old 30-per-page feed
  // kept that implicitly small; handing it a full ten-thousand-pin set would
  // fire ten thousand sequential requests on every map load.
  const routeLocations = useMemo<LatLngExpression[]>(() => routePoints(pins, MAX_ROUTE_POINTS), [pins]);

  return {
    pins,
    // The shared viewer's rectangles are the owner's, read from their saved
    // search; the signed-in map's are the ones its pins were fetched with.
    searchAreas: readOnly ? sharedAreas : (owned.areas as Bbox[] | null),
    routeLocations,
    selectPin,
    // First load only: a background refetch must not blank a map that is
    // already showing pins.
    loading: source.loading && pins.length === 0,
    error: source.error && pins.length === 0,
    empty: !source.loading && !source.error && pins.length === 0,
    // "Filtered" drives the empty copy. Discount `hasLocation`: clicking the Map
    // tab applies it as this view's own default chip (applyViewFilterDefaults),
    // and `mapPins` is located-only whether or not it is set — so it describes
    // the surface, not a narrowing the user chose. Counting it would make an
    // empty library read as "nothing matches your filters".
    filtered:
      countActiveFilters(searchParams) - (searchParams.get('hasLocation') === '1' ? 1 : 0) > 0 ||
      Boolean(searchParams.get('search')?.trim()),
    refetch: readOnly ? undefined : owned.refetch,
    setActiveEntity,
    truncated: !readOnly && owned.truncated,
    totalCount: readOnly ? pins.length : owned.totalCount,
    hasNextPage,
    loadingMore,
    loadMore,
  };
}

/**
 * The map pins, reduced to what a playback needs and stripped of the undated.
 *
 * An undated pin has no place on a timeline: it would sort to 1970 and be
 * "revealed" before the film starts. `pins` is already time-ascending, so the
 * filtered result is too.
 */
function usePlaybackPins(pins: Pin[]): PlaybackPin[] {
  return useMemo(
    () =>
      pins
        .filter((pin) => pin.sortTime > 0)
        .map((pin) => ({ id: pin.id, coords: pin.coords, sortTime: pin.sortTime })),
    [pins],
  );
}

/** `areas`: the owner's saved rectangles, for the read-only shared viewer to draw and frame. */
export function DesktopMapView({
  readOnly = false,
  areas = null,
}: { readOnly?: boolean; areas?: readonly Bbox[] | null } = {}) {
  const view = useMapView(readOnly, areas);
  const playbackPins = usePlaybackPins(view.pins);

  return (
    <PlaybackProvider
      args={[
        {
          pins: playbackPins,
          // The shared viewer reads the owner's saved search, and a saved
          // search never carries their position history.
          source: readOnly ? EMPTY_TRACK_SOURCE : undefined,
        },
      ]}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <DesktopMapSurface view={view} readOnly={readOnly} />
        </div>
        <MapAttribution />
      </div>
    </PlaybackProvider>
  );
}

function DesktopMapSurface({ view, readOnly }: { view: ReturnType<typeof useMapView>; readOnly: boolean }) {
  const {
    pins,
    searchAreas,
    routeLocations,
    selectPin,
    loading,
    error,
    empty,
    filtered,
    refetch,
    truncated,
    totalCount,
    hasNextPage,
    loadingMore,
    loadMore,
    setActiveEntity,
  } = view;
  const rowElementsRef = useRef(new globalThis.Map<string, HTMLDivElement>());
  // Event pins are the primary layer. The much denser position history stays
  // opt-in so opening the Events map is immediately readable.
  const [showTrace, setShowTrace] = useState(false);
  const [areaMode, setAreaMode] = useState<AreaMode>(null);
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const activeEntityId = hoveredEntityId ?? selectedEntityId;

  const pinsById = useMemo(() => new globalThis.Map(pins.map((pin) => [pin.id, pin])), [pins]);
  const activePin = activeEntityId ? (pinsById.get(activeEntityId) ?? null) : null;

  // ── Playback ────────────────────────────────────────────────────────────
  // The playhead drives both halves of this view: the map reveals pins as it
  // crosses them, and the timeline panel highlights and scrolls to the memory
  // it has just reached — through TimelineView's EXISTING `activeEntityId`
  // prop, so playback adds no second selection mechanism. Hover still wins
  // while playback is idle, which is the whole of the map's normal behaviour.
  const { status: playbackStatus } = usePlaybackControls();
  const revealedPins = useRevealedPins(pins);
  const playheadPin = usePlayheadPin(pins);
  const playing = playbackStatus === 'playing';
  const timelineActiveId = playing ? (playheadPin?.id ?? null) : activeEntityId;

  const registerTimelineRow = useCallback((entityId: string, element: HTMLDivElement | null) => {
    if (element) {
      rowElementsRef.current.set(entityId, element);
    } else {
      rowElementsRef.current.delete(entityId);
    }
  }, []);

  const handleTimelineHover = useCallback((entity: EntityItem | null) => {
    setHoveredEntityId(entity?.id ?? null);
  }, []);

  const handlePinHover = useCallback((pin: Pin | null) => {
    setHoveredEntityId(pin?.id ?? null);
  }, []);

  const handleTimelineSelect = useCallback(
    (entity: EntityItem) => {
      setSelectedEntityId(entity.id);
      setActiveEntity(entity);
    },
    [setActiveEntity],
  );

  const handlePinSelect = useCallback(
    (pin: Pin) => {
      setSelectedEntityId(pin.id);
      selectPin(pin);
    },
    [selectPin],
  );

  return (
    <Map center={[37.7749, -122.4194]} autoCenterMarkers={false} attributionControl={false}>
      <Map.Controls position="top-right" />
      <Map.Panel position="left" className="w-[300px] relative">
        <TimelineView
          activeEntityId={timelineActiveId}
          onEntityHover={handleTimelineHover}
          onEntitySelect={handleTimelineSelect}
          registerTimelineRow={registerTimelineRow}
        />
        <SoftBlur />
      </Map.Panel>

      {/* The area tools write ?areas, which the shared viewer can't honour
          (the server ignores viewer filters), and the trace answers
          `positionTrack`, which resolves for the SIGNED-IN caller — so neither
          has a place on the shared viewer, whose results belong to somebody
          else. The bar starts past the 300px timeline panel. */}
      {!readOnly && (
        <MapTopBar className="left-[312px]">
          <SearchAreaControl mode={areaMode} onModeChange={setAreaMode} />
          <TraceToggleControl enabled={showTrace} onToggle={() => setShowTrace((value) => !value)} />
        </MapTopBar>
      )}
      {readOnly ? (
        // The owner's rectangles, shown so the viewer can see what the
        // results were confined to; nothing here can change them.
        <AreaLayer areas={searchAreas ?? []} />
      ) : (
        <OwnedAreaLayer mode={areaMode} onModeChange={setAreaMode} />
      )}
      {!readOnly && <PositionTraceLayer enabled={showTrace} fitToTrace={pins.length === 0} />}
      {readOnly && (
        <LoadMorePinsControl
          shown={pins.length}
          hasNextPage={hasNextPage}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      )}
      {truncated && !playing && <PinCountNotice shown={pins.length} totalCount={totalCount} />}
      {/* The connector is a hover affordance for a still map. During a
          fly-through it would whip a dashed line across the viewport on every
          frame, and recompute two bounding rects to do it. */}
      <MapTimelineConnector active={playing ? null : activePin} rowElementsRef={rowElementsRef} />
      <Map.RouteLayer locations={routeLocations} />
      <PlaybackTrackLayer />
      <ClusteredMarkers pins={revealedPins} onSelect={handlePinSelect} onHoverPin={handlePinHover} />
      {/* Fitted to the WHOLE set, never the revealed subset — otherwise every
          pin the playhead crossed would re-fit the viewport and fight the
          playback camera for control of it. */}
      <FitBoundsToPins pins={pins} areas={searchAreas} />
      {/* Padded past the 300px timeline panel so the state reads over the map
          itself rather than half-hidden behind the panel. Padding, not `left`,
          so it cannot collide with the `inset-0` on the same element. */}
      <MapStatusOverlay
        loading={loading}
        error={error}
        empty={empty}
        filtered={filtered}
        onRetry={refetch}
        className="pl-[300px]"
      />
      {/* Cleared past the timeline panel so the transport never sits under it. */}
      <PlaybackBar className="left-[312px]" />
    </Map>
  );
}

export function MobileMapView({
  readOnly = false,
  areas = null,
}: { readOnly?: boolean; areas?: readonly Bbox[] | null } = {}) {
  const view = useMapView(readOnly, areas);
  const playbackPins = usePlaybackPins(view.pins);

  return (
    <PlaybackProvider args={[{ pins: playbackPins, source: readOnly ? EMPTY_TRACK_SOURCE : undefined }]}>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {!readOnly ? <LocationAlwaysBanner /> : null}
        <div className="min-h-0 flex-1">
          <MobileMapSurface view={view} readOnly={readOnly} />
        </div>
        <MapAttribution />
      </div>
    </PlaybackProvider>
  );
}

function MobileMapSurface({ view, readOnly }: { view: ReturnType<typeof useMapView>; readOnly: boolean }) {
  const {
    pins,
    searchAreas,
    routeLocations,
    selectPin,
    loading,
    error,
    empty,
    filtered,
    refetch,
    truncated,
    totalCount,
    hasNextPage,
    loadingMore,
    loadMore,
  } = view;
  const [showTrace, setShowTrace] = useState(false);
  const [areaMode, setAreaMode] = useState<AreaMode>(null);
  const { status: playbackStatus } = usePlaybackControls();
  const revealedPins = useRevealedPins(pins);
  const playing = playbackStatus === 'playing';
  // Owner map only: the shared viewer must not aim someone else's pins at the viewer's home.
  const { center: homeCenter, resolved: homeResolved } = useHomeMapCenter(!readOnly);
  const recentPin = useMemo(() => mostRecentDatedPin(pins), [pins]);
  const recentCenter: [number, number] | null = recentPin
    ? [recentPin.coords.lat, recentPin.coords.lng]
    : null;

  return (
    <Map
      center={recentCenter ?? homeCenter ?? [37.7749, -122.4194]}
      zoom={recentCenter ? MOBILE_RECENT_MAP_ZOOM : homeCenter ? HOME_MAP_ZOOM : 13}
      autoCenterMarkers={false}
      attributionControl={false}
    >
      <Map.Controls position="top-right" />
      {!readOnly && (
        <MapTopBar className="left-3">
          <SearchAreaControl compact mode={areaMode} onModeChange={setAreaMode} />
          <TraceToggleControl enabled={showTrace} onToggle={() => setShowTrace((value) => !value)} compact />
        </MapTopBar>
      )}
      {readOnly ? (
        <AreaLayer areas={searchAreas ?? []} />
      ) : (
        <OwnedAreaLayer mode={areaMode} onModeChange={setAreaMode} />
      )}
      {!readOnly && <PositionTraceLayer enabled={showTrace} fitToTrace={pins.length === 0} />}
      {readOnly && (
        <LoadMorePinsControl
          shown={pins.length}
          hasNextPage={hasNextPage}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      )}
      {/* Both live at the bottom centre; the transport wins while it is out. */}
      {truncated && !playing && <PinCountNotice shown={pins.length} totalCount={totalCount} />}
      <Map.RouteLayer locations={routeLocations} />
      <PlaybackTrackLayer />
      <ClusteredMarkers pins={revealedPins} onSelect={selectPin} />
      <FitBoundsToPins
        pins={pins}
        areas={searchAreas}
        // Home and the most recent pin aim the phone's camera; a searched
        // area with nothing in it still has to be shown, so it wins over home.
        skip={
          searchAreas == null || searchAreas.length === 0
            ? !homeResolved || recentPin != null || homeCenter != null
            : recentPin != null
        }
      />
      <RecentPinCamera pin={recentPin} />
      <HomeCamera center={recentPin ? null : homeCenter} />
      <MapStatusOverlay loading={loading} error={error} empty={empty} filtered={filtered} onRetry={refetch} />
      <PlaybackBar />
    </Map>
  );
}

function SoftBlur({ className = '' }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 backdrop-blur-xl -z-1 ${className}`}
      style={{
        WebkitMaskImage: 'linear-gradient(to right, black 70%, transparent)',
        maskImage: 'linear-gradient(to right, black 70%, transparent)',
      }}
    />
  );
}
