import { describe, expect, it } from 'vitest';

import {
  cameraAfterPointersMove,
  gestureStep,
  zoomAt,
  type Camera,
  type CanvasPoint,
} from './cameraGestures';
import { MAX_ZOOM, MIN_ZOOM } from './fitTransform';

/** The world point drawn at `screen` under `camera`. */
function worldAt(camera: Camera, screen: CanvasPoint): CanvasPoint {
  return {
    x: (screen.x - camera.translate.x) / camera.scale,
    y: (screen.y - camera.translate.y) / camera.scale,
  };
}

/** Where `world` is drawn under `camera`. */
function screenOf(camera: Camera, world: CanvasPoint): CanvasPoint {
  return {
    x: world.x * camera.scale + camera.translate.x,
    y: world.y * camera.scale + camera.translate.y,
  };
}

function expectPoint(actual: CanvasPoint, expected: CanvasPoint) {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}

const CAMERA: Camera = { scale: 1, translate: { x: 40, y: -20 } };

/**
 * Drives a gesture the way ForceGraph does: pointers report where they are, the camera catches up
 * once per frame with everything that moved since, and a lifted finger is dropped before the next
 * frame. `move` is one finger's event followed by a frame; `moveTogether` is several fingers
 * reporting within one frame, which is how a real two-finger gesture arrives.
 */
class Fingers {
  camera: Camera;

  private readonly applied = new Map<number, CanvasPoint>();

  private readonly current = new Map<number, CanvasPoint>();

  constructor(camera: Camera) {
    this.camera = camera;
  }

  down(id: number, at: CanvasPoint) {
    this.applied.set(id, at);
    this.current.set(id, at);

    return this;
  }

  move(id: number, to: CanvasPoint) {
    return this.moveTogether({ [id]: to });
  }

  moveTogether(moves: Record<number, CanvasPoint>) {
    for (const [id, to] of Object.entries(moves)) {
      this.current.set(Number(id), to);
    }

    this.camera = cameraAfterPointersMove(this.camera, this.applied, this.current);

    for (const [id, position] of this.current) {
      this.applied.set(id, position);
    }

    return this;
  }

  up(id: number) {
    this.applied.delete(id);
    this.current.delete(id);

    return this;
  }
}

describe('zoomAt', () => {
  it('keeps the world point under the anchor where it is on screen', () => {
    const anchor = { x: 210, y: 130 };
    const before = worldAt(CAMERA, anchor);

    const zoomed = zoomAt(CAMERA, anchor, 1.5);

    expect(zoomed.scale).toBeCloseTo(1.5, 10);
    expectPoint(screenOf(zoomed, before), anchor);
  });

  it('clamps to the manual zoom range and still pivots on the anchor at the limit', () => {
    const anchor = { x: 50, y: 300 };
    const before = worldAt(CAMERA, anchor);

    const tooFar = zoomAt(CAMERA, anchor, 10);
    const tooNear = zoomAt(CAMERA, anchor, 0.01);

    expect(tooFar.scale).toBe(MAX_ZOOM);
    expect(tooNear.scale).toBe(MIN_ZOOM);
    // The translate follows the scale actually applied, so nothing under the cursor slides away.
    expectPoint(screenOf(tooFar, before), anchor);
    expectPoint(screenOf(tooNear, before), anchor);
  });

  it('leaves the camera where it is when already pressed against the limit', () => {
    const atMax: Camera = { scale: MAX_ZOOM, translate: { x: -300, y: -120 } };

    const zoomed = zoomAt(atMax, { x: 10, y: 10 }, 1.5);

    expect(zoomed.scale).toBe(MAX_ZOOM);
    expectPoint(zoomed.translate, atMax.translate);
  });
});

