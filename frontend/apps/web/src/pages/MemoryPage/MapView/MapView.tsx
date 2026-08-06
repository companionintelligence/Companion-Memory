import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import { Button } from '@ci/shadcn';
import { Calendar, Clock, Loader2, MapPin, Search as SearchIcon, X } from '@ci/shadcn/icons';
import L, { type LatLngExpression } from 'leaflet';
import { Marker as LeafletMarker, Popup, useMap as useLeafletMap, useMapEvents } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';

import { Map } from '@/components/Map';
import { type MarkerVariant } from '@/components/Map/Marker';

import { useEntityService, type EntityItem } from '../../MemoryPage/useEntityService';
import { boundsToBbox, bboxCenter, formatBbox, parseBbox } from '../bbox';
import { formatEventTimeRange } from '../Components';
import { TimelineView } from '../TimelineView';

import { clusterDiameterPx, mergeCollidingClusters, type PixelCluster } from './clusterOverlap';
import { readCoordinates, readGeoJsonPoint } from './mapCoordinates';
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
//
// The grid alone is not enough: its edges are hard, so two dense neighbouring
// cells can place their centroids a few pixels apart and draw one bubble on top
// of another. Everything below therefore works in PROJECTED PIXELS — the space
// the collision actually happens in — and mergeCollidingClusters folds any two
// markers whose discs would touch into one before we unproject back to lat/lng.
const CLUSTER_CELL_PX = 80;

type Cluster = { id: string; lat: number; lng: number; items: LocatedEntity[] };

function clusterize(map: L.Map, located: LocatedEntity[], zoom: number): Cluster[] {
  const cells = new globalThis.Map<string, PixelCluster<LocatedEntity>>();

  for (const item of located) {
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
  const html = `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:9999px;background:var(--primary);color:var(--primary-foreground);font-weight:600;font-size:13px;border:3px solid var(--background);box-shadow:var(--shadow-glow-ci),0 1px 4px rgba(0,0,0,0.4);">${count}</div>`;

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

function clusterItemTime(entity: EntityItem): string | null {
  const item = entity as ClusterListEntity;

  if (entity.__typename === 'EventType') {
    const start = item.startTime ?? item.bucketStartTime;

    return start ? formatEventTimeRange(start, item.endTime) : null;
  }

  const raw = item.time ?? item.bucketTime;

  if (!raw) {
    return null;
  }

  const time = new Date(raw);

  return isNaN(time.getTime())
    ? null
    : time.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function ClusterPopupContent({
  cluster,
  onSelect,
  onZoom,
}: {
  cluster: Cluster;
  onSelect: (entity: EntityItem) => void;
  onZoom: () => void;
}) {
  return (
    <div className="w-72 overflow-hidden text-card-foreground" onClick={(event) => event.stopPropagation()}>
      <div className="max-h-72 overflow-y-auto py-2">
        {cluster.items.map(({ entity }) => {
          const time = clusterItemTime(entity);

          return (
            <button
              key={entity.id}
              type="button"
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-card-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => onSelect(entity)}
            >
              <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{clusterItemTitle(entity)}</span>
                {time && (
                  <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {time}
                  </span>
                )}
              </span>
            </button>
          );
        })}
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
  onSelect: (entity: EntityItem) => void;
  onZoom: () => void;
}) {
  const map = useLeafletMap();
  const icon = useMemo(() => makeClusterIcon(count), [count]);
  const handleSelect = useCallback(
    (entity: EntityItem) => {
      map.closePopup();
      onSelect(entity);
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

function ClusteredMarkers({
  located,
  onSelect,
  onHoverEntity,
}: {
  located: LocatedEntity[];
  onSelect: (entity: EntityItem) => void;
  onHoverEntity?: (entity: EntityItem | null) => void;
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
              onMouseEnter={() => onHoverEntity?.(entity)}
              onMouseLeave={() => onHoverEntity?.(null)}
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
          variant="outline"
          size="sm"
          onClick={() => setBbox(formatBbox(boundsToBbox(map.getBounds())))}
          className="border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent"
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
          className="border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent"
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

type ConnectorLine = { x1: number; y1: number; x2: number; y2: number } | null;

function MapTimelineConnector({
  active,
  rowElementsRef,
}: {
  active: LocatedEntity | null;
  rowElementsRef: MutableRefObject<globalThis.Map<string, HTMLDivElement>>;
}) {
  const map = useLeafletMap();
  const [line, setLine] = useState<ConnectorLine>(null);

  const updateLine = useCallback(() => {
    if (!active) {
      setLine(null);

      return;
    }

    const row = rowElementsRef.current.get(active.entity.id);

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

    const row = active ? rowElementsRef.current.get(active.entity.id) : null;
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

export function DesktopMapView({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { located, routeLocations, setActiveEntity, hasNextPage, loadingMore, loadMore } =
    useLocatedEntities();
  const rowElementsRef = useRef(new globalThis.Map<string, HTMLDivElement>());
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const activeEntityId = hoveredEntityId ?? selectedEntityId;

  const locatedById = useMemo(
    () => new globalThis.Map(located.map((item) => [item.entity.id, item])),
    [located],
  );
  const activeLocated = activeEntityId ? (locatedById.get(activeEntityId) ?? null) : null;

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

  const handleEntitySelect = useCallback(
    (entity: EntityItem) => {
      setSelectedEntityId(entity.id);
      setActiveEntity(entity);
    },
    [setActiveEntity],
  );

  return (
    // TODO: This default leads to some map jittering. It's OK for now, but let's think about tracking the user's last location and use that for the default center.
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="top-right" />
      <Map.Panel position="left" className="w-[300px] relative">
        <TimelineView
          activeEntityId={activeEntityId}
          onEntityHover={handleTimelineHover}
          onEntitySelect={handleEntitySelect}
          registerTimelineRow={registerTimelineRow}
        />
        <SoftBlur />
      </Map.Panel>

      {/* "Search this area" writes ?bbox, which the shared viewer can't honour
          (the server ignores viewer filters), so hide it in read-only mode. */}
      {!readOnly && <SearchAreaControl />}
      <LoadMorePinsControl
        shown={located.length}
        hasNextPage={hasNextPage}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
      />
      <MapTimelineConnector active={activeLocated} rowElementsRef={rowElementsRef} />
      <Map.RouteLayer locations={routeLocations} />
      <ClusteredMarkers located={located} onSelect={handleEntitySelect} onHoverEntity={handleTimelineHover} />
      <FitBoundsOnce located={located} />
    </Map>
  );
}

export function MobileMapView({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { located, routeLocations, setActiveEntity, hasNextPage, loadingMore, loadMore } =
    useLocatedEntities();

  return (
    <Map center={[37.7749, -122.4194]}>
      <Map.Controls position="top-right" />
      {!readOnly && <SearchAreaControl />}
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
