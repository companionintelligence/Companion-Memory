import { useCallback, useMemo, useState } from 'react';

import { Button } from '@ci/shadcn';
import { Loader2, MapPin, Search as SearchIcon, X } from '@ci/shadcn/icons';
import L from 'leaflet';
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

/**
 * Resolve a marker position for any entity in the explorer result set.
 * Places carry their coordinates directly in `properties`; events (and other
 * entities) carry them on a resolved `location` PlaceType.
 */
function getEntityCoordinates(entity: EntityItem): { lat: number; lng: number } | null {
  if (entity.__typename === 'PlaceType' && 'properties' in entity) {
    return readCoordinates((entity as { properties?: unknown }).properties);
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

function useLocatedEntities() {
  const [{ data, hasNextPage, loadingMore, loadMore }, { setActiveEntity }] = useEntityService();

  const located = useMemo<LocatedEntity[]>(() => {
    return data
      .map((entity) => ({ entity, coords: getEntityCoordinates(entity) }))
      .filter((item): item is LocatedEntity => item.coords != null)
      .sort((a, b) => entityTime(a.entity) - entityTime(b.entity));
  }, [data]);

  return { located, setActiveEntity, hasNextPage, loadingMore, loadMore };
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

// ── "Search this area" viewport filter ──────────────────────────────────────
// Writes the current Leaflet viewport to the `?bbox` URL param, which flows
// through MemoryPage into the Search query (server-side ST_Within filter).
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
          Search this area
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
// The timeline panel's IntersectionObserver only pages in more results when its
// own cards scroll into view. Places (and other located-but-untimed entities)
// render no timeline card, so a Places-dominated result set leaves the panel too
// short to ever trip that sentinel — capping the map at the first page even
// though more located entities exist server-side. This explicit control pages in
// more results independently of the timeline, mirroring mobile's
// LoadMorePinsControl.
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

export function DesktopMapView() {
  const { located, setActiveEntity, hasNextPage, loadingMore, loadMore } = useLocatedEntities();

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
      <Map.RouteLayer />
      <ClusteredMarkers located={located} onSelect={setActiveEntity} />
    </Map>
  );
}

export function MobileMapView() {
  const { located, setActiveEntity } = useLocatedEntities();

  return (
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="bottom-right" />
      <SearchAreaControl />
      <Map.RouteLayer />
      <ClusteredMarkers located={located} onSelect={setActiveEntity} />
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
