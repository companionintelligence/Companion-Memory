import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQuery } from '@apollo/client';
import { Button, cn } from '@ci/shadcn';
import { Route } from '@ci/shadcn/icons';
import L from 'leaflet';
import { CircleMarker, Polyline, Tooltip, useMap as useLeafletMap, useMapEvents } from 'react-leaflet';

import { gql } from '@/graphql';

import { boundsToBbox, clampBboxSpan } from '../bbox';
import { useEntityService } from '../useEntityService';

import { describeTrace, traceRadius, traceSegments, type TracePoint } from './trace';

/**
 * The user's own location history, windowed to the viewport and the explorer's
 * date filters.
 *
 * This is the read the map never had. `mapPins` answers located EVENTS — 121 of
 * them on the QA appliance — while `ci.position` holds 63,044 GPS fixes across
 * thirteen years that nothing on the map surface had ever queried. Hence "how
 * do I load all of my locations on the map".
 *
 * Note what is NOT asked for: no id, no title, no detail. A fix is not a
 * memory; it has nothing to open. The server has already collapsed the window
 * to a point budget, so what comes back is a shape, not a feed.
 */
const POSITION_TRACK_QUERY = gql(`
  query PositionTrack($startTime: String, $endTime: String, $bbox: [Float!], $first: Int, $after: String, $maxPoints: Int) {
    positionTrack(
      input: { startTime: $startTime, endTime: $endTime, bbox: $bbox, first: $first, after: $after, maxPoints: $maxPoints }
    ) {
      points {
        latitude
        longitude
        startTime
        endTime
        fixCount
      }
      hasNextPage
      endCursor
      bucketSeconds
      totalCount
    }
  }
`);

/**
 * Point budget for one window, the size of one page of it, and the ceiling on
 * how far the client will page on its own.
 *
 * The budget is what the server divides the window's IN-VIEW span by to pick
 * its time bucket (or, once the viewport is small enough that fewer real
 * fixes are in it than the budget, drops bucketing altogether and answers raw
 * — see `PositionService.findTrack`) — so it, not the size of `ci.position`,
 * decides what a request costs.
 *
 * The budget is deliberately WIDER than one page: `hasNextPage` can only ever
 * be true when a window's answer (bucketed or raw) is bigger than a single
 * page, so a budget equal to the page size — the previous setting — made the
 * keyset pager below dead code, no matter how far the user zoomed in. Keeping
 * the two apart is what turns zooming into a dense area (a viewport with more
 * real fixes than one page holds, even after #1's viewport-scoped bucketing)
 * into an actually-reachable "load the rest of what's here": the first page
 * ships immediately and the auto-page loop below fills in the remaining pages
 * up to the SAME `TRACE_AUTO_PAGE_LIMIT` that already bounded how many
 * markers this layer will ever put in the DOM at once.
 */
const TRACE_MAX_POINTS = 10_000;
const TRACE_PAGE_SIZE = 2_000;
const TRACE_AUTO_PAGE_LIMIT = 10_000;

/** Pad the viewport before asking, so a small pan doesn't blank the trace's edges. */
const TRACE_VIEWPORT_PAD = 0.35;

/**
 * Ceiling on the PADDED viewport's own span, comfortably under the server's
 * `MAX_BBOX_LON_SPAN` / `MAX_BBOX_LAT_SPAN` (120° / 60° — `positionTrack.ts`).
 * A raw viewport does not need to be anywhere near that wide for
 * `TRACE_VIEWPORT_PAD` to push it over: at a 0.35 pad ratio (35% added to
 * each edge) a raw lat span past ~35° already crosses 60° once padded — a tall
 * portrait viewport at a middling zoom level, not an edge case. The server's
 * response to a too-wide bbox is to drop the spatial predicate ENTIRELY
 * rather than narrow it, so an unclamped pad can silently turn a
 * viewport-scoped request into an unscoped, whole-history one. Kept
 * meaningfully below the server's actual ceiling (not equal to it) so this
 * never depends on exact floating-point agreement with a comparison this
 * client cannot see.
 */
