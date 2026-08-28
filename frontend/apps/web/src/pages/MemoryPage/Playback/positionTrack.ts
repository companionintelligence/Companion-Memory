import type { ApolloClient } from '@apollo/client';
import { FetchJsonError, fetchJson } from '@ci/common';

import { gql } from '@/graphql';

/**
 * The playback's substrate: `ci.position`, read a window at a time.
 *
 * ## Why this file is an adapter and not a query
 *
 * The paginated `ci.position` read is being built separately (a sibling change
 * owns the server side). Rather than block the fly-through on it — or, worse,
 * write a second competing query — the UI talks to {@link PositionTrackSource}
 * and nothing else. Swapping the REST adapter below for a GraphQL one, or for
 * whatever shape the real endpoint lands in, is a one-line change at the
 * provider and touches no component.
 *
 * ## The minimal contract the playback needs
 *
 * 1. **Ascending by time, paginated forward.** Playback is a forward scan; it
 *    never needs to page backwards, and it never needs a total.
 * 2. **An opaque forward cursor** (`nextCursor`), null when the window is
 *    exhausted. Offset paging would be wrong here — the set is immutable for
 *    the duration of a playback, but keyset paging costs nothing extra and
 *    survives a concurrent import.
 * 3. **A bounded page**, requested by the client (`limit`). The playhead is
 *    always somewhere inside the loaded prefix, so a page is exactly the
 *    lookahead buffer.
 * 4. **An extent** (first fix, last fix, count) so the scrubber can span the
 *    user's real history without downloading it first. 63,044 rows over 13
 *    years is not a payload; it is a scan.
 *
 * Everything else `ci.position` carries — accuracy, provider, device, activity
 * — is deliberately not requested. The fly-through draws a line and moves a
 * camera along it.
 */

/** One fix, projected down to what a moving camera needs. */
export interface TrackPoint {
  /** Epoch ms. */
  t: number;
  lat: number;
  lng: number;
  /** Resolved place name, when the reverse-geocode stage has produced one. */
  name?: string | null;
}

export interface PositionTrackPage {
  points: TrackPoint[];
  /** Opaque forward cursor; null when this window holds nothing further. */
  nextCursor: string | null;
}

export interface PositionTrackExtent {
  /** Epoch ms of the earliest fix. */
  start: number;
  /** Epoch ms of the latest fix. */
  end: number;
  count: number;
}

export interface FetchPageArgs {
  /** ISO-8601, inclusive. */
  start: string;
  /** ISO-8601, inclusive. */
  end: string;
  after?: string | null;
  limit: number;
  signal?: AbortSignal;
}

export interface PositionTrackSource {
  fetchPage(args: FetchPageArgs): Promise<PositionTrackPage>;
  /** Null when the server has no track to offer (or the route does not exist yet). */
  fetchExtent(args?: { signal?: AbortSignal }): Promise<PositionTrackExtent | null>;
}

/**
 * Points per request.
 *
 * Sized against the real distribution rather than a round number: the median
 * day carries 22 fixes and the busiest carries 2,726, so 2,000 points is
 * between a fortnight and most of one very dense day — a comfortable lookahead
 * at every rung of the speed ladder, and a payload of roughly 60 KB.
 */
export const TRACK_PAGE_SIZE = 2_000;

/**
 * Fetch the next page once the playhead is within this many points of the end
 * of what is loaded. Half a page, so the request has a page's worth of playback
 * time to complete in even at 1w/s.
 */
export const TRACK_PREFETCH_LEAD = TRACK_PAGE_SIZE / 2;

/**
 * Read one fix out of whatever the server sent.
 *
 * The endpoint is not written yet, so this accepts the three shapes it could
 * plausibly take — a flat `{time, latitude, longitude}` projection, the
 * `ci.position` row's PostGIS `location` GeoJSON (`coordinates` are
 * **[lng, lat]**, the order that gets transposed if you assume otherwise), and
 * the compact `{t, lat, lng}` this module itself uses. Rows that carry no
 * usable point are dropped rather than plotted at (0, 0) in the Gulf of Guinea.
 */
