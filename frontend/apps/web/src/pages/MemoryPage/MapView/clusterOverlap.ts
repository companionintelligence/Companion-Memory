/**
 * Keeping cluster bubbles off each other.
 *
 * Clustering buckets located entities into a fixed pixel grid at the current zoom. A grid has hard
 * edges: two dense neighbouring cells can each put their centroid near the shared edge, so their
 * bubbles are drawn a few pixels apart and overlap — `11` half-hidden behind `34` in the committed
 * `memory-map-view.mobile.png`, and a pin sitting on top of `27` in the desktop one. A count you
 * cannot read is worse than a coarser cluster, so any two markers whose discs would collide are
 * merged into one bubble carrying both cells' items.
 *
 * The geometry here mirrors what is actually drawn (see `makeClusterIcon` and
 * `components/Map/Marker.tsx`) so the two cannot drift:
 *   - a bucket of one renders the entity PIN: a 48px disc sitting 38px above its anchor point,
 *     because the icon is anchored at the tip of its pointer;
 *   - a bucket of two or more renders a COUNT BUBBLE centred on its anchor, 38/46/54px across
 *     depending on how many digits it has to hold.
 */

/** Marker.tsx: MARKER_DIAMETER. */
const PIN_DIAMETER_PX = 48;
/** Marker.tsx: POINTER_HEIGHT — the disc is drawn this far above the anchored point. */
const PIN_POINTER_OFFSET_PX = 38;
/** Breathing room between two neighbouring markers. Below this they read as one smudge. */
export const CLUSTER_GAP_PX = 8;

/** Diameter of the count bubble for a cluster of `count` items. */
export function clusterDiameterPx(count: number): number {
  return count < 10 ? 38 : count < 100 ? 46 : 54;
}

/** Radius of whatever a bucket of this size actually draws. */
export function markerRadiusPx(count: number): number {
  return count < 2 ? PIN_DIAMETER_PX / 2 : clusterDiameterPx(count) / 2;
}

/**
 * Where the drawn disc's centre sits relative to the projected point. A pin is anchored at the tip
 * of its pointer, so its disc is up the page; a bubble is centred on the point.
 */
export function markerDiscY(y: number, count: number): number {
  return count < 2 ? y - PIN_POINTER_OFFSET_PX : y;
}

export type PixelCluster<T> = { x: number; y: number; items: T[] };

function collides<T>(a: PixelCluster<T>, b: PixelCluster<T>): boolean {
  const dx = a.x - b.x;
  const dy = markerDiscY(a.y, a.items.length) - markerDiscY(b.y, b.items.length);
  const needed = markerRadiusPx(a.items.length) + markerRadiusPx(b.items.length) + CLUSTER_GAP_PX;

  return Math.hypot(dx, dy) < needed;
}

function merge<T>(a: PixelCluster<T>, b: PixelCluster<T>): PixelCluster<T> {
  const total = a.items.length + b.items.length;

  return {
    // Item-weighted, so merging a lone pin into a bubble of thirty barely moves the bubble.
    x: (a.x * a.items.length + b.x * b.items.length) / total,
    y: (a.y * a.items.length + b.y * b.items.length) / total,
    items: [...a.items, ...b.items],
  };
}

/**
 * Merge every pair of markers whose discs would collide, repeatedly — a merge grows a bubble, which
 * can bring it into contact with a third, so this runs to a fixpoint. Bounded by the cluster count:
 * each pass either merges (reducing the count by one) or stops.
 */
export function mergeCollidingClusters<T>(clusters: PixelCluster<T>[]): PixelCluster<T>[] {
  let current = clusters;

  for (let pass = 0; pass < clusters.length; pass += 1) {
    let merged: PixelCluster<T> | null = null;
    let ai = -1;
    let bi = -1;

    outer: for (let i = 0; i < current.length; i += 1) {
      for (let j = i + 1; j < current.length; j += 1) {
        if (collides(current[i], current[j])) {
          merged = merge(current[i], current[j]);
          ai = i;
          bi = j;
          break outer;
        }
      }
    }

    if (!merged) {
      return current;
    }

    current = [...current.filter((_, index) => index !== ai && index !== bi), merged];
  }

  return current;
}
