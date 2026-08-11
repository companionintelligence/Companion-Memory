/**
 * Label geometry for the 2D force graph.
 *
 * The simulation repels node CENTRES, but a node is a 6px dot with up to ~140px of text hanging off
 * its right-hand side. So a layout can be perfectly well spaced by the simulation's own measure and
 * still stack four names on top of each other — which is exactly what a 25-node person graph does.
 * The halo behind each glyph only ever rescued the topmost label; the ones underneath stayed mush.
 *
 * Everything here treats a node as the box it actually occupies — dot PLUS label — so the layout can
 * keep those boxes apart instead of keeping the dots apart and hoping.
 *
 * Kept out of ForceGraph.tsx as pure geometry so the `node` vitest project can exercise it.
 */

/**
 * Fallback advance per `text-xs` glyph, used only where the real font cannot be measured.
 *
 * It is an AVERAGE, and proportional type does not average well: measured against the rendered
 * font, this under-estimates 22 of 25 real names and is 34% short on the worst ("Muhammad Nadeem"
 * is 128px, this model says 96px). A layout that reserves less room than the text occupies puts
 * labels on top of each other while believing they are clear — so anything that has a DOM measures
 * instead, and this is the floor for environments that do not (the `node` test project).
 */
export const LABEL_CHAR_PX = 6.4;

/** Measures the drawn width of a label. */
export type LabelMeasurer = (label: string) => number;

/** The width model, for callers with no way to measure the real thing. */
export const estimateLabelWidth: LabelMeasurer = (label) => label.length * LABEL_CHAR_PX;
/** Gap between the edge of the circle and the start of the text. */
export const LABEL_GAP_PX = 4;
/**
 * Fallback half-height of a label's line box, about the node centre.
 *
 * Same caveat as LABEL_CHAR_PX: it is a model, and the real box is taller. `text-xs` resolves to
 * 12.75px/17px in this app, and the rendered extent measures ~18.2px — so a 16px model let every
 * separated pair keep a ~2.2px vertical overlap. Anything with a DOM measures instead.
 */
export const LABEL_HALF_HEIGHT_PX = 8;
/**
 * Longest label drawn in full. Past this the layout spends more space on one name than the picture
 * can afford, so it is clipped and the full value moves to the hover tooltip.
 */
export const MAX_LABEL_CHARS = 22;

// Nodes read as small dots by default — the picture is a constellation, not a bubble chart.
// Degree still grows a hub, but gently; selection/highlight are what earn real size.
const MIN_NODE_RADIUS = 3.5;
const MAX_NODE_RADIUS = 11;
const DEGREE_RADIUS_FACTOR = 1.3;
const SELECTED_MIN_RADIUS = 12;
const HIGHLIGHTED_MIN_RADIUS = 10;

export type NodeEmphasis = 'selected' | 'highlighted' | 'none';

