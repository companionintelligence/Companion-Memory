/** Leaflet's default tile size, and so the world's width and height in CSS px at zoom 0. */
export const TILE_SIZE = 256;

/**
 * The lowest zoom at which the tiled world still covers a `width` × `height`
 * viewport in both directions.
 *
 * The world is one tile square at zoom 0 and doubles each level, so a tall
 * phone viewport (882 px) needs zoom 2 (1,024 px) before the tiles reach the
 * top and bottom edges; at zoom 1 (512 px) the map sat as a band with blank
 * background above and below it, which is what "a big white area above the
 * map" was. Tiles repeat sideways, so only the larger side matters, but the
 * larger side is the height on a phone and the width on a desktop.
 *
 * Integer, for the default `zoomSnap` of 1: the first level that is big
 * enough, never one that is a few pixels short. Zero for a viewport the
 * single zoom-0 tile already covers (a small map in a card).
 */
export function worldFillMinZoom(width: number, height: number, tileSize = TILE_SIZE): number {
  const longest = Math.max(width, height);

  if (!(longest > tileSize)) {
    return 0;
  }

  return Math.ceil(Math.log2(longest / tileSize));
}