describe('gestureStep', () => {
  it('pans by the movement of a single pointer', () => {
    const next = gestureStep(CAMERA, [{ x: 100, y: 100 }], [{ x: 130, y: 80 }]);

    expect(next.scale).toBe(CAMERA.scale);
    expect(next.translate).toEqual({ x: 70, y: -40 });
  });

  it('zooms in by the change in spacing when two fingers spread', () => {
    // 40px apart to 200px apart: five times the spacing, so five times the scale.
    const start: Camera = { scale: 0.5, translate: { x: 0, y: 0 } };

    const next = gestureStep(
      start,
      [
        { x: 180, y: 200 },
        { x: 220, y: 200 },
      ],
      [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ],
    );

    expect(next.scale).toBeCloseTo(2.5, 10);
  });

  it('zooms out by the change in spacing when two fingers pinch in', () => {
    const next = gestureStep(
      CAMERA,
      [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
      [
        { x: 150, y: 100 },
        { x: 250, y: 100 },
      ],
    );

    expect(next.scale).toBeCloseTo(0.5, 10);
  });

  it('keeps the world point between the fingers between them as they spread', () => {
    const between = worldAt(CAMERA, { x: 150, y: 120 });

    const next = gestureStep(
      CAMERA,
      [
        { x: 120, y: 90 },
        { x: 180, y: 150 },
      ],
      [
        { x: 90, y: 60 },
        { x: 210, y: 180 },
      ],
    );

    expect(next.scale).toBeCloseTo(2, 10);
    expectPoint(screenOf(next, between), { x: 150, y: 120 });
  });

  it('carries the picture with the midpoint when both fingers travel together', () => {
    // A two-finger drag with no change in spacing is a pure pan.
    const next = gestureStep(
      CAMERA,
      [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
      [
        { x: 130, y: 160 },
        { x: 230, y: 160 },
      ],
    );

    expect(next.scale).toBeCloseTo(CAMERA.scale, 10);
    expectPoint(next.translate, { x: CAMERA.translate.x + 30, y: CAMERA.translate.y + 60 });
  });

  it('moves what was under the old midpoint to the new one when the fingers zoom and travel at once', () => {
    const grabbed = worldAt(CAMERA, { x: 120, y: 100 });

    const next = gestureStep(
      CAMERA,
      [
        { x: 100, y: 100 },
        { x: 140, y: 100 },
      ],
      [
        { x: 200, y: 250 },
        { x: 280, y: 250 },
      ],
    );

    expect(next.scale).toBeCloseTo(2, 10);
    expectPoint(screenOf(next, grabbed), { x: 240, y: 250 });
  });

  it('does not read two points reported on top of each other as an infinite pinch', () => {
    const stacked = { x: 150, y: 150 };

    const next = gestureStep(CAMERA, [stacked, stacked], [stacked, { x: 190, y: 150 }]);

    expect(next.scale).toBe(CAMERA.scale);
  });

  it('leaves the camera alone when the samples do not describe the same pointers', () => {
    expect(gestureStep(CAMERA, [], [])).toBe(CAMERA);
    expect(gestureStep(CAMERA, [{ x: 0, y: 0 }], [])).toBe(CAMERA);
  });
});

describe('cameraAfterPointersMove', () => {
  it('pinches out, then back in to exactly where it started', () => {
    const fingers = new Fingers(CAMERA)
      .down(1, { x: 180, y: 200 })
      .down(2, { x: 220, y: 200 })
      .move(1, { x: 160, y: 200 })
      .move(2, { x: 240, y: 200 });

    expect(fingers.camera.scale).toBeCloseTo(2, 10);

    fingers.move(1, { x: 180, y: 200 }).move(2, { x: 220, y: 200 });

    expect(fingers.camera.scale).toBeCloseTo(CAMERA.scale, 10);
    expectPoint(fingers.camera.translate, CAMERA.translate);
  });

  it('holds the point under the midpoint even when the fingers report in separate frames', () => {
    // One finger per step: the midpoint wobbles between the fingers, and the grabbed point has to
    // follow it all the way, into the zoom limit and beyond.
    const midpoint = { x: 200, y: 200 };
    const grabbed = worldAt(CAMERA, midpoint);
    const fingers = new Fingers(CAMERA).down(1, { x: 190, y: 200 }).down(2, { x: 210, y: 200 });

    for (let offset = 20; offset <= 80; offset += 10) {
      fingers.move(1, { x: 200 - offset, y: 200 }).move(2, { x: 200 + offset, y: 200 });
    }

    // Asked for 8x, clamped to MAX_ZOOM, and still pinned between the fingers.
    expect(fingers.camera.scale).toBeCloseTo(MAX_ZOOM, 10);
    expectPoint(screenOf(fingers.camera, grabbed), midpoint);
  });

  it('keeps a two-finger pan at full zoom at full zoom', () => {
    // The reason steps take every finger's movement at once. Side by side and sliding left, the
    // left finger reports first: alone, that widens the spacing (clamped away at the limit), and the
    // right finger's report then narrows it again, so each frame would lose a little zoom.
    const atMax: Camera = { scale: MAX_ZOOM, translate: { x: -200, y: -100 } };
    const together = new Fingers(atMax).down(1, { x: 200, y: 200 }).down(2, { x: 260, y: 200 });
    const oneAtATime = new Fingers(atMax).down(1, { x: 200, y: 200 }).down(2, { x: 260, y: 200 });

    for (let step = 1; step <= 10; step += 1) {
      together.moveTogether({ 1: { x: 200 - step * 10, y: 200 }, 2: { x: 260 - step * 10, y: 200 } });
      oneAtATime.move(1, { x: 200 - step * 10, y: 200 }).move(2, { x: 260 - step * 10, y: 200 });
    }

    expect(together.camera.scale).toBe(MAX_ZOOM);
    expectPoint(together.camera.translate, { x: atMax.translate.x - 100, y: atMax.translate.y });
    // What the per-event version would have done instead.
    expect(oneAtATime.camera.scale).toBeLessThan(MAX_ZOOM * 0.9);
  });

  it('continues as a one-finger pan without a jump when a finger lifts mid-pinch', () => {
    const fingers = new Fingers(CAMERA)
      .down(1, { x: 100, y: 100 })
      .down(2, { x: 200, y: 100 })
      .move(2, { x: 250, y: 120 });
    const afterPinch = fingers.camera;

    fingers.up(2).move(1, { x: 110, y: 104 });

    // Measured from where the remaining finger already was, not from the old midpoint.
    expect(fingers.camera.scale).toBe(afterPinch.scale);
    expectPoint(fingers.camera.translate, {
      x: afterPinch.translate.x + 10,
      y: afterPinch.translate.y + 4,
    });
  });

  it('lets the second finger carry on when the FIRST one lifts', () => {
    const fingers = new Fingers(CAMERA)
      .down(1, { x: 100, y: 100 })
      .down(2, { x: 200, y: 100 })
      .move(1, { x: 50, y: 100 });
    const afterPinch = fingers.camera;

    fingers.up(1).move(2, { x: 190, y: 130 });

    expect(fingers.camera.scale).toBe(afterPinch.scale);
    expectPoint(fingers.camera.translate, {
      x: afterPinch.translate.x - 10,
      y: afterPinch.translate.y + 30,
    });
  });

  it('turns a pan into a pinch when a second finger lands, measured from where it landed', () => {
    const fingers = new Fingers(CAMERA).down(1, { x: 100, y: 100 }).move(1, { x: 120, y: 110 });
    const afterPan = fingers.camera;

    fingers.down(2, { x: 220, y: 110 }).move(2, { x: 320, y: 110 });

    // 100px apart to 200px apart, pivoting on the midpoint the fingers had when the second landed.
    const grabbed = worldAt(afterPan, { x: 170, y: 110 });

    expect(fingers.camera.scale).toBeCloseTo(afterPan.scale * 2, 10);
    expectPoint(screenOf(fingers.camera, grabbed), { x: 220, y: 110 });
  });

  it('ignores a third finger until one of the first two lifts', () => {
    const fingers = new Fingers(CAMERA)
      .down(1, { x: 100, y: 100 })
      .down(2, { x: 200, y: 100 })
      .down(3, { x: 400, y: 50 })
      .move(3, { x: 500, y: 300 });

    expect(fingers.camera).toEqual(CAMERA);

    // With finger 1 gone, fingers 2 and 3 are the pinch, measured from where they are now.
    fingers.up(1).move(3, { x: 700, y: 300 });

    expect(fingers.camera.scale).toBeCloseTo(Math.hypot(500, 200) / Math.hypot(300, 200), 10);
  });

  it('stops at MAX_ZOOM and zooms back out the moment the fingers reverse', () => {
    const fingers = new Fingers({ scale: 2, translate: { x: 0, y: 0 } })
      .down(1, { x: 150, y: 200 })
      .down(2, { x: 250, y: 200 })
      // Four times the spacing asks for 8, and gets MAX_ZOOM.
      .moveTogether({ 1: { x: 0, y: 200 }, 2: { x: 400, y: 200 } });

    expect(fingers.camera.scale).toBe(MAX_ZOOM);

    // No dead zone while the overshoot unwinds: a 10% pinch-in is a 10% zoom-out from the limit.
    fingers.move(2, { x: 360, y: 200 });

    expect(fingers.camera.scale).toBeCloseTo(MAX_ZOOM * 0.9, 10);
  });

  it('stops at MIN_ZOOM when pinched in past it', () => {
    const fingers = new Fingers({ scale: 0.5, translate: { x: 0, y: 0 } })
      .down(1, { x: 0, y: 0 })
      .down(2, { x: 400, y: 0 })
      .move(2, { x: 40, y: 0 });

    expect(fingers.camera.scale).toBe(MIN_ZOOM);
  });

  it('leaves the camera alone for a pointer it was not already tracking', () => {
    const from = new Map([[1, { x: 100, y: 100 }]]);
    const to = new Map([[7, { x: 0, y: 0 }]]);

    expect(cameraAfterPointersMove(CAMERA, from, to)).toBe(CAMERA);
  });
});