/** The label as drawn: clipped to `MAX_LABEL_CHARS`, with the ellipsis inside the budget. */
export function truncateLabel(label: string, maxChars: number = MAX_LABEL_CHARS): string {
  if (label.length <= maxChars) {
    return label;
  }

  return `${label.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Width of the label as drawn — i.e. of the TRUNCATED text, so framing and collision agree.
 *
 * `measure` should be a real text measurement wherever one is available; see `createTextMeasurer`
 * in ForceGraph.tsx. It defaults to the character-count model only so this stays pure geometry.
 */
export function labelWidthPx(
  label: string,
  maxChars: number = MAX_LABEL_CHARS,
  measure: LabelMeasurer = estimateLabelWidth,
): number {
  return measure(truncateLabel(label, maxChars));
}

/**
 * Node size by connection count, so the hubs of the graph read as hubs.
 *
 * Fixed 6px dots gave a person's closest collaborator and a one-off mention identical weight, which
 * is a large part of why the picture read as noise. Square-rooted because degree is long-tailed and
 * a linear map turns one hub into a blob that swallows its neighbours.
 */
export function nodeRadius(degree: number, emphasis: NodeEmphasis = 'none'): number {
  const byDegree = MIN_NODE_RADIUS + Math.sqrt(Math.max(0, degree)) * DEGREE_RADIUS_FACTOR;
  const base = Math.min(MAX_NODE_RADIUS, byDegree);

  if (emphasis === 'selected') {
    return Math.max(base, SELECTED_MIN_RADIUS);
  }

  if (emphasis === 'highlighted') {
    return Math.max(base, HIGHLIGHTED_MIN_RADIUS);
  }

  return base;
}

/**
 * Hop distance from the focused node, by breadth-first search over the links treated as undirected.
 *
 * Returns an empty map when there is no focus, which is how a caller opts out of any notion of near
 * and far.
 */
export function hopDistances(
  centerId: string | null | undefined,
  links: readonly { sourceId: string; targetId: string }[],
): Map<string, number> {
  const distances = new Map<string, number>();

  if (typeof centerId !== 'string' || centerId === '') {
    return distances;
  }

  const adjacency = new Map<string, string[]>();
  const connect = (from: string, to: string) => {
    const existing = adjacency.get(from);
    if (existing) {
      existing.push(to);
    } else {
      adjacency.set(from, [to]);
    }
  };

  for (const link of links) {
    connect(link.sourceId, link.targetId);
    connect(link.targetId, link.sourceId);
  }

  distances.set(centerId, 0);
  const queue = [centerId];

  // Index-walked rather than shifted: a shift is O(n) on a real array, and this runs on every
  // change to the link set.
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;

    for (const neighbor of adjacency.get(current) ?? []) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, distance + 1);
        queue.push(neighbor);
      }
    }
  }

  return distances;
}

/** How much of its normal radius a context node keeps. */
export const CONTEXT_NODE_SCALE = 0.62;
/** How much of its normal ink a context node keeps — enough to read as present, not as subject. */
export const CONTEXT_NODE_OPACITY = 0.4;
/** How much of its normal ink a link keeps when it runs out past the focused neighbourhood. */
export const CONTEXT_LINK_OPACITY = 0.35;

/**
 * Whether a node is context rather than subject.
 *
 * A page about one entity that expands past its own connections fills up with whichever hub sits
 * next to it — on a person with a single link, two hops is 1 neighbour and 23 of THEIR neighbours.
 * Those 23 are worth showing, but not worth drawing as though the page were about them.
 *
 * A node with no distance is never context. It means either that the caller opted out or that the
 * node is unreachable from the centre (possible once the edge budget trims links), and drawing an
 * orphan at full weight is a cosmetic oddity where fading a whole graph by accident is a broken page.
 */
export function isContextNode(distance: number | undefined, focusHops: number | undefined): boolean {
  if (focusHops === undefined || distance === undefined) {
    return false;
  }

  return distance > focusHops;
}

export type CollidableNode = {
  x: number;
  y: number;
  /** Drawn radius of the circle. */
  radius: number;
  /** Drawn width of the label, already truncated. Zero for an unlabelled node. */
  labelWidth: number;
  /** Half the drawn line box. Falls back to `LABEL_HALF_HEIGHT_PX` when nothing measured it. */
  labelHalfHeight?: number;
  /** Pinned nodes (the centre node, user-anchored nodes) are never moved to resolve an overlap. */
  pinned?: boolean;
};

export type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Overlap at or below this is not an overlap.
 *
 * Relaxation approaches contact asymptotically — each pass halves what is left — so a stack settles
 * with neighbours a hair short of clear and a strict `> 0` test reports every adjacent pair as
 * overlapping forever. Sub-pixel overlap is also, definitionally, not visible.
 */
const MIN_OVERLAP_PX = 0.5;

/** The full extent of a node as drawn: the circle, plus the label running off to its right. */
export function labelBox(node: CollidableNode): Box {
  // A node with no label is just its circle, vertically as well as horizontally. Reserving a line
  // box for text that is never drawn would push hover-only dots apart for nothing — and spreading
  // the layout is exactly what dropping their labels was meant to avoid.
  const halfHeight =
    node.labelWidth > 0 ? Math.max(node.radius, node.labelHalfHeight ?? LABEL_HALF_HEIGHT_PX) : node.radius;

  return {
    left: node.x - node.radius,
    right: node.x + node.radius + (node.labelWidth > 0 ? LABEL_GAP_PX + node.labelWidth : 0),
    top: node.y - halfHeight,
    bottom: node.y + halfHeight,
  };
}

/** How far two drawn extents overlap on each axis. Non-positive on an axis means they are clear. */
function overlapBetween(a: CollidableNode, b: CollidableNode): { x: number; y: number } {
  const boxA = labelBox(a);
  const boxB = labelBox(b);

  return {
    x: Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left),
    y: Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top),
  };
}

/** Whether two nodes overlap by enough to be seen — the condition the layout exists to resolve. */
export function overlapsVisibly(a: CollidableNode, b: CollidableNode): boolean {
  const overlap = overlapBetween(a, b);

  return overlap.x > MIN_OVERLAP_PX && overlap.y > MIN_OVERLAP_PX;
}

/**
 * One relaxation pass that pushes overlapping label boxes apart, in place.
 *
 * A positional resolve rather than a velocity force: overlap is a hard constraint, and feeding it
 * through the velocity integrator makes labels oscillate through each other instead of settling.
 *
 * Pairs separate along whichever axis costs less travel. Labels are wide and short, so that is
 * almost always vertical — which is also how a reader wants a stack of names laid out.
 *
 * Every contact is measured against the SAME starting positions and each node then moves by the
 * AVERAGE of what its neighbours asked for. Applying each pair the moment it is found instead — the
 * obvious way to write this — means a node in the middle of a 25-way pile-up gets shoved 24 separate
 * times per pass and bounces around the canvas forever; a pile that dense never resolved at all.
 * Averaging also makes the result independent of the order the pairs happen to be visited in.
 *
 * `strength` damps each pass; 1 is a full resolve. Returns the number of overlapping pairs found,
 * which lets the caller stop once the layout is clean.
 */
export function relaxLabelCollisions(nodes: readonly CollidableNode[], strength = 0.5): number {
  const count = nodes.length;
  if (count < 2) {
    return 0;
  }

  const shiftX = new Float64Array(count);
  const shiftY = new Float64Array(count);
  const contacts = new Int32Array(count);
  let overlaps = 0;

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const a = nodes[i];
      const b = nodes[j];

      const { x: overlapX, y: overlapY } = overlapBetween(a, b);
      if (overlapX <= MIN_OVERLAP_PX || overlapY <= MIN_OVERLAP_PX) {
        continue;
      }

      overlaps += 1;

      if (a.pinned && b.pinned) {
        continue;
      }

      // Half-separation pointing from `a` towards `b`, along the cheaper axis.
      let dx = 0;
      let dy = 0;
      if (overlapY <= overlapX) {
        dy = (overlapY / 2) * (a.y <= b.y ? 1 : -1);
      } else {
        dx = (overlapX / 2) * (a.x <= b.x ? 1 : -1);
      }

      // A pinned end carries the whole separation on the other, so the pair still ends up clear
      // rather than half-resolved against an immovable node.
      const share = a.pinned || b.pinned ? 2 : 1;

      if (!a.pinned) {
        shiftX[i] -= dx * share;
        shiftY[i] -= dy * share;
        contacts[i] += 1;
      }

      if (!b.pinned) {
        shiftX[j] += dx * share;
        shiftY[j] += dy * share;
        contacts[j] += 1;
      }
    }
  }

  for (let i = 0; i < count; i += 1) {
    if (contacts[i] === 0) {
      continue;
    }

    nodes[i].x += (shiftX[i] / contacts[i]) * strength;
    nodes[i].y += (shiftY[i] / contacts[i]) * strength;
  }

  return overlaps;
}

/**
 * Above this many nodes, a standing label on every node is self-defeating.
 *
 * Separating that many label boxes forces the layout wider than the canvas, and `fitTransform` then
 * scales the whole picture down to fit — so at 100 nodes the labels no longer overlap but render at
 * ~6px, which is not readable either. Past the threshold only the nodes worth naming keep a standing
 * label; the rest are dots that give up their name on hover. The layout reserves no room for a label
 * it will not draw, which is what keeps the fit near 1:1 and the remaining labels legible.
 */
export const LABEL_ALL_THRESHOLD = 40;

/** How many of the busiest nodes keep a standing label once the graph is past the threshold. */
export const PROMINENT_LABEL_COUNT = 12;

/**
 * Which nodes carry a standing label. Everything else still answers on hover.
 *
 * `alwaysLabel` is for nodes the viewer has explicitly put at the centre of the picture — they are
 * named regardless of how busy they are, because they are the reason the graph is on screen.
 *
 * `isEligible` filters out nodes that are on screen as context rather than as subject. Naming them
 * is what makes an expanded graph unreadable: they are the majority, they are the reason the label
 * budget runs out, and the name of someone two hops away is the least useful text on the page. They
 * still give up their name on hover.
 */
export function standingLabelIds(
  nodes: readonly { id: string }[],
  degreeOf: (id: string) => number,
  alwaysLabel: readonly (string | null | undefined)[] = [],
  isEligible: (id: string) => boolean = () => true,
): Set<string> {
  // Only anchors that are actually in the graph. An id that is not — a centre node trimmed out of
  // the subgraph, say — would otherwise hold a slot that no label is ever drawn in.
  const present = new Set(nodes.map((node) => node.id));
  const anchors = alwaysLabel.filter((id): id is string => typeof id === 'string' && present.has(id));
  const eligible = nodes.filter((node) => isEligible(node.id));

  // The threshold is about how many labels would be DRAWN, so it counts the eligible ones. A graph
  // of 200 nodes where only 8 are direct connections can name all 8 comfortably.
  if (eligible.length <= LABEL_ALL_THRESHOLD) {
    return new Set([...anchors, ...eligible.map((node) => node.id)]);
  }

  const labelled = new Set(anchors);

  // Busiest first. Array.prototype.sort is stable, so ties keep the incoming order and the same
  // graph always labels the same nodes.
  const byDegree = [...eligible].sort((a, b) => degreeOf(b.id) - degreeOf(a.id));
  const budget = labelled.size + PROMINENT_LABEL_COUNT;

  for (const node of byDegree) {
    if (labelled.size >= budget) {
      break;
    }

    labelled.add(node.id);
  }

  return labelled;
}

/** Node count the simulation world is sized for before it needs to grow. */
const BASELINE_NODE_COUNT = 25;
const MAX_WORLD_SCALE = 2.2;

/**
 * The world the simulation lays out in, which is NOT the canvas it is drawn on.
 *
 * Nodes are clamped inside these bounds, so a canvas-sized world leaves collision resolution nowhere
 * to put the overflow and it piles up against the walls. The world grows with the square root of the
 * count — area scales linearly with the boxes that have to fit — and `fitTransform` scales the
 * result back down to the canvas.
 *
 * Driven by the number of LABELLED nodes, not the total: bare dots pack tightly and need no extra
 * room, and growing the world for them would only shrink the fit and the labels with it.
 */
export function simulationBounds(
  labelledCount: number,
  canvasWidth: number,
  canvasHeight: number,
): { width: number; height: number } {
  const scale = Math.min(MAX_WORLD_SCALE, Math.max(1, Math.sqrt(labelledCount / BASELINE_NODE_COUNT)));

  return { width: canvasWidth * scale, height: canvasHeight * scale };
}

const MIN_GRAPH_HEIGHT = 420;
const MAX_GRAPH_HEIGHT = 640;

/**
 * How tall to draw the canvas for a given node count.
 *
 * 25 nodes in a 420px box is dense however well they are laid out; past the baseline the panel earns
 * some more vertical room rather than shrinking everything to fit.
 */
export function graphHeightForNodeCount(nodeCount: number): number {
  if (nodeCount <= BASELINE_NODE_COUNT) {
    return MIN_GRAPH_HEIGHT;
  }

  const growth = Math.sqrt(nodeCount / BASELINE_NODE_COUNT);

  return Math.round(Math.min(MAX_GRAPH_HEIGHT, MIN_GRAPH_HEIGHT * growth));
}
