import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useApolloClient } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

import { isEmptyRange, stopsRevealed, type PlaybackRange, type PlaybackState } from './playbackMachine';
import { createPlaybackStore, type PlaybackControlSnapshot, type PlaybackStore } from './PlaybackStore';
import {
  TRACK_PAGE_SIZE,
  TRACK_PREFETCH_LEAD,
  createGraphqlPositionTrackSource,
  mergeStops,
  type PositionTrackSource,
  type TrackPoint,
} from './positionTrack';

/** The minimum a map pin has to carry for the playhead to reveal it. */
export interface PlaybackPin {
  id: string;
  coords: { lat: number; lng: number };
  /** Epoch ms. Pins with no time (sortTime 0) are filtered out before we see them. */
  sortTime: number;
}

export interface PlaybackHookArgs {
  /** The map's located memories, ascending by time. */
  pins: readonly PlaybackPin[];
  /**
   * Swappable position-track reader. Defaults to the REST adapter; the point of
   * the seam is that the paginated `ci.position` query being built separately
   * can be dropped in here without touching a component. See `positionTrack.ts`.
   */
  source?: PositionTrackSource;
}

/**
 * How much runway to load before the first frame. Two pages, so playback starts
 * with a page of track already buffered and a page in flight.
 */
const EAGER_PAGES = 2;

