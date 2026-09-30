/**
 * Camera math for handling the 2D force graph directly: the wheel, the zoom buttons, a one-finger
 * pan and a two-finger pinch.
 *
 * Kept out of ForceGraph.tsx, like fitTransform.ts, so the geometry runs as plain functions in the
 * `node` vitest project. The component only feeds these pointer positions and writes back the result.
 *
 * Everything here is in canvas space: pixels from the SVG's top-left corner, which is the space the
 * camera's `translate` is expressed in. A world point `p` is drawn at `p * scale + translate`.
 */

import { clampScale } from './fitTransform';

export type CanvasPoint = { x: number; y: number };

export type Camera = { scale: number; translate: CanvasPoint };

/** Canvas positions of the pointers down on the graph, keyed by pointer id in the order they landed. */
export type PointerPositions = ReadonlyMap<number, CanvasPoint>;

/**
 * Below this finger spacing a change in distance is noise, not a pinch. Two touch points reported on
 * top of each other would otherwise divide by almost nothing and slam the zoom into a limit.
 */
const MIN_PINCH_SPAN_PX = 1;

/**
 * Zoom by `factor` about `anchor`, keeping the world point under the anchor where it is on screen.
 *
 * The scale clamps to the manual zoom range, and the translate follows the scale actually applied
 * rather than the one asked for, so a zoom that runs into a limit still pivots on the anchor instead
 * of sliding the picture sideways. The wheel, the zoom buttons and the pinch all come through here,
 * which is what keeps their limits identical.
 */
export function zoomAt(camera: Camera, anchor: CanvasPoint, factor: number): Camera {
  const scale = clampScale(camera.scale * factor);

  return {
    scale,
    translate: {
      x: anchor.x - ((anchor.x - camera.translate.x) * scale) / camera.scale,
      y: anchor.y - ((anchor.y - camera.translate.y) * scale) / camera.scale,
    },
  };
}

function midpoint(a: CanvasPoint, b: CanvasPoint): CanvasPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function span(a: CanvasPoint, b: CanvasPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * One step of a gesture: where the camera goes when the pointers driving it move from `from` to `to`
 * (the same pointers, in the same order).
 *
 * One pointer drags the picture with it. Two pinch: the zoom follows the change in their spacing,
 * pivoting on their midpoint, and the picture travels with that midpoint. The world point between
 * the fingers therefore stays between them, which is what makes a pinch feel held rather than
 * scaled about the middle of the screen. Pointers past the second are ignored.
 *
 * Applied step by step, as a change from the previous step rather than from where the gesture began.
 * That is what lets the set of fingers change mid-gesture without the picture jumping, and what
 * makes a pinch that has run into a zoom limit turn around the moment the fingers do, instead of
 * first unwinding the overshoot.
 */
export function gestureStep(
  camera: Camera,
  from: readonly CanvasPoint[],
  to: readonly CanvasPoint[],
): Camera {
  if (from.length === 0 || from.length !== to.length) {
    return camera;
  }

  if (from.length === 1) {
    return {
      scale: camera.scale,
      translate: {
        x: camera.translate.x + to[0].x - from[0].x,
        y: camera.translate.y + to[0].y - from[0].y,
      },
    };
  }

  const fromMid = midpoint(from[0], from[1]);
  const toMid = midpoint(to[0], to[1]);
  const fromSpan = span(from[0], from[1]);
  const toSpan = span(to[0], to[1]);
  const factor = fromSpan >= MIN_PINCH_SPAN_PX && toSpan >= MIN_PINCH_SPAN_PX ? toSpan / fromSpan : 1;
  const zoomed = zoomAt(camera, fromMid, factor);

  return {
    scale: zoomed.scale,
    translate: {
      x: zoomed.translate.x + toMid.x - fromMid.x,
      y: zoomed.translate.y + toMid.y - fromMid.y,
    },
  };
}

/**
 * The camera after the pointers on the graph move from `from` to `to`, both keyed by pointer id in
 * the order the pointers landed.
 *
 * The first two pointers to land drive the camera. A third finger rides along without effect, and
 * takes over only once one of the first two lifts. Lifting a finger is not a camera event at all:
 * the caller drops it from both maps, and the next step is measured from where the remaining finger
 * already is. That is what turns a pinch back into a pan without a jump.
 *
 * The caller should hand over every finger's movement since the last step together, rather than
 * one finger's event at a time. Fingers report separately, so taken one at a time the spacing
 * between two fingers moving together flickers wider and narrower. That is harmless mid-range,
 * where it cancels out, but at a zoom limit the clamp swallows every widening and keeps every
 * narrowing: a two-finger pan at full zoom would ratchet the zoom back down.
 */
export function cameraAfterPointersMove(
  camera: Camera,
  from: PointerPositions,
  to: PointerPositions,
): Camera {
  const before: CanvasPoint[] = [];
  const after: CanvasPoint[] = [];

  for (const [pointerId, position] of to) {
    const previous = from.get(pointerId);
    if (!previous) {
      continue;
    }

    before.push(previous);
    after.push(position);

    if (after.length === 2) {
      break;
    }
  }

  return gestureStep(camera, before, after);
}
