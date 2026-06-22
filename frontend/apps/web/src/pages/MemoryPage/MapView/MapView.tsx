import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@ci/shadcn';
import { Loader2, MapPin, Search as SearchIcon, X } from '@ci/shadcn/icons';
import L, { type LatLngExpression } from 'leaflet';
import { Marker as LeafletMarker, useMap as useLeafletMap, useMapEvents } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';

import { Map } from '@/components/Map';
import { type MarkerVariant } from '@/components/Map/Marker';

import { useEntityService, type EntityItem } from '../../MemoryPage/useEntityService';
import { boundsToBbox, bboxCenter, formatBbox, parseBbox } from '../bbox';
import { TimelineView } from '../TimelineView';

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

type Coordinates = { latitude?: number | null; longitude?: number | null };

function readCoordinates(props: unknown): { lat: number; lng: number } | null {
  if (props == null || typeof props !== 'object') {
    return null;
  }

  const { latitude, longitude } = props as Coordinates;

  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    isNaN(latitude) ||
    isNaN(longitude) ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  return { lat: latitude, lng: longitude };
}

/** GeoJSON Point: `{ type: 'Point', coordinates: [lng, lat] }`. */
function readGeoJsonPoint(value: unknown): { lat: number; lng: number } | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const coords = (value as { coordinates?: unknown }).coordinates;

  if (!Array.isArray(coords) || coords.length < 2) {
    return null;
  }

  const [lng, lat] = coords;

  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    isNaN(lat) ||
    isNaN(lng) ||
    (lat === 0 && lng === 0)
  ) {
    return null;
  }

  return { lat, lng };
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

type LocatedEntity = { entity: EntityItem; coords: { lat: number; lng: number } };

// The map needs hasLocation:true so every fetched page yields pins (the shared
// result set is otherwise dominated by un-located rows). This is now derived
// from `?view=map` in MemoryPage rather than written here as a separate
// `?hasLocation` param: a URL write with an unmount cleanup reverted navigation
// away from /memory (the cleanup's setSearchParams fired mid-route-change and
// snapped the route back). The server still routes hasLocation through its event
// filter, so the map is an events-only surface — hence "Search events in this area".

function useLocatedEntities() {
  const [{ data, hasNextPage, loadingMore, loadMore }, { setActiveEntity }] = useEntityService();

  const located = useMemo<LocatedEntity[]>(() => {
    return data
      .map((entity) => ({ entity, coords: getEntityCoordinates(entity) }))
      .filter((item): item is LocatedEntity => item.coords != null)
      .sort((a, b) => entityTime(a.entity) - entityTime(b.entity));
  }, [data]);

  // Route polyline input: each located entity's own coordinates, in visit-time
  // order (`located` is already time-sorted). Driving routes from these points —
  // rather than the markers Leaflet has on the map — keeps cluster centroids out
  // of the path and orders segments by time instead of latitude.
  const routeLocations = useMemo<LatLngExpression[]>(
    () => located.map((item) => [item.coords.lat, item.coords.lng]),
    [located],
  );

  return { located, routeLocations, setActiveEntity, hasNextPage, loadingMore, loadMore };
}

// ── Marker clustering ───────────────────────────────────────────────────────
// Dense areas would otherwise render hundreds of overlapping pins. We bucket
// located entities into a fixed pixel grid at the current zoom (cluster
// membership is stable under panning — only zoom reprojects — so we only
// recompute on zoom). Buckets of one render the normal entity pin; larger
// buckets render a count bubble that zooms to fit its members on click.
const CLUSTER_CELL_PX = 80;

type Cluster = { id: string; lat: number; lng: number; items: LocatedEntity[] };

function clusterize(map: L.Map, located: LocatedEntity[], zoom: number): Cluster[] {
  const cells = new globalThis.Map<string, LocatedEntity[]>();

  for (const item of located) {
    const point = map.project([item.coords.lat, item.coords.lng], zoom);
    const key = `${Math.floor(point.x / CLUSTER_CELL_PX)}:${Math.floor(point.y / CLUSTER_CELL_PX)}`;
    const bucket = cells.get(key);

    if (bucket) {
      bucket.push(item);
    } else {
      cells.set(key, [item]);
    }
  }

  const clusters: Cluster[] = [];

  for (const [id, items] of cells) {
    const lat = items.reduce((sum, item) => sum + item.coords.lat, 0) / items.length;
    const lng = items.reduce((sum, item) => sum + item.coords.lng, 0) / items.length;

    clusters.push({ id, lat, lng, items });
  }

  return clusters;
}