const TRACE_BBOX_MAX_LON_SPAN = 115;
const TRACE_BBOX_MAX_LAT_SPAN = 55;

type TrackPage = {
  points: TracePoint[];
  hasNextPage: boolean;
  endCursor: string | null;
  bucketSeconds: number | null;
  totalCount: number | null;
};

/**
 * The trace for the current viewport and date filters, paged to completion (up
 * to {@link TRACE_AUTO_PAGE_LIMIT}).
 *
 * The viewport is read on `moveend` rather than on every frame: Leaflet fires
 * it once when a pan or zoom settles, which is exactly one refetch per gesture
 * instead of one per animation frame.
 */
function usePositionTrack({ enabled }: { enabled: boolean }) {
  const [{ searchVariables }] = useEntityService();
  const { startTime, endTime } = searchVariables;

  // Deliberately starts UNBOUNDED, and stays that way until the user moves the
  // map. The map opens at a fixed default centre (San Francisco, zoom 13) that
  // has nothing to do with where this user's history is — seeding the first
  // read from that viewport would ask "what happened in this square mile of
  // California", get nothing back, and reproduce the empty map this layer
  // exists to fix. The unbounded read is affordable precisely because it is
  // downsampled: thirteen years collapses to a few hundred points in ~30ms.
  const [bbox, setBbox] = useState<number[] | undefined>(undefined);

  // Guarded on `enabled` so a switched-off layer costs nothing: without it every
  // pan would still set state and re-render the whole map subtree for a query
  // that is skipped anyway.
  const syncViewport = useCallback(
    (map: L.Map) => {
      if (enabled) {
        setBbox(
          clampBboxSpan(
            boundsToBbox(map.getBounds().pad(TRACE_VIEWPORT_PAD)),
            TRACE_BBOX_MAX_LON_SPAN,
            TRACE_BBOX_MAX_LAT_SPAN,
          ),
        );
      }
    },
    [enabled],
  );

  const map = useLeafletMap();

  // `moveend` covers panning AND zooming (Leaflet fires it after a zoom too);
  // `zoomend` is kept so a zoom with no pan still resyncs on every path.
  useMapEvents({ moveend: () => syncViewport(map), zoomend: () => syncViewport(map) });

  const { data, loading, error, fetchMore } = useQuery(POSITION_TRACK_QUERY, {
    variables: { startTime, endTime, bbox, first: TRACE_PAGE_SIZE, maxPoints: TRACE_MAX_POINTS },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    skip: !enabled,
  });

  const track = data?.positionTrack as TrackPage | undefined;

  // Page to completion in the background. The ref keys on the cursor rather
  // than a boolean so a refetch under new filters (new first page, new cursor)
  // starts a fresh walk instead of being mistaken for the one already done.
  const pagedCursor = useRef<string | null>(null);

  useEffect(() => {
    if (
      track == null ||
      !track.hasNextPage ||
      track.endCursor == null ||
      track.points.length >= TRACE_AUTO_PAGE_LIMIT ||
      pagedCursor.current === track.endCursor
    ) {
      return;
    }

    pagedCursor.current = track.endCursor;

    void fetchMore({
      variables: { after: track.endCursor },
      updateQuery: (previous, { fetchMoreResult }) => {
        if (fetchMoreResult?.positionTrack == null) {
          return previous;
        }

        return {
          positionTrack: {
            ...fetchMoreResult.positionTrack,
            points: [...previous.positionTrack.points, ...fetchMoreResult.positionTrack.points],
            // The server answers the total on the first page only (a COUNT is a
            // second scan and cannot change mid-walk), so carry it forward.
            totalCount: previous.positionTrack.totalCount ?? fetchMoreResult.positionTrack.totalCount,
          },
        };
      },
    });
  }, [track, fetchMore]);

  const points = useMemo(() => track?.points ?? [], [track]);

  return {
    points,
    loading: loading && points.length === 0,
    error: error != null,
    totalFixes: track?.totalCount ?? null,
    bucketSeconds: track?.bucketSeconds ?? null,
    hasMore: track?.hasNextPage === true,
  };
}

