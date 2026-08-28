/**
 * The camera's three decisions, extracted from the Leaflet layer so they can be
 * reasoned about (and tested) without a map.
 *
 * Everything here is in SCREEN space — projected pixels and viewport
 * dimensions — because that is the space the questions actually live in. "Is
 * this jump big?" is not a question about degrees of latitude: a hundred metres
 * is a huge move at street zoom and invisible at country zoom.
 */

/** Fraction of the remaining distance the camera covers each frame. */
export const CAMERA_EASE = 0.14;

/**
 * Beyond this many screen-widths of travel, easing looks like a slow drag
 * across an empty ocean. Hand it to Leaflet's `flyTo`, which arcs out and back.
 */
export const FLY_THRESHOLD_SCREENS = 2.5;

/** Seconds Leaflet spends on that arc. Long enough to read, short enough to sit through. */
export const FLY_DURATION_S = 1.1;

/**
 * With reduced motion the camera only moves when the playhead would otherwise
 * leave this centred fraction of the viewport — so it steps, rarely, instead of
 * panning continuously.
 */
export const REDUCED_MOTION_SAFE_AREA = 0.6;

/**
 * Whether a move is big enough to deserve Leaflet's zoom-out-and-back arc
 * rather than a frame-by-frame glide.
 *
 * Measured against the viewport WIDTH rather than an absolute pixel count, so
 * the same journey reads the same way on a phone and on a 5K display.
 */
export function shouldFly(distancePx: number, viewportWidthPx: number): boolean {
  return distancePx / Math.max(viewportWidthPx, 1) > FLY_THRESHOLD_SCREENS;
}

/**
 * Whether a reduced-motion camera has to step, i.e. the playhead has reached
 * the edge of the centred safe area and is about to leave the screen.
 *
 * Returning false is the point of the whole function: a viewer who asked for
 * reduced motion should see the map hold still for as long as the playhead is
 * comfortably on it.
 */
export function needsRecentre(
  point: { x: number; y: number },
  size: { x: number; y: number },
  safeArea: number = REDUCED_MOTION_SAFE_AREA,
): boolean {
  const marginX = (size.x * (1 - safeArea)) / 2;
  const marginY = (size.y * (1 - safeArea)) / 2;

  return point.x < marginX || point.x > size.x - marginX || point.y < marginY || point.y > size.y - marginY;
}

/**
 * One frame of exponential easing toward a target.
 *
 * Deliberately frame-rate-relative rather than time-corrected: the store
 * already clamps how much memory time a slow frame may claim, so the camera
 * arriving a fraction late on a stuttering machine is the lesser evil compared
 * with the overshoot a `dt`-scaled factor produces when a frame is very long.
 */
export function easeToward(current: number, target: number, factor: number = CAMERA_EASE): number {
  return current + (target - current) * factor;
}
