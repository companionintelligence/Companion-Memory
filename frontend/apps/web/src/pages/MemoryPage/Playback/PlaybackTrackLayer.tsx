import { useEffect, useMemo } from 'react';

import L from 'leaflet';
import { useMap as useLeafletMap } from 'react-leaflet';

import { FLY_DURATION_S, easeToward, needsRecentre, shouldFly } from './camera';
import { stopsRevealed, type PlaybackState } from './playbackMachine';
import { interpolateAt, trailPoints } from './positionTrack';
import { usePlayback, usePlaybackControls } from './usePlayback';
import { useReducedMotion } from './useReducedMotion';

import './playback.css';

/**
 * The fly-through itself: the trace, the moving head, and the camera that
 * follows it.
 *
 * Everything in here is imperative Leaflet driven from a frame subscription,
 * and that is the design rather than an optimisation. React's job ends at
 * mounting three layers; the per-frame work — one binary search, one linear
 * interpolation, at most one `setLatLngs` — never allocates a component, never
 * touches state, and therefore never re-renders the timeline panel or the ten
 * thousand clustered markers sharing this map.
 *
 * The camera is what makes it read as flying rather than as stepping. It eases
 * toward the playhead instead of being welded to it, so a burst of closely
 * spaced fixes reads as acceleration and a long straight run reads as cruising
 * — the same trick as {@link AnimatedBackground}'s spring, for the same reason.
 * Genuinely large jumps (a flight, a three-month gap the skip rule crossed) get
 * Leaflet's own `flyTo`, which zooms out, travels, and zooms back in.
 *
 * ## What this actually does today
 *
 * Everything above describes what runs once `pointsRef` holds fixes from
 * `/api/position/track` — a sibling change, not yet deployed, so that request
 * 404s on the live API as of this writing. `onFrame` below returns immediately
 * when `points.length === 0`: no trail, no head marker, no camera movement AT
 * ALL. This component is a no-op right now. What still ships without it is
 * everything upstream of this file — the located pins reveal progressively
 * (`useRevealedPins`) and the timeline panel highlights and scrolls with the
 * playhead (`usePlayheadPin`), through the located-memory times alone. "Play
 * back my life" is honest today as progressive pin reveal plus a synchronised
 * timeline highlight; the moving camera and drawn trace described above
 * activate the moment the position-track endpoint lands, with no further
 * changes here — see `positionTrack.ts` for the adapter and its 404 fallback.
 */

/** Points kept in the bright "just now" tail. See {@link trailPoints}. */
const TRAIL_MAX_POINTS = 600;

export function PlaybackTrackLayer() {
  const map = useLeafletMap();
  const { store, pointsRef, timesRef, pointsVersion } = usePlayback();
  const { status } = usePlaybackControls();
  const reducedMotion = useReducedMotion();

  // Nothing is drawn until a playback has been started, and everything is
  // removed again when it is stopped: an untouched map is an untouched map.
  // `idle` is reachable both ways — it is where the view starts, and where the
  // transport's Stop returns it to.
  const active = status !== 'idle';

  // The whole loaded window, drawn faintly: the route ahead. Redrawn only when
  // a page lands, never per frame.
  const routeLayer = useMemo(
    () => L.polyline([], { className: 'memory-playback-route', weight: 2, interactive: false }),
    [],
  );
  // The revealed tail, drawn brightly.
  const trailLayer = useMemo(
    () => L.polyline([], { className: 'memory-playback-trail', weight: 4, interactive: false }),
    [],
  );
  const headLayer = useMemo(
    () => L.circleMarker([0, 0], { className: 'memory-playback-head', radius: 6, interactive: false }),
    [],
  );

  useEffect(() => {
    if (!active) {
      return;
    }

    routeLayer.addTo(map);
    trailLayer.addTo(map);

    return () => {
      routeLayer.remove();
      trailLayer.remove();
      headLayer.remove();
    };
  }, [map, active, routeLayer, trailLayer, headLayer]);

  useEffect(() => {
    routeLayer.setLatLngs(pointsRef.current.map((point) => [point.lat, point.lng] as [number, number]));
  }, [routeLayer, pointsRef, pointsVersion]);

  useEffect(() => {
    if (!active) {
      return;
    }

    // Camera state lives in the closure, not in refs shared with React: nothing
    // outside this effect may read or write it, and it must reset whenever the
    // map or the motion preference changes.
    let cameraLat: number | null = null;
    let cameraLng: number | null = null;
    let flying = false;
    // Reveal count at the last trail redraw. `setLatLngs` is the only
    // non-constant-time thing on this path, so it is skipped whenever the
    // playhead has not actually crossed a fix.
    let drawnRevealed = -1;
    let headAttached = false;

    const onFlyEnd = () => {
      flying = false;
    };

    map.on('moveend', onFlyEnd);

    const onFrame = (state: PlaybackState) => {
      const points = pointsRef.current;

      if (points.length === 0) {
        return;
      }

      const revealed = stopsRevealed(timesRef.current, state.cursor);
      const head = interpolateAt(points, revealed, state.cursor);

      if (head == null) {
        // Before the first fix in range: nothing has happened yet.
        if (headAttached) {
          headLayer.remove();
          headAttached = false;
        }

        if (drawnRevealed !== 0) {
          trailLayer.setLatLngs([]);
          drawnRevealed = 0;
        }

        return;
      }

      if (!headAttached) {
        headLayer.addTo(map);
        headAttached = true;
      }

      headLayer.setLatLng([head.lat, head.lng]);

      if (revealed !== drawnRevealed) {
        trailLayer.setLatLngs(trailPoints(points, revealed, TRAIL_MAX_POINTS));
        drawnRevealed = revealed;
      }

      // ── Camera ──────────────────────────────────────────────────────────
      // A paused playhead is the viewer's, not ours: they may be panning away
      // to look at something, and yanking the view back would fight them.
      if (state.status !== 'playing' || flying) {
        cameraLat = head.lat;
        cameraLng = head.lng;

        return;
      }

      if (cameraLat == null || cameraLng == null) {
        cameraLat = head.lat;
        cameraLng = head.lng;
        map.setView([head.lat, head.lng], map.getZoom(), { animate: false });

        return;
      }

      if (reducedMotion) {
        // Step, don't glide: re-centre only once the head is about to leave the
        // safe area, and do it without an animation.
        if (needsRecentre(map.latLngToContainerPoint([head.lat, head.lng]), map.getSize())) {
          cameraLat = head.lat;
          cameraLng = head.lng;
          map.setView([head.lat, head.lng], map.getZoom(), { animate: false });
        }

        return;
      }

      const zoom = map.getZoom();
      const travelled = map
        .project([cameraLat, cameraLng], zoom)
        .distanceTo(map.project([head.lat, head.lng], zoom));

      if (shouldFly(travelled, map.getSize().x)) {
        flying = true;
        cameraLat = head.lat;
        cameraLng = head.lng;
        map.flyTo([head.lat, head.lng], zoom, { duration: FLY_DURATION_S });

        return;
      }

      cameraLat = easeToward(cameraLat, head.lat);
      cameraLng = easeToward(cameraLng, head.lng);

      map.setView([cameraLat, cameraLng], zoom, { animate: false });
    };

    const unsubscribe = store.subscribeFrame(onFrame);

    // Draw once on mount so a paused playhead is visible before the first tick.
    onFrame(store.getState());

    return () => {
      unsubscribe();
      map.off('moveend', onFlyEnd);
    };
  }, [map, active, store, pointsRef, timesRef, trailLayer, headLayer, reducedMotion]);

  return null;
}