/**
 * The trace itself: a line where the fixes are continuous, and a weighted dot
 * per point.
 *
 * Rendered under the event pins (`pane: 'shadowPane'` sits below Leaflet's
 * marker pane) and non-interactive for the line, so the layer can never eat a
 * click meant for a memory. The dots stay interactive — a hover tells you when
 * you were there and how many fixes that point stands for.
 */
export function TraceLayer({ points, colour }: { points: TracePoint[]; colour: string }) {
  const segments = useMemo(() => traceSegments(points), [points]);

  return (
    <>
      {segments.map((segment, index) => (
        <Polyline
          key={`trace-${index}-${segment.length}`}
          positions={segment}
          pathOptions={{ color: colour, weight: 2, opacity: 0.55, interactive: false }}
          pane="shadowPane"
        />
      ))}

      {points.map((point) => (
        <CircleMarker
          key={`${point.startTime}-${point.latitude}-${point.longitude}`}
          center={[point.latitude, point.longitude]}
          radius={traceRadius(point.fixCount)}
          pathOptions={{
            color: colour,
            weight: 1,
            opacity: 0.8,
            fillColor: colour,
            fillOpacity: 0.35,
          }}
          pane="shadowPane"
        >
          <Tooltip direction="top" offset={[0, -4]}>
            <span className="text-xs">
              {new Date(point.startTime).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {point.fixCount > 1 && ` · ${point.fixCount.toLocaleString()} fixes`}
            </span>
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

/**
 * The whole layer: its own read, its own toggle, its own status line.
 *
 * Kept as one component mounted inside the Leaflet map (rather than lifted into
 * `useMapView`) because everything it needs — the viewport — only exists in
 * here, and because the event pins must keep working exactly as they did when
 * it is switched off.
 */
export function PositionTraceLayer({ enabled, fitToTrace }: { enabled: boolean; fitToTrace: boolean }) {
  const { points, loading, error, totalFixes, bucketSeconds, hasMore } = usePositionTrack({ enabled });
  const map = useLeafletMap();
  const fitted = useRef(false);

  // Fit to the trace only when nothing else will: `FitBoundsToPins` owns the
  // viewport whenever there are event pins, and two components fighting over
  // `fitBounds` is how a map ends up jumping on every load. Once, then never
  // again — panning inside a loaded trace must not snap back.
  useEffect(() => {
    if (!enabled || !fitToTrace || fitted.current || points.length === 0) {
      return;
    }

    fitted.current = true;
    map.fitBounds(
      L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number])),
      { padding: [60, 60], maxZoom: 13 },
    );
  }, [enabled, fitToTrace, points, map]);

  if (!enabled) {
    return null;
  }

  return (
    <>
      <TraceLayer points={points} colour="rgb(56 189 248)" />
      <TraceStatus
        text={
          error
            ? "Couldn't load your location history"
            : loading
              ? 'Loading your location history…'
              : describeTrace({ points: points.length, totalFixes, bucketSeconds, hasMore })
        }
      />
    </>
  );
}

/** Says what the trace is showing — and, when downsampled, what it is not. */
function TraceStatus({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-400">
      <div className="rounded-md border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md">
        {text}
      </div>
    </div>
  );
}

/**
 * On/off control for the trace layer. Event pins are unaffected either way —
 * that separation is the point: a trace of every fix would otherwise swamp the
 * 121 things that actually happened.
 *
 * `className` places it, because the desktop map has a 300px timeline panel
 * pinned to its left edge and the mobile one does not.
 */
export function TraceToggleControl({
  enabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const stopPropagation = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  }, []);

  return (
    <div ref={stopPropagation} className={cn('absolute left-3 top-3 z-400', className)}>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={enabled}
        onClick={onToggle}
        className="border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent"
      >
        <Route className="mr-1 h-4 w-4" />
        {enabled ? 'Hide location history' : 'Show location history'}
      </Button>
    </div>
  );
}