export function normalizeTrackRow(row: unknown): TrackPoint | null {
  if (row == null || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const rawTime = record.t ?? record.time ?? record.timestamp;
  const time =
    typeof rawTime === 'number' ? rawTime : typeof rawTime === 'string' ? Date.parse(rawTime) : Number.NaN;

  if (!Number.isFinite(time)) {
    return null;
  }

  let lat = readNumber(record.lat ?? record.latitude);
  let lng = readNumber(record.lng ?? record.lon ?? record.longitude);

  if (lat == null || lng == null) {
    const geo = record.location as { coordinates?: unknown } | null | undefined;
    const coordinates = geo?.coordinates;

    if (Array.isArray(coordinates) && coordinates.length >= 2) {
      lng = readNumber(coordinates[0]);
      lat = readNumber(coordinates[1]);
    }
  }

  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  const name = record.name ?? record.address ?? record.city;

  return { t: time, lat, lng, name: typeof name === 'string' && name ? name : null };
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;

  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * The REST adapter for the assumed `/api/position/track` endpoint.
 *
 * A 404 is treated as "not deployed yet", not as an error: it resolves to an
 * empty page / null extent so the playback falls back to the located memories
 * the map is already showing instead of putting a failure banner over a working
 * map. Every other failure propagates — a 500 or a dropped connection is a real
 * problem and the bar says so.
 */
export function createRestPositionTrackSource(): PositionTrackSource {
  return {
    async fetchPage({ start, end, after, limit, signal }: FetchPageArgs): Promise<PositionTrackPage> {
      const params = new URLSearchParams({ start, end, limit: String(limit) });

      if (after) {
        params.set('after', after);
      }

      try {
        const body = await fetchJson<{ points?: unknown[]; nextCursor?: string | null }>(
          `/api/position/track?${params.toString()}`,
          { signal },
        );

        const points = (body?.points ?? [])
          .map(normalizeTrackRow)
          .filter((point): point is TrackPoint => point != null)
          // The contract says ascending, but the camera's interpolation reads
          // consecutive pairs directly — one out-of-order row would draw a
          // rubber band across the map, so sorting here is cheap insurance.
          .sort((a, b) => a.t - b.t);

        return { points, nextCursor: body?.nextCursor ?? null };
      } catch (error) {
        if (isNotFound(error)) {
          return { points: [], nextCursor: null };
        }

        throw error;
      }
    },

    async fetchExtent({ signal }: { signal?: AbortSignal } = {}): Promise<PositionTrackExtent | null> {
      try {
        const body = await fetchJson<{ start?: string; end?: string; count?: number }>(
          '/api/position/track/extent',
          { signal },
        );

        const start = body?.start ? Date.parse(body.start) : Number.NaN;
        const end = body?.end ? Date.parse(body.end) : Number.NaN;

        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          return null;
        }

        return { start, end, count: body?.count ?? 0 };
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }

        throw error;
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof FetchJsonError && error.status === 404;
}

/**
 * The playback's own read of `positionTrack` — the SAME query
 * `MapView/TraceLayer.tsx` uses to draw the trace layer, called with
 * `maxPoints: 0` so the server never buckets: a fly-through camera
 * interpolates between individual real fixes, and a bucket's synthesized
 * timestamp would make the camera jump rather than glide.
 *
 * `positionTrack`'s `endTime` is EXCLUSIVE (see `PositionTrackInput`), while
 * this adapter's own contract (`FetchPageArgs.end`) is INCLUSIVE — a caller
 * asking for "everything through 23:59:59.999" must not silently lose the
 * fix that landed exactly there. One millisecond is added at the call site
 * below to close that gap, rather than changing the shared query's contract
 * for every other caller.
 */
const POSITION_TRACK_PAGE_QUERY = gql(`
  query PlaybackPositionTrackPage($startTime: String, $endTime: String, $after: String, $first: Int) {
    positionTrack(
      input: { startTime: $startTime, endTime: $endTime, after: $after, first: $first, maxPoints: 0 }
    ) {
      points {
        latitude
        longitude
        startTime
      }
      endCursor
      hasNextPage
    }
  }
`);

/**
 * `positionTrackExtent`, unscoped — the scrubber represents the user's WHOLE
 * history, not whatever the map's viewport currently shows, so this
 * deliberately passes no bbox and no date range.
 */
const POSITION_TRACK_EXTENT_QUERY = gql(`
  query PlaybackPositionTrackExtent {
    positionTrackExtent {
      start
      end
      count
    }
  }
`);

/**
 * The real adapter, wired to `positionTrack`/`positionTrackExtent` — the two
 * queries `feat/map-geodata` built for exactly this. Supersedes
 * {@link createRestPositionTrackSource}, whose `/api/position/track*` REST
 * routes were never built anywhere in this repo (verified: `PositionController`
 * exposes only `POST /`, `GET stats`, `GET/PATCH/DELETE :id`) — so a caller
 * still on the REST adapter 404s forever and playback silently falls back to
 * the located-memories-only mode, no matter how much real GPS history exists.
 *
 * No 404 handling here: these queries exist and are wired, so a failure is a
 * real one and should propagate exactly like the REST adapter's non-404 path
 * already does.
 */
export function createGraphqlPositionTrackSource(client: ApolloClient<object>): PositionTrackSource {
  return {
    async fetchPage({ start, end, after, limit, signal }: FetchPageArgs): Promise<PositionTrackPage> {
      const inclusiveEnd = new Date(new Date(end).getTime() + 1).toISOString();

      const { data } = await client.query({
        query: POSITION_TRACK_PAGE_QUERY,
        variables: { startTime: start, endTime: inclusiveEnd, after: after ?? undefined, first: limit },
        fetchPolicy: 'network-only',
        context: signal ? { fetchOptions: { signal } } : undefined,
      });

      const points = (data?.positionTrack?.points ?? [])
        .map((point) => normalizeTrackRow({ t: point.startTime, lat: point.latitude, lng: point.longitude }))
        .filter((point): point is TrackPoint => point != null)
        .sort((a, b) => a.t - b.t);

      return {
        points,
        nextCursor: data?.positionTrack?.hasNextPage ? (data.positionTrack.endCursor ?? null) : null,
      };
    },

    async fetchExtent({ signal }: { signal?: AbortSignal } = {}): Promise<PositionTrackExtent | null> {
      const { data } = await client.query({
        query: POSITION_TRACK_EXTENT_QUERY,
        fetchPolicy: 'network-only',
        context: signal ? { fetchOptions: { signal } } : undefined,
      });

      const extent = data?.positionTrackExtent;

      if (extent == null) {
        return null;
      }

      const start = new Date(extent.start).getTime();
      const end = new Date(extent.end).getTime();

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }

      return { start, end, count: extent.count };
    },
  };
}

/**
 * Merge two ascending epoch-ms lists into one ascending, de-duplicated list.
 *
 * The playhead stops at both kinds of moment — a position fix and a located
 * memory — and the gap-skip rule needs a single ordered view of them. Linear,
 * because both inputs are already sorted and the position list can hold every
 * fix in a 63k-row history.
 */
export function mergeStops(a: readonly number[], b: readonly number[]): number[] {
  const merged: number[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];

    if (merged.length === 0 || merged[merged.length - 1] !== next) {
      merged.push(next);
    }
  }

  return merged;
}

/**
 * Where the camera is at `time`, interpolated between the two fixes that
 * bracket it. This is the fly-through: a camera fed only the fixes themselves
 * teleports 22 times a day.
 *
 * `revealed` is {@link stopsRevealed}'s answer for the same time, passed in so
 * the per-frame path does one binary search rather than two.
 *
 * Straight-line interpolation is capped by {@link MAX_INTERPOLATION_GAP_MS}.
 * Across a genuine gap — the user flew, or simply had tracking off for three
 * months — a constant-rate glide would invent a plausible-looking journey that
 * never happened, drawing a line through the Atlantic. Past the cap the camera
 * holds at the last real fix, and the gap-skip rule (or the viewer's own seek)
 * is what carries it forward.
 */
export function interpolateAt(
  points: readonly TrackPoint[],
  revealed: number,
  time: number,
): TrackPoint | null {
  if (points.length === 0 || revealed <= 0) {
    return null;
  }

  const previous = points[Math.min(revealed, points.length) - 1];
  const next = revealed < points.length ? points[revealed] : null;

  if (next == null) {
    return previous;
  }

  const span = next.t - previous.t;

  if (span <= 0 || span > MAX_INTERPOLATION_GAP_MS) {
    return previous;
  }

  const ratio = (time - previous.t) / span;

  return {
    t: time,
    lat: previous.lat + (next.lat - previous.lat) * ratio,
    lng: previous.lng + (next.lng - previous.lng) * ratio,
    name: previous.name ?? null,
  };
}

/**
 * Longest gap between two fixes the camera will glide across. Two hours covers
 * a drive with sparse sampling; beyond it the two points are usually either
 * side of a flight or of tracking being switched off. 96% of real gaps in this
 * history are under five minutes, so the cap almost never bites.
 */
export const MAX_INTERPOLATION_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * The tail the map draws behind the moving camera.
 *
 * Capped because `setLatLngs` is O(n) in the points handed to it and the full
 * revealed prefix grows to tens of thousands — redrawing that on every reveal
 * would put a growing cost on a loop that has to stay flat. A bounded tail also
 * reads better: the whole route is already on the map as a faint underlay, and
 * the bright part is meant to say "just now", not "since 2013".
 */
export function trailPoints(
  points: readonly TrackPoint[],
  revealed: number,
  max: number,
): Array<[number, number]> {
  const end = Math.min(Math.max(revealed, 0), points.length);
  const begin = Math.max(0, end - Math.max(max, 0));
  const trail: Array<[number, number]> = [];

  for (let i = begin; i < end; i++) {
    trail.push([points[i].lat, points[i].lng]);
  }

  return trail;
}
