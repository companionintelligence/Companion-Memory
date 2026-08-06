import { describe, expect, it } from 'vitest';

import {
  CLUSTER_GAP_PX,
  clusterDiameterPx,
  markerDiscY,
  markerRadiusPx,
  mergeCollidingClusters,
  type PixelCluster,
} from './clusterOverlap';

/** n placeholder members — only the count matters to the geometry. */
const cluster = (x: number, y: number, count: number): PixelCluster<number> => ({
  x,
  y,
  items: Array.from({ length: count }, (_, index) => index),
});

/** True when two drawn discs overlap, computed independently of the module under test. */
function discsOverlap(a: PixelCluster<number>, b: PixelCluster<number>): boolean {
  const dx = a.x - b.x;
  const dy = markerDiscY(a.y, a.items.length) - markerDiscY(b.y, b.items.length);

  return Math.hypot(dx, dy) < markerRadiusPx(a.items.length) + markerRadiusPx(b.items.length);
}

describe('cluster marker geometry', () => {
  it('sizes the bubble by digit count, matching makeClusterIcon', () => {
    expect(clusterDiameterPx(2)).toBe(38);
    expect(clusterDiameterPx(9)).toBe(38);
    expect(clusterDiameterPx(34)).toBe(46);
    expect(clusterDiameterPx(120)).toBe(54);
  });

  it('puts a single pin’s disc above its anchor and a bubble on it', () => {
    expect(markerDiscY(500, 1)).toBe(462);
    expect(markerDiscY(500, 7)).toBe(500);
    expect(markerRadiusPx(1)).toBe(24);
    expect(markerRadiusPx(7)).toBe(19);
  });
});

describe('mergeCollidingClusters', () => {
  it('leaves well-separated clusters alone', () => {
    const input = [cluster(100, 100, 11), cluster(400, 300, 34), cluster(800, 120, 3)];

    const merged = mergeCollidingClusters(input);

    expect(merged).toHaveLength(3);
    expect(merged.map((c) => c.items.length).sort((a, b) => a - b)).toEqual([3, 11, 34]);
  });

  it('merges the pair the committed mobile shot shows overlapping', () => {
    // `11` and `34` land 30px apart across a grid-cell edge: radii 23 + 23 + 8
    // of gap needs 54px, so they are drawn on top of each other.
    const merged = mergeCollidingClusters([cluster(500, 500, 11), cluster(528, 512, 34)]);

    expect(merged).toHaveLength(1);
    expect(merged[0].items).toHaveLength(45);
    // Item-weighted, so the bubble barely moves off the bigger of the two.
    expect(merged[0].x).toBeGreaterThan(515);
    expect(merged[0].y).toBeGreaterThan(505);
  });

  it('merges a lone pin sitting on a bubble', () => {
    // Desktop shot: an event pin drawn over the `27` bubble. The pin's disc is
    // 38px up the page from its anchor, which this has to account for.
    const merged = mergeCollidingClusters([cluster(1000, 500, 1), cluster(1030, 462, 27)]);

    expect(merged).toHaveLength(1);
    expect(merged[0].items).toHaveLength(28);
  });

  it('cascades: a merge grows the bubble into a third marker it did not touch', () => {
    // 5-item bubbles are 38px across, so 500 and 560 clear each other (60px apart,
    // 46px needed). Merging 500 with 530 makes a 10-item bubble at 515 that is
    // 46px across — now 45px from 560, which needs 50.
    const merged = mergeCollidingClusters([cluster(500, 500, 5), cluster(530, 500, 5), cluster(560, 500, 5)]);

    expect(merged).toHaveLength(1);
    expect(merged[0].items).toHaveLength(15);
  });

  it('leaves no overlapping pair behind, for a crowded field', () => {
    const input = [
      cluster(120, 240, 1),
      cluster(140, 250, 1),
      cluster(400, 400, 12),
      cluster(432, 408, 4),
      cluster(436, 470, 2),
      cluster(900, 100, 260),
      cluster(940, 130, 3),
      cluster(1400, 800, 7),
    ];

    const merged = mergeCollidingClusters(input);

    for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        expect(discsOverlap(merged[i], merged[j])).toBe(false);
      }
    }

    // Nothing is lost or duplicated.
    expect(merged.reduce((sum, c) => sum + c.items.length, 0)).toBe(
      input.reduce((sum, c) => sum + c.items.length, 0),
    );
  });

  it('keeps a pair exactly at the gap threshold apart', () => {
    const needed = markerRadiusPx(3) + markerRadiusPx(3) + CLUSTER_GAP_PX;

    expect(mergeCollidingClusters([cluster(0, 0, 3), cluster(needed, 0, 3)])).toHaveLength(2);
    expect(mergeCollidingClusters([cluster(0, 0, 3), cluster(needed - 1, 0, 3)])).toHaveLength(1);
  });

  it('handles the empty and single cases', () => {
    expect(mergeCollidingClusters([])).toEqual([]);
    expect(mergeCollidingClusters([cluster(10, 10, 1)])).toHaveLength(1);
  });
});
