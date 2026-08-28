import { describe, expect, it } from 'vitest';

import { CAMERA_EASE, FLY_THRESHOLD_SCREENS, easeToward, needsRecentre, shouldFly } from './camera';

const VIEWPORT = { x: 1_000, y: 600 };

describe('shouldFly', () => {
  it('glides a move within a couple of screen-widths', () => {
    expect(shouldFly(500, VIEWPORT.x)).toBe(false);
    expect(shouldFly(FLY_THRESHOLD_SCREENS * VIEWPORT.x, VIEWPORT.x)).toBe(false);
  });

  it('arcs a move far larger than the screen', () => {
    expect(shouldFly(FLY_THRESHOLD_SCREENS * VIEWPORT.x + 1, VIEWPORT.x)).toBe(true);
  });

  it('scales with the viewport, so a phone and a desktop agree about "far"', () => {
    // The same 2,000px journey is a fly on a 375px phone and a glide on a 1000px desktop.
    expect(shouldFly(2_000, 375)).toBe(true);
    expect(shouldFly(2_000, 1_000)).toBe(false);
  });

  it('does not divide by a zero-width viewport', () => {
    expect(shouldFly(10, 0)).toBe(true);
  });
});

describe('needsRecentre', () => {
  it('holds still while the playhead is comfortably on screen', () => {
    expect(needsRecentre({ x: 500, y: 300 }, VIEWPORT)).toBe(false);
  });

  it('steps once the playhead reaches the edge of the safe area', () => {
    // 60% safe area on a 1000px-wide viewport leaves a 200px margin each side.
    expect(needsRecentre({ x: 199, y: 300 }, VIEWPORT)).toBe(true);
    expect(needsRecentre({ x: 801, y: 300 }, VIEWPORT)).toBe(true);
    expect(needsRecentre({ x: 500, y: 119 }, VIEWPORT)).toBe(true);
    expect(needsRecentre({ x: 500, y: 481 }, VIEWPORT)).toBe(true);
  });

  it('a tighter safe area re-centres sooner', () => {
    // 0.2 leaves a 400px margin each side; 0.6 leaves 200px.
    expect(needsRecentre({ x: 300, y: 300 }, VIEWPORT, 0.6)).toBe(false);
    expect(needsRecentre({ x: 300, y: 300 }, VIEWPORT, 0.2)).toBe(true);
  });
});

describe('easeToward', () => {
  it('moves a fixed fraction of the remaining distance', () => {
    expect(easeToward(0, 100, 0.25)).toBe(25);
    expect(easeToward(0, 100)).toBeCloseTo(100 * CAMERA_EASE);
  });

  it('converges without overshooting', () => {
    let value = 0;

    for (let frame = 0; frame < 200; frame++) {
      value = easeToward(value, 10);
      expect(value).toBeLessThanOrEqual(10);
    }

    expect(value).toBeCloseTo(10, 5);
  });

  it('is a no-op when it is already there', () => {
    expect(easeToward(42, 42)).toBe(42);
  });
});
