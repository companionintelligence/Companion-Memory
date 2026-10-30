import { describe, expect, it } from 'vitest';

import { worldFillMinZoom } from './worldFill';

describe('worldFillMinZoom', () => {
  it('is zero when one tile already covers the viewport', () => {
    expect(worldFillMinZoom(200, 150)).toBe(0);
    expect(worldFillMinZoom(256, 256)).toBe(0);
    expect(worldFillMinZoom(0, 0)).toBe(0);
  });

  it('needs zoom 2 for a phone in portrait — zoom 1 left a blank band above and below the tiles', () => {
    expect(worldFillMinZoom(411, 882)).toBe(2);
  });

  it('is driven by the longer side, whichever that is', () => {
    expect(worldFillMinZoom(882, 411)).toBe(2);
    expect(worldFillMinZoom(1920, 900)).toBe(3);
  });

  it('rounds UP: a viewport a pixel wider than the world at a level needs the next level', () => {
    expect(worldFillMinZoom(512, 300)).toBe(1);
    expect(worldFillMinZoom(513, 300)).toBe(2);
  });
});