function makeClusterIcon(count: number): L.DivIcon {
  const size = count < 10 ? 38 : count < 100 ? 46 : 54;

  // Inline styles (not Tailwind) so the size can scale with the count without
  // relying on dynamically-generated utility classes.
  const html = `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:9999px;background:rgba(37,99,235,0.92);color:#fff;font-weight:600;font-size:13px;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);">${count}</div>`;

  return L.divIcon({
    html,
    className: 'memory-map-cluster',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function ClusterMarker({
  position,
  count,
  onClick,
}: {
  position: [number, number];
  count: number;
  onClick: () => void;
}) {
  const icon = useMemo(() => makeClusterIcon(count), [count]);

  const eventHandlers = useMemo(
    () => ({
      click: (event: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(event);
        onClick();
      },
    }),
    [onClick],
  );

  return <LeafletMarker position={position} icon={icon} eventHandlers={eventHandlers} zIndexOffset={300} />;
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

function ClusteredMarkers({
  located,
  onSelect,
}: {
  located: LocatedEntity[];
  onSelect: (entity: EntityItem) => void;
}) {
  const map = useLeafletMap();
  const [zoom, setZoom] = useState(() => map.getZoom());

  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });

  const clusters = useMemo(() => clusterize(map, located, zoom), [map, located, zoom]);

  return (
    <>
      {clusters.map((cluster) => {
        if (cluster.items.length === 1) {
          const { entity, coords } = cluster.items[0];

          return (
            <Map.Marker
              key={entity.id}
              position={[coords.lat, coords.lng]}
              variant={markerVariant(entity)}
              onClick={() => onSelect(entity)}
            />
          );
        }

        return (
          <ClusterMarker
            key={cluster.id}
            position={[cluster.lat, cluster.lng]}
            count={cluster.items.length}
            onClick={() => zoomToCluster(map, cluster)}
          />
        );
      })}
    </>
  );
}

// ── "Search events in this area" viewport filter ─────────────────────────────
// Writes the current Leaflet viewport to the `?bbox` URL param, which flows
// through MemoryPage into the Search query (server-side ST_Within filter). The
// server applies bbox through its event filter, so — like the map's
// hasLocation:true scope (useMapHasLocationScope) — it narrows to events within
// the box; the control is labelled "Search events in this area" to make that
// scope explicit rather than silently dropping non-event pins.
// Panning fully away from the searched area drops the filter again.
function SearchAreaControl() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeBbox = parseBbox(searchParams.get('bbox'));
  const [movedSinceSearch, setMovedSinceSearch] = useState(false);
  const map = useLeafletMap();

  const setBbox = useCallback(
    (value: string | null) => {
      setSearchParams(
        (params) => {
          if (value) {
            params.set('bbox', value);
          } else {
            params.delete('bbox');
          }

          return params;
        },
        { replace: true },
      );
      setMovedSinceSearch(false);
    },
    [setSearchParams],
  );

  // react-leaflet rebinds these handlers every render, so the closure always sees
  // the current activeBbox. On each pan/zoom: flag that the view moved, and if the
  // searched area's centre has scrolled out of view, drop the filter.
  useMapEvents({
    moveend: () => {
      setMovedSinceSearch(true);

      if (activeBbox && !map.getBounds().contains(L.latLng(bboxCenter(activeBbox)))) {
        setBbox(null);
      }
    },
  });

  const stopPropagation = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  }, []);

  const showSearch = !activeBbox || movedSinceSearch;

  return (
    <div ref={stopPropagation} className="absolute left-1/2 top-3 z-400 flex -translate-x-1/2 gap-2">
      {showSearch && (
        <Button
          size="sm"
          onClick={() => setBbox(formatBbox(boundsToBbox(map.getBounds())))}
          className="border border-gray-200! bg-white! text-slate-700! shadow-md hover:bg-gray-100!"
        >
          <SearchIcon className="mr-1 h-4 w-4" />
          Search events in this area
        </Button>
      )}

      {activeBbox && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setBbox(null)}
          className="border border-gray-200! bg-white! text-slate-700! shadow-md hover:bg-gray-100!"
        >
          <X className="mr-1 h-4 w-4" />
          Clear area
        </Button>
      )}
    </div>
  );
}

// ── "Load more pins" control ────────────────────────────────────────────────
// Desktop's timeline panel pages in more results via an IntersectionObserver,
// but only when its own cards scroll into view. Located-but-untimed entities
// render no timeline card, so a result set short on timeline cards leaves the
// panel too short to ever trip that sentinel — capping the map at the first page
// even though more located entities exist server-side. Mobile has no timeline
// panel at all, so without this it is hard-capped at page 1. This explicit
// control pages in more results independently of the timeline; both the desktop
// and mobile map views render it.
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
  const stopPropagation = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  }, []);

  if (!hasNextPage) {
    return null;
  }

  return (
    <div ref={stopPropagation} className="absolute bottom-4 left-1/2 z-400 -translate-x-1/2">
      <Button
        size="sm"
        onClick={onLoadMore}
        disabled={loadingMore}
        className="border border-gray-200! bg-white! text-slate-700! shadow-md hover:bg-gray-100!"
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

// Fit the viewport to the located entities the first time they arrive, so the
// pins are actually on screen — they're often scattered far from the default
// center (different cities/countries), which is what made the map look empty.
// Fits once: later pagination or the user's own panning won't yank the view.
function FitBoundsOnce({ located }: { located: LocatedEntity[] }) {
  const map = useLeafletMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || located.length === 0) {
      return;
    }

    const points = located.map((item) => [item.coords.lat, item.coords.lng] as [number, number]);

    map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 13 });
    fitted.current = true;
  }, [located, map]);

  return null;
}

export function DesktopMapView() {
  const { located, routeLocations, setActiveEntity, hasNextPage, loadingMore, loadMore } =
    useLocatedEntities();

  return (
    // TODO: This default leads to some map jittering. It's OK for now, but let's think about tracking the user's last location and use that for the default center.
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="bottom-right" />
      <Map.Panel position="left" className="w-[300px] relative">
        <TimelineView />
        <SoftBlur />
      </Map.Panel>

      <SearchAreaControl />
      <LoadMorePinsControl
        shown={located.length}
        hasNextPage={hasNextPage}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
      />
      <Map.RouteLayer locations={routeLocations} />
      <ClusteredMarkers located={located} onSelect={setActiveEntity} />
      <FitBoundsOnce located={located} />
    </Map>
  );
}

export function MobileMapView() {
  const { located, routeLocations, setActiveEntity, hasNextPage, loadingMore, loadMore } =
    useLocatedEntities();

  return (
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="bottom-right" />
      <SearchAreaControl />
      <LoadMorePinsControl
        shown={located.length}
        hasNextPage={hasNextPage}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
      />
      <Map.RouteLayer locations={routeLocations} />
      <ClusteredMarkers located={located} onSelect={setActiveEntity} />
      <FitBoundsOnce located={located} />
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