function usePlaybackController({ pins, source }: PlaybackHookArgs) {
  const [searchParams] = useSearchParams();
  const apolloClient = useApolloClient();
  // `positionTrack`/`positionTrackExtent` now exist and are wired (see
  // `positionTrack.ts`'s `createGraphqlPositionTrackSource` docblock) — the
  // REST adapter this defaulted to is dead code kept only for the handful of
  // tests/stories that construct their own source directly.
  const trackSource = useMemo(
    () => source ?? createGraphqlPositionTrackSource(apolloClient),
    [source, apolloClient],
  );

  // The playback range is the explorer's OWN date filter — `?from`/`?to`, the
  // same two params the toolbar's date control and the activity heatmap already
  // read and write. Playback deliberately adds no third date mechanism: narrowing
  // the film is the same gesture as narrowing the search, and a shared link
  // replays the same stretch of life it searched.
  const filterRange = useMemo(() => {
    const from = parseIso(searchParams.get('from'));
    const to = parseIso(searchParams.get('to'));

    return { from, to };
  }, [searchParams]);

  // Extent of the position track, so an unfiltered playback can span the user's
  // real history without downloading 63,044 rows to find out where it starts.
  const [trackExtent, setTrackExtent] = useState<{ start: number; end: number; count: number } | null>(null);
  const [extentResolved, setExtentResolved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void trackSource
      .fetchExtent({ signal: controller.signal })
      .then((extent) => {
        if (!cancelled) {
          setTrackExtent(extent);
        }
      })
      .catch(() => {
        // A missing/failing extent is not fatal: the pins the map is already
        // showing give a usable, if coarser, range.
        if (!cancelled) {
          setTrackExtent(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExtentResolved(true);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trackSource]);

  const pinExtent = useMemo(() => {
    const dated = pins.filter((pin) => pin.sortTime > 0);

    if (dated.length === 0) {
      return null;
    }

    return { start: dated[0].sortTime, end: dated[dated.length - 1].sortTime };
  }, [pins]);

  const range = useMemo<PlaybackRange>(() => {
    const substrate = trackExtent ?? pinExtent;
    const start = filterRange.from ?? substrate?.start ?? Number.NaN;
    const end = filterRange.to ?? substrate?.end ?? Number.NaN;

    return { start, end };
  }, [filterRange, trackExtent, pinExtent]);

  // One store for the life of the view. The range it was created with is
  // provisional (the extent resolves asynchronously); `setRange` below is what
  // actually configures it.
  const storeRef = useRef<PlaybackStore | null>(null);
  storeRef.current ??= createPlaybackStore(range);
  const store = storeRef.current;

  useEffect(() => () => store.destroy(), [store]);

  useEffect(() => {
    store.dispatch({ type: 'setRange', range });
  }, [store, range]);

  // Nothing is fetched until the viewer actually starts a playback. The map is
  // a map first: opening it should not pull four thousand GPS fixes down for a
  // fly-through nobody asked for. The extent read above is the exception —
  // it is one row, and the bar cannot decide whether to exist without it.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    return store.subscribeControl(() => {
      if (store.getControlSnapshot().status !== 'idle') {
        setArmed(true);
      }
    });
  }, [store]);

  // ── Track paging ──────────────────────────────────────────────────────────
  // Points accumulate in a ref because the Leaflet layer reads them on every
  // frame and must not be re-rendered to see a new page. `pointsVersion` is the
  // coarse React-visible signal that a page landed.
  const pointsRef = useRef<TrackPoint[]>([]);
  const timesRef = useRef<number[]>([]);
  const [pointsVersion, setPointsVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const exhaustedRef = useRef(false);
  const inFlightRef = useRef(false);
  // Bumped on every range change; a page that resolves against a stale
  // generation is dropped rather than appended to the new range's track.
  const generationRef = useRef(0);

  const loadNextPage = useCallback(async () => {
    if (inFlightRef.current || exhaustedRef.current || isEmptyRange(range)) {
      return;
    }

    const generation = generationRef.current;
    inFlightRef.current = true;
    setLoading(true);

    try {
      const page = await trackSource.fetchPage({
        start: new Date(range.start).toISOString(),
        end: new Date(range.end).toISOString(),
        after: cursorRef.current,
        limit: TRACK_PAGE_SIZE,
      });

      if (generation !== generationRef.current) {
        return;
      }

      if (page.points.length > 0) {
        pointsRef.current = pointsRef.current.concat(page.points);
        timesRef.current = pointsRef.current.map((point) => point.t);
      }

      cursorRef.current = page.nextCursor;
      exhaustedRef.current = page.nextCursor == null;
      setPointsVersion((version) => version + 1);
      setError(null);
    } catch (cause) {
      if (generation === generationRef.current) {
        // Stop paging on a hard failure — retrying every frame would hammer a
        // server that is already unhappy. The bar surfaces it and offers a retry.
        exhaustedRef.current = true;
        setError(cause instanceof Error ? cause.message : 'Could not load your location history.');
      }
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current = false;
        setLoading(false);
      }
    }
  }, [range, trackSource]);

  // A new range is a new track: drop what we have and load the opening pages.
  useEffect(() => {
    generationRef.current += 1;
    pointsRef.current = [];
    timesRef.current = [];
    cursorRef.current = null;
    exhaustedRef.current = false;
    inFlightRef.current = false;
    setPointsVersion((version) => version + 1);
    setError(null);

    if (isEmptyRange(range) || !armed) {
      return;
    }

    let cancelled = false;

    void (async () => {
      for (let page = 0; page < EAGER_PAGES && !cancelled && !exhaustedRef.current; page++) {
        await loadNextPage();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [range, loadNextPage, armed]);

  // Prefetch the next window as the playhead approaches the loaded edge. This
  // is the whole reason paging exists here: without it the fly-through would
  // either stall at the end of page one or issue a request per frame.
  //
  // Gated on `armed`, and `armed` is in the dependency array so this
  // resubscribes with a fresh closure the moment it flips. Pressing play
  // dispatches into the store, which notifies BOTH subscription channels —
  // control listeners (the one above, which flips `armed`) then frame
  // listeners (this one) — in the same synchronous call, before React has
  // re-rendered. Without the gate, this listener would fire on that very
  // first frame against an empty `timesRef` (nothing loaded yet, since the
  // range effect above was still waiting on `armed`), treat "0 of 0 points
  // loaded" as "must fetch", and kick off a page load the range effect then
  // immediately stepped on — bumping the generation and resetting
  // `inFlightRef` out from under the in-flight request. Net effect: three
  // requests for what should be two eager pages, one of them a full response
  // fetched, parsed, and discarded.
  useEffect(() => {
    return store.subscribeFrame((state) => {
      if (!armed || exhaustedRef.current || inFlightRef.current) {
        return;
      }

      const revealed = stopsRevealed(timesRef.current, state.cursor);

      if (revealed >= timesRef.current.length - TRACK_PREFETCH_LEAD) {
        void loadNextPage();
      }
    });
  }, [store, loadNextPage, armed]);

  // ── Stops ────────────────────────────────────────────────────────────────
  // Every moment the playhead can meaningfully stop at: a position fix or a
  // located memory. Merged so gap-skipping treats them as one timeline — a day
  // with no GPS but three photographs is not dead air.
  const pinTimes = useMemo(() => pins.map((pin) => pin.sortTime).filter((time) => time > 0), [pins]);

  // `pointsVersion` is the dependency that matters here, not `timesRef`: the
  // times live in a ref because the frame loop reads them without re-rendering,
  // and a ref cannot itself trigger a recompute. Every append bumps the version.
  const stops = useMemo(() => mergeStops(timesRef.current, pinTimes), [pointsVersion, pinTimes]);

  useEffect(() => {
    store.dispatch({ type: 'setStops', stops });
  }, [store, stops]);

  const retry = useCallback(() => {
    exhaustedRef.current = false;
    setError(null);
    void loadNextPage();
  }, [loadNextPage]);

  return {
    store,
    pins,
    pointsRef,
    /** Ascending epoch-ms of `pointsRef`, kept alongside it for binary search. */
    timesRef,
    pointsVersion,
    stops,
    loading,
    error,
    retry,
    /**
     * Whether a real position track exists for this user at all. Read from the
     * extent rather than from what happens to be loaded, so the bar can say
     * "located memories only" before the first page is even requested. False
     * means the playback is running on pins alone — far fewer points, and no
     * trace between them — which the bar says out loud rather than pretending.
     */
    hasTrack: (trackExtent?.count ?? 0) > 0,
    /** The extent read has finished, so "no track" is an answer and not a wait. */
    ready: extentResolved,
    trackCount: trackExtent?.count ?? 0,
  };
}

function parseIso(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

const { Provider, useHookContext, useOptionalHookContext } = createHookContext(
  usePlaybackController,
  'usePlayback',
);

/** Everything the playback resolved: the store, the track, and how it is going. */
const usePlayback = useHookContext;

/**
 * The playback context when there is one.
 *
 * Map chrome that merely needs to KNOW playback is running — the "search this
 * area" control, which must not treat a camera fly as the user panning away —
 * reads it through here so it keeps working outside a provider.
 */
const useOptionalPlayback = useOptionalHookContext;

export { Provider as PlaybackProvider, usePlayback, useOptionalPlayback };

/** Transport state for React consumers. Changes only when the viewer acts. */
export function usePlaybackControls(): PlaybackControlSnapshot {
  const { store } = usePlayback();

  return useSyncExternalStore(store.subscribeControl, store.getControlSnapshot, store.getControlSnapshot);
}

/**
 * The playhead, sampled for React at a human rate rather than a frame rate.
 *
 * Anything that renders — the scrubber thumb, the date read-out, the revealed
 * pin set — reads it through here. `intervalMs` is the contract: a component
 * that asks for 200ms is promising it is cheap to re-render five times a
 * second, and the map layer that cannot make that promise subscribes to frames
 * directly instead.
 */
export function usePlaybackCursor(intervalMs = 200): number {
  const { store } = usePlayback();
  const [cursor, setCursor] = useState(() => store.getState().cursor);
  const lastEmittedRef = useRef(0);

  useEffect(() => {
    const flush = (state: PlaybackState) => {
      lastEmittedRef.current = Date.now();
      setCursor(state.cursor);
    };

    // Seek/pause/end must land immediately — a scrub that visibly lags the
    // thumb by a fifth of a second feels broken.
    const unsubscribe = store.subscribeFrame((state) => {
      if (state.status !== 'playing' || Date.now() - lastEmittedRef.current >= intervalMs) {
        flush(state);
      }
    });

    flush(store.getState());

    return unsubscribe;
  }, [store, intervalMs]);

  return cursor;
}

/**
 * The pins the map should be drawing right now.
 *
 * Progressive reveal is the point of a playback — the world fills in as the
 * playhead crosses each memory — but only once a playback has actually been
 * started. While the transport is untouched (`idle`) the map is just a map and
 * every pin is on it; hiding them because a control the user has not pressed is
 * parked at the start of time would be a regression dressed as a feature.
 *
 * Memoised on the REVEALED COUNT rather than on the cursor, so the returned
 * array keeps its identity between the moments the playhead crosses a pin. That
 * identity is what stops the clustering pass — which projects every pin in the
 * viewport — from running on every sample.
 */
export function useRevealedPins<T extends { sortTime: number }>(pins: T[], intervalMs = 200): T[] {
  const { status } = usePlaybackControls();
  const cursor = usePlaybackCursor(intervalMs);
  // Undated (sortTime 0) pins have no place on a timeline — usePlaybackPins in
  // MapView.tsx already strips them before the provider's `pins` ever reach the
  // store, so they contribute to neither `stops` nor `stopCount`. Filtering the
  // same way here keeps this hook in step with that: without it, a sortTime-0
  // pin sorts to the very front of an ascending list and reads as "already
  // revealed" on frame one, popping in before the film has even started.
  const dated = useMemo(() => pins.filter((pin) => pin.sortTime > 0), [pins]);
  const times = useMemo(() => dated.map((pin) => pin.sortTime), [dated]);
  const revealed = status === 'idle' ? dated.length : stopsRevealed(times, cursor);

  return useMemo(() => {
    // Idle is the one case where undated pins belong: the transport is
    // untouched and the map is just a map, every pin included.
    if (status === 'idle') {
      return pins;
    }

    return revealed >= dated.length ? dated : dated.slice(0, revealed);
  }, [status, pins, dated, revealed]);
}

/**
 * The memory the playhead has most recently passed, for the timeline panel to
 * highlight and scroll to.
 *
 * This is the "synchronised cursor across BOTH surfaces": the same playhead
 * that moves the camera picks the row, through the timeline's existing
 * `activeEntityId` prop — no second selection mechanism, and hovering a pin
 * still wins when playback is not running.
 */
export function usePlayheadPin<T extends { id: string; sortTime: number }>(
  pins: T[],
  intervalMs = 200,
): T | null {
  const { status } = usePlaybackControls();
  const cursor = usePlaybackCursor(intervalMs);
  // Same filter as useRevealedPins, and for the same reason: an undated pin
  // sorts first and would otherwise be handed to the timeline as the playhead
  // memory before the film has moved at all (effectively at t = range.start).
  const dated = useMemo(() => pins.filter((pin) => pin.sortTime > 0), [pins]);
  const times = useMemo(() => dated.map((pin) => pin.sortTime), [dated]);

  if (status === 'idle' || dated.length === 0) {
    return null;
  }

  const revealed = stopsRevealed(times, cursor);

  return revealed > 0 ? dated[revealed - 1] : null;
}

/**
 * A track source that answers nothing, for surfaces with no position history to
 * read: the read-only /shared viewer resolves the OWNER's saved search, and
 * `ci.position` is never shared by a saved search. Playback there runs on the
 * shared pins alone.
 */
export const EMPTY_TRACK_SOURCE: PositionTrackSource = {
  fetchPage: async () => ({ points: [], nextCursor: null }),
  fetchExtent: async () => null,
};
