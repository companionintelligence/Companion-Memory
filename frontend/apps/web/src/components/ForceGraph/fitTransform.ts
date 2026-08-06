/**
 * Framing for the 2D force graph.
 *
 * The simulation recentres the node MEAN on the canvas middle, which is not the same as filling
 * the canvas: a tight cluster settles into a ~300px blob in the middle of a 640px canvas with the
 * top third empty, and the nodes the recentring nudge leaves near an edge sit half off it. Once the
 * simulation settles, the view is framed on what it produced — the bounding box of the nodes AND
 * their labels — the way the memory map's FitBoundsOnce frames its pins.
 *
 * Kept out of ForceGraph.tsx so it can be exercised as pure geometry in the `node` vitest project.
 */

export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 3;

export const clampScale = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** Largest node radius (12, when selected) plus its stroke. */
const NODE_EXTENT_PX = 14;
/** Average advance of the text-xs label, which is drawn to the right of the node. */
const LABEL_CHAR_PX = 6.4;
/** The label's baseline sits below the node centre. */
const LABEL_BASELINE_PX = 14;
const FIT_PADDING_PX = 16;

export type FitNode = {
  x: number;
  y: number;
  name?: string | null;
  entity_type?: string | null;
};

export type FitTransform = { scale: number; translate: { x: number; y: number } };

/**
 * The transform that puts every node and label inside the canvas with a small margin.
 *
 * `anchor` — the position of a node the simulation pins to the canvas centre (`centerNodeId`) —
 * keeps that node in the middle: the fit then measures the FURTHEST reach from it rather than the
 * bounding box's own centre, so "the thing you anchored is in the middle" survives the reframe.
 * Without it the bounding box is simply centred.
 *
 * Returns null when there is nothing to frame (no nodes, or no finite positions), so the caller
 * leaves the current view alone rather than snapping to an arbitrary one.
 */
export function fitTransform(
  nodes: readonly FitNode[],
  boundsWidth: number,
  boundsHeight: number,
  anchor?: { x: number; y: number } | null,
): FitTransform | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      continue;
    }

    const label = node.name ?? node.entity_type ?? '';

    minX = Math.min(minX, node.x - NODE_EXTENT_PX);
    maxX = Math.max(maxX, node.x + NODE_EXTENT_PX + label.length * LABEL_CHAR_PX);
    minY = Math.min(minY, node.y - NODE_EXTENT_PX);
    maxY = Math.max(maxY, node.y + LABEL_BASELINE_PX);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }

  // What has to fit, and around which point. Anchored: twice the furthest reach from the anchor,
  // because it stays dead centre and the canvas has to hold the worst side twice over.
  const centreX = anchor ? anchor.x : (minX + maxX) / 2;
  const centreY = anchor ? anchor.y : (minY + maxY) / 2;
  const spanX = anchor ? Math.max(2 * Math.max(centreX - minX, maxX - centreX), 1) : Math.max(maxX - minX, 1);
  const spanY = anchor ? Math.max(2 * Math.max(centreY - minY, maxY - centreY), 1) : Math.max(maxY - minY, 1);

  const scale = clampScale(
    Math.min((boundsWidth - FIT_PADDING_PX * 2) / spanX, (boundsHeight - FIT_PADDING_PX * 2) / spanY),
  );

  return {
    scale,
    translate: {
      x: boundsWidth / 2 - centreX * scale,
      y: boundsHeight / 2 - centreY * scale,
    },
  };
}
