import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';
import { colorForRawType } from '@/components/entities/entityVisuals';

import { clampScale, fitTransform } from './fitTransform';
import {
  CONTEXT_LINK_OPACITY,
  CONTEXT_NODE_OPACITY,
  CONTEXT_NODE_SCALE,
  LABEL_GAP_PX,
  LABEL_HALF_HEIGHT_PX,
  type LabelMeasurer,
  estimateLabelWidth,
  MAX_LABEL_CHARS,
  graphHeightForNodeCount,
  hopDistances,
  isContextNode,
  labelWidthPx,
  nodeRadius,
  relaxLabelCollisions,
  simulationBounds,
  standingLabelIds,
  truncateLabel,
} from './labelLayout';

type ForceNode = GraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** d3-force pin: while set, the simulation holds the node here (centre pin, anchor, or drag). */
  fx?: number | null;
  fy?: number | null;
  anchored?: boolean;
  /** How many links touch this node — drives its drawn size. */
  degree: number;
  /** Drawn radius, resolved once per layout so the simulation and the renderer agree. */
  radius: number;
  /** The label as drawn, clipped to the label budget. */
  label: string;
  /** Untruncated label, for the hover tooltip. */
  fullLabel: string;
  /** Drawn width of `label`, which is the horizontal room the layout has to reserve. */
  labelWidth: number;
  /** Half the drawn line box, measured from the live font. */
  labelHalfHeight: number;
  /** Never moved to resolve a label overlap. */
  pinned: boolean;
  /** On screen as context rather than as part of the focused node's own graph. */
  context: boolean;
};

/**
 * A link with its endpoints resolved to the live simulation node objects, so both the tick handler
 * and the renderer read positions straight off the nodes the simulation is mutating.
 */
type SimulationLink = {
  id: string;
  sourceId: string;
  targetId: string;
  relationship_type: string;
  strength: number;
  source: ForceNode;
  target: ForceNode;
};

interface ForceGraphProps {
  nodes: GraphNode[];
  links: GraphLink[];
  highlightedNodeId?: string | null;
  centerNodeId?: string | null;
  height?: number;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  /**
   * Fires (debounced) when the camera settles over a new viewport in dots/LOD mode: the node ids
   * currently inside the frame, and whether the zoom is past the label threshold. The graph
   * explorer uses it to fetch the relationships among the visible section once the viewer zooms in.
   */
  onViewportChange?: (visibleNodeIds: string[], zoomedIn: boolean) => void;
  /**
   * Connection-thread selection: the emphasised relationship. Everything that is not the thread —
   * its line and its two endpoints — recedes, the way hover already isolates a node's corner.
   */
  selectedLinkId?: string | null;
  onLinkSelect?: (linkId: string) => void;
  /** A click on empty canvas (not a pan) — the caller's cue to clear selections and dialogs. */
  onBackgroundClick?: () => void;
  /**
   * Camera flight target. Setting an id flies the camera to that node (Webbed Feet's zoom-to-node);
   * clearing it back to null flies back to the fitted overview frame. Manual pan/zoom still works
   * in between — a change of value is a one-shot request, not a lock.
   */
  flyToNodeId?: string | null;
  anchoredNodeIds?: string[];
  /**
   * Hops from `centerNodeId` that count as the focused node's own graph. Anything further is drawn
   * as context: dimmed, smaller and unlabelled, so an entity page reads as being about its entity
   * even when the neighbourhood it pulls in belongs to somebody else.
   *
   * Omit to weight every node equally, which is what a general graph browser wants.
   */
  focusHops?: number;
  /**
   * Force the dots/LOD rendering path even when the node count is under the auto threshold.
   * Used by the progressive overview so the first page (~320) already looks like a constellation
   * and doesn't flip from labelled → dots when the full page lands.
   */
  forceLod?: boolean;
  /**
   * Soft continuous atmosphere after the force settle: a slow idle breath on the camera and a
   * rare cool reheat so the constellation never feels frozen. Cheap — sleeps between breaths.
   */
  ambientBreath?: boolean;
}

/**
 * Measures label text with the font it is actually drawn in.
 *
 * The layout has to reserve exactly the room the renderer will use. Modelling that as
 * `characters × average advance` is wrong for proportional type in a way that matters: measured in
 * a real browser, the average under-estimates 22 of 25 typical names and is 34% short on the worst,
 * so the collision pass reports labels as clear while they visibly overlap. Unit tests could not
 * catch it — they used the same model on both sides of the assertion.
 *
 * Returns null where there is no canvas to measure with (the `node` test project), leaving callers
 * on the estimate.
 */
type TextMetricsProbe = { width: LabelMeasurer; halfHeight: number };

function createTextMeasurer(sample: SVGTextElement | null): TextMetricsProbe | null {
  if (typeof document === 'undefined' || !sample) {
    return null;
  }

  const context = document.createElement('canvas').getContext('2d');
  if (!context) {
    return null;
  }

  // Read the font off a node that is actually on screen rather than hard-coding it, so a theme or
  // Tailwind change cannot silently desynchronise the layout from the rendering.
  const style = window.getComputedStyle(sample);
  if (!style.fontSize || !style.fontFamily) {
    return null;
  }

  context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  // The probe is a real <text> in the real SVG, so its box is the ground truth the overlap will be
  // judged against. Canvas TextMetrics is NOT: `actualBoundingBox*` measures ink extents (~12px for
  // this font) while the renderer lays out the full line box (~18px), which left every separated
  // pair 2.2px short of clear.
  const probeRect = sample.getBoundingClientRect();
  const halfHeight = probeRect.height > 0 ? probeRect.height / 2 : LABEL_HALF_HEIGHT_PX;

  // Canvas also measures a hair narrower than the SVG renderer lays the same string out, so
  // calibrate against the probe rather than guessing a safety margin.
  const probeText = sample.textContent ?? '';
  const canvasProbe = context.measureText(probeText).width;
  const svgProbe = sample.getComputedTextLength ? sample.getComputedTextLength() : 0;
  const widthScale = canvasProbe > 0 && svgProbe > 0 ? svgProbe / canvasProbe : 1;

  const cache = new Map<string, number>();

  const width: LabelMeasurer = (label) => {
    const cached = cache.get(label);
    if (cached !== undefined) {
      return cached;
    }

    const measured = context.measureText(label).width * widthScale;
    // A zero width means the font has not loaded yet; fall back rather than collapse the layout.
    const resolved = measured > 0 ? measured : estimateLabelWidth(label);
    cache.set(label, resolved);

    return resolved;
  };

  return { width, halfHeight: Math.max(halfHeight, LABEL_HALF_HEIGHT_PX) };
}

function useContainerWidth(defaultWidth: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(defaultWidth);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setWidth(entry.contentRect.width);
        }
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, width } as const;
}

/*
 * Motion model ported from Webbed Feet's force-graph-experiment.ts. The signature of that graph is
 * a SLOW settle — alphaDecay 0.04 instead of a fast converge-and-freeze — with weak forces, so the
 * web drifts gently into place and every interaction reads as tension in the threads rather than a
 * jump cut. Positions are written straight to the DOM on tick; React never re-renders per frame.
 */
/** Webbed Feet's desktop decay: the long, organic settle IS the look. */
const ALPHA_DECAY = 0.04;
/** Where the settle stops. Above d3's default so the last imperceptible drift is skipped. */
const ALPHA_MIN = 0.02;
/** Webbed Feet's drag reheat: `simulation.alpha(0.1).restart()` on every drag move. */
const REHEAT_ALPHA = 0.1;
/** Node-to-node repulsion. Stronger than Webbed Feet's -30: with the connecting lines hidden at
 * rest, the spread of the dots is the only structure on screen, so the constellation earns room. */
const CHARGE_STRENGTH = -140;
/** Breathing room around a node the circle-collision force protects. */
const COLLIDE_PADDING = 6;
/** Gentle pull toward the world centre — replaces recentring by translation, which visibly shoved
 * the whole picture every tick. */
const CENTERING_STRENGTH = 0.05;
/** Link rest lengths: strong ties sit close, loose ties drift long. Longer than the original
 * 70–210 range for the same reason as the charge: dots spread out, threads appear on demand. */
const MIN_SPRING_LENGTH = 90;
const MAX_SPRING_LENGTH = 280;
const STRENGTH_CURVE_EXPONENT = 2.2;
/**
 * How much of each label overlap to resolve per tick. Under-relaxed on purpose: a node squeezed by
 * several neighbours converges instead of ping-ponging between them.
 */
const COLLISION_STRENGTH = 0.3;
/**
 * Budget for the passes run once the simulation settles, to land on a frame with no overlaps left
 * rather than whatever the last tick happened to leave.
 *
 * Generous because it is a CEILING, not a cost: a layout that has already settled under repulsion
 * and per-tick separation is close to clean, so the loop exits after a handful of passes. Only a
 * genuine pile-up spends the budget, and relaxation converges by diffusion — a 25-node pile started
 * from a single spot measures ~580 passes, so a small bound would quietly give up on exactly the
 * case this exists for. Bounded at all so an unsatisfiable layout still terminates.
 */
const COLLISION_POLISH_PASSES = 600;
/** Hard ceiling on lifetime ticks so a pathological reheat loop still terminates. */
const MAX_LIFETIME_TICKS = 5000;
/**
 * Per-tick fraction the camera moves toward the fitted frame while the graph settles. The camera
 * breathing with the layout — rather than snapping to fit after it froze — is half of what makes
 * the Webbed Feet load-in feel alive.
 */
const CAMERA_TRACK = 0.08;
/** Ties looser than this draw dashed, Webbed Feet's treatment for its episode chain. */
const WEAK_TIE_THRESHOLD = 0.35;
/** Screen-space movement below which a pointer gesture on a node is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

/**
 * Capture throws for a pointer the platform is not tracking (synthetic test events, a pointer
 * already released); losing capture degrades a drag, it must not abort the handler that owns it.
 */
function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* drag continues uncaptured */
  }
}

function releasePointer(element: Element, pointerId: number) {
  try {
    element.releasePointerCapture(pointerId);
  } catch {
    /* it was never captured */
  }
}

// Colour nodes by entity type from the shared LifeScope palette so the graph
// matches the map/list/gallery.
function getTypeColor(entityType: string): string {
  return colorForRawType(entityType);
}

function clampRelationshipStrength(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function getSpringLengthFromStrength(value: number): number {
  const normalized = clampRelationshipStrength(value);
  const curved = Math.pow(normalized, STRENGTH_CURVE_EXPONENT);

  return MAX_SPRING_LENGTH - curved * (MAX_SPRING_LENGTH - MIN_SPRING_LENGTH);
}

/** Camera flight duration; matches Webbed Feet's 750ms zoom-to-node transition. */
const CAMERA_FLIGHT_MS = 700;
/** Minimum magnification a flight lands at, so "focus this node" always reads as a close-up. */
const FLIGHT_MIN_SCALE = 1.25;

/*
 * LOD ("dots") mode — the Webbed Feet explore-page pattern at CI scale. Past a node count no label
 * budget survives, every node renders as a tiny type-colored dot; zooming past a threshold swaps
 * dots for labels, but only for the nodes inside the viewport. The O(n²) label relaxation is
 * skipped entirely (there are no standing labels to keep apart), which is what makes a 2000-node
 * simulation tick at frame rate.
 */
/** Past this many nodes the graph renders as dots with zoom-revealed labels. */
const LOD_NODE_THRESHOLD = 300;
/** Webbed Feet's ZOOM_THRESHOLD: at/above it, viewport nodes earn labels (and section edges). */
const LOD_ZOOM_THRESHOLD = 1.5;
/** Most labels drawn at once when zoomed in — the busiest nodes in frame win. */
const LOD_MAX_LABELS = 80;
/** Dot size at rest; degree still grows a hub, gently. */
const LOD_DOT_RADIUS = 3;
const LOD_MAX_DOT_RADIUS = 6;
const LOD_DOT_DEGREE_FACTOR = 0.28;
/**
 * LOD overview is a static constellation: type-cluster seeds, then every node is pinned.
 * No charge/centering/link forces — relationships are ink on demand, not springs that
 * tie the field into one moving blob.
 */
/** Camera-settle debounce before the viewport is re-evaluated (labels, section fetch). */
const LOD_VIEWPORT_DEBOUNCE_MS = 180;
/** World-space margin around the frame so labels don't pop at the very edge. */
const LOD_VIEWPORT_MARGIN_PX = 40;
/** Reveal opacity for section edges while zoomed in (nobody asked about a specific node yet). */
const LOD_SECTION_LINK_OPACITY = 0.3;
/** Solid dots — overview should read as ink, not glass. */
const LOD_DOT_FILL_OPACITY = 0.96;
/** Soft camera presence only (no force reheat) — the dots themselves stay put. */
const LOD_BREATH_SCALE_AMP = 0.002;
/** How far out the per-type seed clusters sit, as a fraction of the world's half-extent. */
const LOD_CLUSTER_RADIUS_FRACTION = 0.7;
/** Cluster disc radius as a fraction of the smaller world axis. */
const LOD_CLUSTER_SPREAD_FRACTION = 0.2;
/** Cap fit-zoom in overview so type groups stay separate islands, not one magnified clump. */
const LOD_MAX_FIT_ZOOM = 1.05;
/**
 * Stable ring order for type islands. Must NOT follow payload order (degree-sorted
 * persons-first) or the ring jumps every progressive page and leaves a trail of
 * stale positions — the horizontal "startup row" artifact.
 */
const LOD_TYPE_RING_ORDER = [
  'Person',
  'Event',
  'Communication',
  'Content',
  'Location',
  'Place',
  'Concept',
  'File',
  'Item',
  'Group',
  'Pet',
] as const;

/**
 * Deterministic per-type seed positions: nodes of one type start together in a radial
 * cluster, so the first frame already reads as "these are the kinds of things I have".
 */
function clusterSeedPosition(
  typeIndex: number,
  typeCount: number,
  memberIndex: number,
  memberCount: number,
  boundsWidth: number,
  boundsHeight: number,
): { x: number; y: number } {
  const angle = (typeIndex / Math.max(1, typeCount)) * Math.PI * 2;
  const clusterRadius = Math.min(boundsWidth, boundsHeight) * (LOD_CLUSTER_RADIUS_FRACTION / 2);
  const centerX = boundsWidth / 2 + Math.cos(angle) * clusterRadius;
  const centerY = boundsHeight / 2 + Math.sin(angle) * clusterRadius;

  // Sunflower (phyllotaxis) packing: evenly filled disc, no RNG, no two members stacked.
  const spread = Math.min(boundsWidth, boundsHeight) * LOD_CLUSTER_SPREAD_FRACTION;
  const r = spread * Math.sqrt((memberIndex + 0.5) / Math.max(1, memberCount));
  const theta = memberIndex * 2.399963229728653;

  return { x: centerX + Math.cos(theta) * r, y: centerY + Math.sin(theta) * r };
}

/** Ring index for a type: preferred order first, then any leftovers alphabetically. */
function lodTypeRingIndex(entityType: string, presentTypes: readonly string[]): number {
  const preferred = LOD_TYPE_RING_ORDER.filter((type) => presentTypes.includes(type));
  const extras = presentTypes
    .filter((type) => !preferred.includes(type as (typeof LOD_TYPE_RING_ORDER)[number]))
    .sort();
  const ring = [...preferred, ...extras];
  const index = ring.indexOf(entityType);

  return index >= 0 ? index : 0;
}

function lodTypeRingCount(presentTypes: readonly string[]): number {
  const preferred = LOD_TYPE_RING_ORDER.filter((type) => presentTypes.includes(type));
  const extras = presentTypes.filter(
    (type) => !preferred.includes(type as (typeof LOD_TYPE_RING_ORDER)[number]),
  );

  return preferred.length + extras.length;
}

function ForceGraphBase({
  nodes,
  links,
  highlightedNodeId,
  centerNodeId,
  selectedNodeId,
  onNodeSelect,
  selectedLinkId,
  onLinkSelect,
  onBackgroundClick,
  flyToNodeId,
  anchoredNodeIds = [],
  focusHops,
  height,
  onViewportChange,
  forceLod = false,
  ambientBreath = false,
}: ForceGraphProps) {
  const { ref, width } = useContainerWidth(720);
  /** Dots/LOD rendering — auto past the threshold, or forced by the progressive overview. */
  const lodMode = forceLod || nodes.length > LOD_NODE_THRESHOLD;
  /** Ids seen across progressive merges — first sighting earns a soft arrive fade. */
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  // The live simulation arrays. Set once per layout; the simulation then MUTATES the members in
  // place and the tick handler writes their positions straight to the DOM. React re-renders only
  // for data or interaction-state changes, and reads whatever positions are current when it does.
  const [simNodes, setSimNodes] = useState<ForceNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimulationLink[]>([]);
  const [arrivingIds, setArrivingIds] = useState<Set<string>>(() => new Set());
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // A caller that sizes its own container (the graph explorer modal) keeps control of the height;
  // the entity panel, which does not, gets one that grows with how much there is to show.
  const canvasHeight = height ?? graphHeightForNodeCount(nodes.length);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const cameraGroupRef = useRef<SVGGElement | null>(null);
  const nodeElsRef = useRef<Map<string, SVGGElement>>(new Map());
  const linkElsRef = useRef<Map<string, SVGGElement>>(new Map());
  const fontProbeRef = useRef<SVGTextElement | null>(null);
  const measurerRef = useRef<TextMetricsProbe | null>(null);
  const panStartRef = useRef({ x: 0, y: 0 });
  const translateStartRef = useRef({ x: 0, y: 0 });
  const previousPositionsRef = useRef<Map<string, ForceNode>>(new Map());
  const anchoredKey = useMemo(() => anchoredNodeIds.join('|'), [anchoredNodeIds]);
  const nodesKey = useMemo(() => nodes.map((node) => node.id).join('|'), [nodes]);
  const viewerMovedCameraRef = useRef(false);

  // Camera lives in refs and is applied imperatively: flights, tracking and pans run every frame,
  // and going through React state made each of those a full re-render — the jump the old graph had.
  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const simNodesRef = useRef(simNodes);
  simNodesRef.current = simNodes;
  const cameraFrameRef = useRef<number | null>(null);
  /** Reheats the current simulation (drag re-tension); rebound by each layout effect. */
  const reheatRef = useRef<((alpha: number) => void) | null>(null);
  // Distinguishes a click on the canvas from the end of a pan; only the former clears selections.
  const panMovedRef = useRef(false);

  /**
   * The zoom-LOD view: whether the camera is past the label threshold, and which nodes get a label.
   * Only meaningful (and only maintained) in LOD mode; recomputed on a debounce after the camera
   * settles, because it runs over every node and gates React re-renders.
   */
  const [lodView, setLodView] = useState<{ zoomedIn: boolean; labelIds: Set<string> }>({
    zoomedIn: false,
    labelIds: new Set(),
  });
  const lodViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lodModeRef = useRef(lodMode);
  lodModeRef.current = lodMode;
  const canvasSizeRef = useRef({ width: 720, height: 480 });
  canvasSizeRef.current = { width: width || 720, height: canvasHeight };
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  const updateLodView = useCallback(() => {
    if (!lodModeRef.current) {
      return;
    }

    const scale = scaleRef.current;
    const translate = translateRef.current;
    const { width: canvasWidth, height: viewHeight } = canvasSizeRef.current;
    const zoomedIn = scale >= LOD_ZOOM_THRESHOLD;

    // The frame in world coordinates, padded so labels don't pop at the edge.
    const left = (-LOD_VIEWPORT_MARGIN_PX - translate.x) / scale;
    const right = (canvasWidth + LOD_VIEWPORT_MARGIN_PX - translate.x) / scale;
    const top = (-LOD_VIEWPORT_MARGIN_PX - translate.y) / scale;
    const bottom = (viewHeight + LOD_VIEWPORT_MARGIN_PX - translate.y) / scale;

    const visible = simNodesRef.current.filter(
      (node) => node.x >= left && node.x <= right && node.y >= top && node.y <= bottom,
    );

    const labelIds = new Set<string>(
      zoomedIn
        ? [...visible]
            .sort((a, b) => b.degree - a.degree)
            .slice(0, LOD_MAX_LABELS)
            .map((node) => node.id)
        : [],
    );

    setLodView((previous) => {
      if (
        previous.zoomedIn === zoomedIn &&
        previous.labelIds.size === labelIds.size &&
        [...labelIds].every((id) => previous.labelIds.has(id))
      ) {
        return previous;
      }

      return { zoomedIn, labelIds };
    });

    onViewportChangeRef.current?.(
      visible.map((node) => node.id),
      zoomedIn,
    );
  }, []);

  const scheduleLodViewUpdate = useCallback(() => {
    if (!lodModeRef.current) {
      return;
    }

    if (lodViewTimerRef.current != null) {
      clearTimeout(lodViewTimerRef.current);
    }

    lodViewTimerRef.current = setTimeout(updateLodView, LOD_VIEWPORT_DEBOUNCE_MS);
  }, [updateLodView]);

  useEffect(
    () => () => {
      if (lodViewTimerRef.current != null) {
        clearTimeout(lodViewTimerRef.current);
      }
    },
    [],
  );

  const applyCamera = useCallback(() => {
    cameraGroupRef.current?.setAttribute(
      'transform',
      `translate(${translateRef.current.x}, ${translateRef.current.y}) scale(${scaleRef.current})`,
    );
    // Every camera write (wheel, pan, flight frame, settle tracking) re-arms the same debounce, so
    // the LOD view recomputes once, after the camera comes to rest.
    scheduleLodViewUpdate();
  }, [scheduleLodViewUpdate]);

  /** Eased camera flight to a target frame; a new flight (or manual input) replaces the current one. */
  const animateCamera = useCallback(
    (toScale: number, toTranslate: { x: number; y: number }) => {
      if (cameraFrameRef.current != null) {
        cancelAnimationFrame(cameraFrameRef.current);
      }

      const fromScale = scaleRef.current;
      const fromTranslate = { ...translateRef.current };
      const start = performance.now();

      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / CAMERA_FLIGHT_MS);
        const eased = 1 - Math.pow(1 - progress, 3);

        scaleRef.current = fromScale + (toScale - fromScale) * eased;
        translateRef.current = {
          x: fromTranslate.x + (toTranslate.x - fromTranslate.x) * eased,
          y: fromTranslate.y + (toTranslate.y - fromTranslate.y) * eased,
        };
        applyCamera();

        cameraFrameRef.current = progress < 1 ? requestAnimationFrame(step) : null;
      };

      cameraFrameRef.current = requestAnimationFrame(step);
    },
    [applyCamera],
  );

  useEffect(
    () => () => {
      if (cameraFrameRef.current != null) {
        cancelAnimationFrame(cameraFrameRef.current);
      }
    },
    [],
  );

  // One-shot flight per flyToNodeId VALUE change: flying again as the simulation drifts under a
  // stable target would fight the viewer's own pan/zoom.
  const lastFlightTargetRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (flyToNodeId === undefined || flyToNodeId === lastFlightTargetRef.current) {
      return;
    }

    // The first render never flies: null means "overview", and animating a fit over the fit the
    // layout already applied would just wiggle the frame.
    const isFirstObservation = lastFlightTargetRef.current === undefined;
    lastFlightTargetRef.current = flyToNodeId;

    if (isFirstObservation && flyToNodeId === null) {
      return;
    }

    const canvasWidth = width || 720;

    if (flyToNodeId !== null) {
      const target = simNodesRef.current.find((node) => node.id === flyToNodeId);
      if (!target) {
        return;
      }

      const toScale = clampScale(Math.max(scaleRef.current, FLIGHT_MIN_SCALE));
      animateCamera(toScale, {
        x: canvasWidth / 2 - target.x * toScale,
        y: canvasHeight / 2 - target.y * toScale,
      });
      // A flight is a deliberate framing; the settle-time camera tracking must not yank it away.
      viewerMovedCameraRef.current = true;

      return;
    }

    const fitted = fitTransform(simNodesRef.current, canvasWidth, canvasHeight, null);
    if (fitted) {
      animateCamera(fitted.scale, fitted.translate);
      viewerMovedCameraRef.current = false;
    }
  }, [animateCamera, canvasHeight, flyToNodeId, width]);

  // A new node set is a new picture, so it earns a new frame even if the viewer
  // moved the camera around the old one.
  useEffect(() => {
    viewerMovedCameraRef.current = false;
  }, [nodesKey]);

  /** Link count per node, which is what node size encodes. */
  const degreeById = useMemo(() => {
    const degrees = new Map<string, number>();

    for (const link of links) {
      degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
      degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
    }

    // The dots payload ships each node's true edge count; the links on screen are at most a
    // fetched section of them, so the server's number wins where it exists.
    for (const node of nodes) {
      if (typeof node.degree === 'number') {
        degrees.set(node.id, node.degree);
      }
    }

    return degrees;
  }, [links, nodes]);

  /** Who is one hop from whom, so hovering a node can pick out its own corner of the graph. */
  const neighborsById = useMemo(() => {
    const neighbors = new Map<string, Set<string>>();

    const connect = (from: string, to: string) => {
      const existing = neighbors.get(from);
      if (existing) {
        existing.add(to);
      } else {
        neighbors.set(from, new Set([to]));
      }
    };

    for (const link of links) {
      connect(link.source, link.target);
      connect(link.target, link.source);
    }

    return neighbors;
  }, [links]);

  /**
   * How far each node sits from the focused one, which is what separates its own connections from
   * the neighbourhood they drag in behind them.
   *
   * Keyed on the link set rather than on the selection, for the same reason `standingLabels` is:
   * this feeds the layout, and recomputing it on a click would relay the whole graph out.
   */
  const hopDistanceById = useMemo(
    () =>
      focusHops === undefined
        ? new Map<string, number>()
        : hopDistances(
            centerNodeId,
            links.map((link) => ({ sourceId: link.source, targetId: link.target })),
          ),
    [centerNodeId, focusHops, links],
  );

  const isContext = useCallback(
    (nodeId: string) => isContextNode(hopDistanceById.get(nodeId), focusHops),
    [focusHops, hopDistanceById],
  );

  /**
   * Which nodes carry a standing label.
   *
   * Anchored on `centerNodeId` ONLY. This feeds the layout effect, and the graph explorer passes its
   * live selection as `highlightedNodeId` — including that here would restart the whole simulation
   * on every node click and throw away the picture the viewer was reading. A selected or hovered
   * node still gets its label at render time, which costs nothing and moves nothing.
   */
  const standingLabels = useMemo(
    () =>
      // LOD mode has no standing labels at all: names are earned by zooming in (viewport-culled,
      // see lodView) or by emphasis, never reserved room in the layout.
      lodMode
        ? new Set<string>()
        : standingLabelIds(
            nodes,
            (id) => degreeById.get(id) ?? 0,
            [centerNodeId],
            (id) => !isContext(id),
          ),
    [centerNodeId, degreeById, isContext, lodMode, nodes],
  );

  useEffect(() => {
    if (nodes.length === 0) {
      previousPositionsRef.current = new Map();
      setSimNodes([]);
      setSimLinks([]);

      return;
    }

    // Built here rather than in a ref initialiser: the probe has to be mounted before its
    // computed font can be read.
    if (!measurerRef.current) {
      measurerRef.current = createTextMeasurer(fontProbeRef.current);
    }

    const measure = measurerRef.current?.width ?? estimateLabelWidth;
    const labelHalfHeight = measurerRef.current?.halfHeight ?? LABEL_HALF_HEIGHT_PX;

    const canvasWidth = width || 720;
    // The simulation lays out in a world sized for the labels that have to fit, which is larger than
    // the canvas once the graph is dense; the camera scales the result back down to the canvas.
    // LOD overview uses the canvas as the world so type islands sit in a readable ring.
    // Classic / focus still grows the world with labelled density.
    const { width: boundsWidth, height: boundsHeight } = lodMode
      ? { width: canvasWidth, height: canvasHeight }
      : simulationBounds(standingLabels.size, canvasWidth, canvasHeight);
    const previousPositions = previousPositionsRef.current;

    const anchoredSet = new Set(anchoredNodeIds);

    const findNeighborPosition = (nodeId: string) => {
      for (const link of links) {
        if (link.source === nodeId) {
          const neighbor = previousPositions.get(link.target);
          if (neighbor) {
            return { x: neighbor.x, y: neighbor.y };
          }
        } else if (link.target === nodeId) {
          const neighbor = previousPositions.get(link.source);
          if (neighbor) {
            return { x: neighbor.x, y: neighbor.y };
          }
        }
      }

      return undefined;
    };

    const withOffset = (base?: { x: number; y: number }) => {
      if (!base) {
        return {
          x: boundsWidth / 2 + (Math.random() - 0.5) * 40,
          y: boundsHeight / 2 + (Math.random() - 0.5) * 40,
        };
      }

      const angle = Math.random() * Math.PI * 2;
      const distance = 60 + Math.random() * 30;

      return {
        x: base.x + Math.cos(angle) * distance,
        y: base.y + Math.sin(angle) * distance,
      };
    };

    // LOD seeding: one coherent sunflower per type. Always re-seed in lodMode (ignore
    // previousPositions) so progressive first-page → full-page densify cannot leave a
    // trail of stale slots — that was the horizontal "startup row" of Persons.
    // Member index is stable by id sort within type, not payload order.
    const presentTypes = [...new Set(nodes.map((node) => node.entity_type))];
    const typeRingCount = lodTypeRingCount(presentTypes);
    const membersByType = new Map<string, string[]>();
    for (const node of nodes) {
      const list = membersByType.get(node.entity_type) ?? [];
      list.push(node.id);
      membersByType.set(node.entity_type, list);
    }

    const memberIndexById = new Map<string, number>();
    const memberCountByType = new Map<string, number>();
    for (const [type, ids] of membersByType) {
      ids.sort();
      memberCountByType.set(type, ids.length);
      ids.forEach((id, index) => memberIndexById.set(id, index));
    }

    const nodeCopies: ForceNode[] = nodes.map((node) => {
      const previous = previousPositions.get(node.id);
      const anchored = anchoredSet.has(node.id);

      // Drawn size and label extent are resolved ONCE, here, and carried on the node: the layout
      // has to reserve exactly the room the renderer will use, or the collision pass separates
      // boxes that are not the boxes on screen.
      const fullLabel = node.name ?? node.entity_type ?? '';
      // A node without a standing label is a bare dot that answers on hover, so the layout reserves
      // no horizontal room for it — which is the whole point of dropping the label.
      const labelled = standingLabels.has(node.id);
      const label = labelled ? truncateLabel(fullLabel) : '';
      const degree = degreeById.get(node.id) ?? 0;
      const context = isContext(node.id);
      const pinned = anchored || node.id === centerNodeId;

      const shape = {
        degree,
        context,
        // Degree and distance only — selection/highlight enlarge a node at RENDER time. Baking those
        // in here would rebuild the whole layout on every click for a few pixels on a single node.
        // Distance is different: it is fixed for the life of the picture, and the collision pass has
        // to reserve the radius the renderer will actually draw.
        radius: lodMode
          ? Math.min(
              LOD_MAX_DOT_RADIUS,
              LOD_DOT_RADIUS + Math.sqrt(Math.max(0, degree)) * LOD_DOT_DEGREE_FACTOR,
            )
          : nodeRadius(degree) * (context ? CONTEXT_NODE_SCALE : 1),
        label,
        fullLabel,
        labelWidth: label ? labelWidthPx(fullLabel, MAX_LABEL_CHARS, measure) : 0,
        labelHalfHeight,
        pinned,
      };

      const position = lodMode
        ? clusterSeedPosition(
            lodTypeRingIndex(node.entity_type, presentTypes),
            typeRingCount,
            memberIndexById.get(node.id) ?? 0,
            memberCountByType.get(node.entity_type) ?? 1,
            boundsWidth,
            boundsHeight,
          )
        : (previous ?? withOffset(findNeighborPosition(node.id)));

      return {
        ...node,
        ...shape,
        x: position.x,
        y: position.y,
        vx: previous?.vx ?? 0,
        vy: previous?.vy ?? 0,
        anchored,
      };
    });

    const nodeById = new Map(nodeCopies.map((node) => [node.id, node]));

    // Classic/focus: centre + anchors are pins; the rest settle under forces.
    // LOD overview: pin EVERY node at its cluster seed so dots sit independently —
    // relationships never spring the field into a tied-together blob.
    for (const node of nodeCopies) {
      if (lodMode) {
        if (centerNodeId && node.id === centerNodeId) {
          node.x = boundsWidth / 2;
          node.y = boundsHeight / 2;
        }

        node.fx = node.x;
        node.fy = node.y;
        node.vx = 0;
        node.vy = 0;
      } else if (centerNodeId && node.id === centerNodeId) {
        node.x = boundsWidth / 2;
        node.y = boundsHeight / 2;
        node.fx = node.x;
        node.fy = node.y;
      } else if (node.anchored) {
        node.fx = node.x;
        node.fy = node.y;
      }
    }

    // Link ids key both the React elements and the tick handler's element map, so a duplicate id
    // leaves a second line on screen that nothing ever repositions — a frozen ghost thread. A
    // self-loop is a zero-length line, which renders as nothing but its floating arrowhead. Both
    // arrive from real API payloads, so both are dropped here rather than trusted away.
    const seenLinkIds = new Set<string>();
    const linkCopies: SimulationLink[] = links.flatMap((link) => {
      const source = nodeById.get(link.source);
      const target = nodeById.get(link.target);

      if (!source || !target || source === target || seenLinkIds.has(link.id)) {
        return [];
      }

      seenLinkIds.add(link.id);

      return [
        {
          id: link.id,
          sourceId: link.source,
          targetId: link.target,
          relationship_type: link.relationship_type,
          strength: link.strength,
          source,
          target,
        },
      ];
    });

    // Classic mode is Webbed Feet (links + settle). LOD overview skips link/charge/center
    // forces entirely — pins hold the type islands still; edges are draw-only.
    const simulation = forceSimulation<ForceNode>(nodeCopies)
      .force('charge', lodMode ? null : forceManyBody<ForceNode>().strength(CHARGE_STRENGTH))
      .force(
        'collide',
        lodMode ? null : forceCollide<ForceNode>().radius((node) => node.radius + COLLIDE_PADDING),
      )
      .force(
        'link',
        lodMode
          ? null
          : forceLink<ForceNode, SimulationLink>(linkCopies).distance((link) =>
              getSpringLengthFromStrength(link.strength),
            ),
      )
      .force('x', lodMode ? null : forceX<ForceNode>(boundsWidth / 2).strength(CENTERING_STRENGTH))
      .force('y', lodMode ? null : forceY<ForceNode>(boundsHeight / 2).strength(CENTERING_STRENGTH))
      .alphaDecay(ALPHA_DECAY)
      .alphaMin(ALPHA_MIN)
      // The animation loop is ours (see below), not d3-timer's: the tick work includes label
      // relaxation and camera tracking, and one rAF driving all of it keeps them in lockstep.
      .stop();

    if (lodMode) {
      // Nothing to settle — pins are final. Alpha stays cold so nothing can stir the field.
      simulation.alpha(0);
    }

    // Soft arrive: only ids the viewer has never seen in this mount get the birth fade.
    const arriving = new Set<string>();
    for (const node of nodeCopies) {
      if (!seenNodeIdsRef.current.has(node.id)) {
        arriving.add(node.id);
        seenNodeIdsRef.current.add(node.id);
      }
    }

    const applyPositions = () => {
      for (const node of nodeCopies) {
        nodeElsRef.current.get(node.id)?.setAttribute('transform', `translate(${node.x}, ${node.y})`);
      }

      for (const link of linkCopies) {
        const group = linkElsRef.current.get(link.id);
        if (!group) {
          continue;
        }

        for (const child of group.children) {
          if (child.tagName === 'line') {
            child.setAttribute('x1', `${link.source.x}`);
            child.setAttribute('y1', `${link.source.y}`);
            child.setAttribute('x2', `${link.target.x}`);
            child.setAttribute('y2', `${link.target.y}`);
          }
        }
      }
    };

    /**
     * While the picture is settling and the viewer has not taken the camera, drift the frame toward
     * the fit a little each tick — the camera breathes with the web instead of snapping after it.
     * LOD caps fit-zoom so type islands stay grouped, not one magnified clump.
     */
    const trackCamera = (fraction: number) => {
      if (viewerMovedCameraRef.current || cameraFrameRef.current != null) {
        return;
      }

      const anchor = centerNodeId ? { x: boundsWidth / 2, y: boundsHeight / 2 } : null;
      const fitted = fitTransform(nodeCopies, canvasWidth, canvasHeight, anchor);
      if (!fitted) {
        return;
      }

      const targetScale = lodMode ? Math.min(fitted.scale, LOD_MAX_FIT_ZOOM) : fitted.scale;
      scaleRef.current += (targetScale - scaleRef.current) * fraction;
      translateRef.current = {
        x: translateRef.current.x + (fitted.translate.x - translateRef.current.x) * fraction,
        y: translateRef.current.y + (fitted.translate.y - translateRef.current.y) * fraction,
      };
      applyCamera();
    };

    let frame = 0;
    let running = false;
    let lifetimeTicks = 0;

    const settle = () => {
      // The per-tick pass is under-relaxed, so the last tick can still leave a little overlap.
      // Drive it to zero at full strength before the frame the viewer actually reads. LOD mode
      // skips it wholesale: no standing labels means no label boxes to separate, and the pass is
      // O(n²) — at 2000 dots it would cost more than the whole simulation.
      if (!lodMode) {
        for (let pass = 0; pass < COLLISION_POLISH_PASSES; pass += 1) {
          if (relaxLabelCollisions(nodeCopies, 1) === 0) {
            break;
          }
        }
      }

      applyPositions();
      trackCamera(1);
    };

    let breathPhase = 0;
    let idleBreathing = false;

    const applyBreathCamera = () => {
      if (!ambientBreath || !lodMode || viewerMovedCameraRef.current || cameraFrameRef.current != null) {
        return;
      }

      // Slow sine on scale around the current fit — continuous presence without simulation cost.
      breathPhase += 0.04;
      const pulse = 1 + Math.sin(breathPhase) * LOD_BREATH_SCALE_AMP;
      const group = cameraGroupRef.current;
      if (!group) {
        return;
      }

      group.setAttribute(
        'transform',
        `translate(${translateRef.current.x}, ${translateRef.current.y}) scale(${scaleRef.current * pulse})`,
      );
    };

    const idle = () => {
      applyBreathCamera();
      if (idleBreathing) {
        frame = requestAnimationFrame(idle);
      }
    };

    const step = () => {
      lifetimeTicks += 1;
      simulation.tick();
      // Separate overlapping LABELS, not just node centres. The forces above only know about
      // circles, so without this a well-spaced layout still stacks four names on one spot.
      // Resolved positionally rather than through the velocity integrator, which would let labels
      // oscillate through each other instead of settling. Skipped in LOD mode (see settle).
      if (!lodMode) {
        relaxLabelCollisions(nodeCopies, COLLISION_STRENGTH);
      }

      applyPositions();
      // LOD snaps the frame onto the scattered field quickly; classic still breathes in.
      trackCamera(lodMode ? Math.min(1, CAMERA_TRACK * 3) : CAMERA_TRACK);
      applyBreathCamera();

      if (simulation.alpha() >= ALPHA_MIN && lifetimeTicks < MAX_LIFETIME_TICKS) {
        frame = requestAnimationFrame(step);
      } else {
        running = false;
        settle();
        // Keep the camera breath alive after the force settle (single idle loop).
        if (ambientBreath && lodMode) {
          idleBreathing = true;
          frame = requestAnimationFrame(idle);
        }
      }
    };

    const start = () => {
      // Stop the idle breath loop if it owns the frame, then ensure the settle
      // loop is scheduled. Never cancel an in-flight settle frame — that used to
      // drop the rAF while `running` stayed true, so drag reheats during settle
      // killed the animation and left fx unpainted.
      if (idleBreathing) {
        idleBreathing = false;
        cancelAnimationFrame(frame);
        running = false;
      }

      if (!running) {
        running = true;
        frame = requestAnimationFrame(step);
      }
    };

    // Webbed Feet's drag re-tension (classic/focus only). LOD overview stays pinned —
    // drag still moves a single node via fx/fy, but never reheats the whole field.
    reheatRef.current = (alpha: number) => {
      if (lodMode) {
        // Pins are authoritative in LOD — mirror fx/fy onto x/y before painting.
        for (const node of nodeCopies) {
          if (typeof node.fx === 'number') {
            node.x = node.fx;
          }

          if (typeof node.fy === 'number') {
            node.y = node.fy;
          }
        }

        applyPositions();

        return;
      }

      simulation.alpha(Math.max(simulation.alpha(), alpha));
      start();
    };

    setSimNodes(nodeCopies);
    setSimLinks(linkCopies);
    setArrivingIds(arriving);
    const arriveClear = window.setTimeout(() => setArrivingIds(new Set()), 480);

    // First frame: pin/fit immediately. LOD skips the force loop — dots sit still.
    trackCamera(1);
    applyPositions();
    if (lodMode) {
      settle();
      if (ambientBreath) {
        idleBreathing = true;
        frame = requestAnimationFrame(idle);
      }
    } else {
      start();
    }

    return () => {
      idleBreathing = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(arriveClear);

      simulation.stop();
      reheatRef.current = null;
      previousPositionsRef.current = new Map(nodeCopies.map((node) => [node.id, { ...node }]));
    };
  }, [
    ambientBreath,
    anchoredKey,
    applyCamera,
    canvasHeight,
    centerNodeId,
    degreeById,
    isContext,
    links,
    lodMode,
    nodes,
    nodesKey,
    standingLabels,
    width,
  ]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (event.cancelable) {
        event.preventDefault();
      }

      // Manual input takes the camera back from an in-progress flight.
      if (cameraFrameRef.current != null) {
        cancelAnimationFrame(cameraFrameRef.current);
        cameraFrameRef.current = null;
      }

      const svgElement = svgRef.current;
      if (!svgElement) {
        return;
      }

      const rect = svgElement.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;

      const prevScale = scaleRef.current;
      const delta = -event.deltaY * 0.0015;
      const nextScale = clampScale(prevScale * (1 + delta));

      scaleRef.current = nextScale;
      translateRef.current = {
        x: cursorX - ((cursorX - translateRef.current.x) * nextScale) / prevScale,
        y: cursorY - ((cursorY - translateRef.current.y) * nextScale) / prevScale,
      };
      applyCamera();

      viewerMovedCameraRef.current = true;
    },
    [applyCamera],
  );

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) {
      return;
    }

    const listener = (event: WheelEvent) => {
      handleWheel(event);
    };

    svgElement.addEventListener('wheel', listener, { passive: false });

    return () => {
      svgElement.removeEventListener('wheel', listener);
    };
  }, [handleWheel]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target && (target.closest('[data-force-node]') || target.closest('[data-force-link]'))) {
      return;
    }

    if (cameraFrameRef.current != null) {
      cancelAnimationFrame(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }

    capturePointer(event.currentTarget, event.pointerId);
    panStartRef.current = { x: event.clientX, y: event.clientY };
    translateStartRef.current = { ...translateRef.current };
    panMovedRef.current = false;
    setIsPanning(true);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!isPanning) {
        return;
      }

      const dx = event.clientX - panStartRef.current.x;
      const dy = event.clientY - panStartRef.current.y;

      if (dx !== 0 || dy !== 0) {
        viewerMovedCameraRef.current = true;
      }

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        panMovedRef.current = true;
      }

      translateRef.current = {
        x: translateStartRef.current.x + dx,
        y: translateStartRef.current.y + dy,
      };
      applyCamera();
    },
    [applyCamera, isPanning],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!isPanning) {
        return;
      }

      releasePointer(event.currentTarget, event.pointerId);
      setIsPanning(false);
    },
    [isPanning],
  );

  /*
   * Node dragging, ported from Webbed Feet: dragging pins the node under the pointer (fx/fy) and
   * reheats the simulation a little on every move, so the rest of the web visibly re-tensions
   * around the hand. The node stays pinned where it is dropped — arranging the web is the point.
   */
  const nodeDragRef = useRef<{
    node: ForceNode;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  /** Set when a pointer-up ended a drag; the click that follows it must not select. */
  const suppressClickRef = useRef(false);

  const handleNodePointerDown = useCallback(
    (node: ForceNode) => (event: ReactPointerEvent<SVGGElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();
      capturePointer(event.currentTarget, event.pointerId);
      nodeDragRef.current = {
        node,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: node.x,
        startY: node.y,
        moved: false,
      };
    },
    [],
  );

  const handleNodePointerMove = useCallback((event: ReactPointerEvent<SVGGElement>) => {
    const drag = nodeDragRef.current;
    if (!drag) {
      return;
    }

    const screenDx = event.clientX - drag.startClientX;
    const screenDy = event.clientY - drag.startClientY;

    if (!drag.moved && Math.hypot(screenDx, screenDy) < DRAG_THRESHOLD_PX) {
      return;
    }

    drag.moved = true;
    // Pointer deltas are screen pixels; the node lives in world coordinates behind the camera.
    drag.node.fx = drag.startX + screenDx / scaleRef.current;
    drag.node.fy = drag.startY + screenDy / scaleRef.current;
    // Keep label relaxation from shoving the dragged node off the pin.
    drag.node.pinned = true;
    reheatRef.current?.(REHEAT_ALPHA);
  }, []);

  const handleNodePointerUp = useCallback((event: ReactPointerEvent<SVGGElement>) => {
    const drag = nodeDragRef.current;
    if (!drag) {
      return;
    }

    releasePointer(event.currentTarget, event.pointerId);
    if (drag.moved) {
      suppressClickRef.current = true;
    }

    nodeDragRef.current = null;
  }, []);

  /**
   * Hovering or selecting picks out one node's own corner of the graph: it and its direct
   * neighbours stay lit, everything else fades back — but only when a neighbourhood is known.
   * In the dots overview (no edges yet) hover must NOT blank the constellation.
   */
  const hoveredNeighbors = hoveredNodeId ? neighborsById.get(hoveredNodeId) : undefined;
  const selectedNeighbors = selectedNodeId ? neighborsById.get(selectedNodeId) : undefined;

  /** The selected connection thread's two endpoints; everything else recedes while it is chosen. */
  const threadEndpointIds = useMemo(() => {
    if (!selectedLinkId) {
      return null;
    }

    const link = simLinks.find((candidate) => candidate.id === selectedLinkId);

    return link ? new Set([link.sourceId, link.targetId]) : null;
  }, [simLinks, selectedLinkId]);

  const isDimmed = (nodeId: string) => {
    if (hoveredNodeId != null) {
      // Overview with no edges: soft-dim peers so the hovered dot lifts without blanking the sky.
      if (lodMode && (!hoveredNeighbors || hoveredNeighbors.size === 0)) {
        return nodeId !== hoveredNodeId;
      }

      return nodeId !== hoveredNodeId && !hoveredNeighbors?.has(nodeId);
    }

    // Only dim around a selection whose neighbourhood is actually known. In the dots overview the
    // links haven't been fetched yet when a dot is first clicked; fading the whole field for the
    // beat before focus mode takes over reads as the graph breaking, not as emphasis.
    if (selectedNodeId != null && selectedNeighbors && selectedNeighbors.size > 0) {
      return nodeId !== selectedNodeId && !selectedNeighbors.has(nodeId);
    }

    if (threadEndpointIds) {
      return !threadEndpointIds.has(nodeId);
    }

    return false;
  };

  // SVG paints in document order, so the emphasised nodes are drawn last: a hovered node expands to
  // its full name, and that name has to land on top of its neighbours rather than under them.
  const renderOrder = useMemo(() => {
    const rank = (nodeId: string) => {
      if (nodeId === hoveredNodeId) {
        return 3;
      }

      if (nodeId === selectedNodeId) {
        return 2;
      }

      return nodeId === highlightedNodeId ? 1 : 0;
    };

    return [...simNodes].sort((a, b) => rank(a.id) - rank(b.id));
  }, [highlightedNodeId, hoveredNodeId, selectedNodeId, simNodes]);

  return (
    <div ref={ref} className="w-full">
      <svg
        ref={svgRef}
        width={width}
        height={canvasHeight}
        role="img"
        aria-label="Knowledge graph overview"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={(event) => {
          setHoveredNodeId(null);
          handlePointerUp(event);
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (target && (target.closest('[data-force-node]') || target.closest('[data-force-link]'))) {
            return;
          }

          if (panMovedRef.current) {
            return;
          }

          onBackgroundClick?.();
        }}
        style={{ cursor: isPanning ? 'grabbing' : 'grab', touchAction: 'none' }}
        className="fill-foreground text-foreground"
      >
        {/* Same class as a real label; the measurer reads its resolved font. */}
        <text
          ref={fontProbeRef}
          className="text-xs"
          aria-hidden="true"
          visibility="hidden"
          x={-9999}
          y={-9999}
        >
          M
        </text>
        <defs>
          <marker
            id="arrowhead"
            viewBox="0 -5 10 10"
            refX={12}
            refY={0}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M0,-5L10,0L0,5" fill="rgba(148, 163, 184, 0.25)" />
          </marker>
        </defs>
        <g
          ref={cameraGroupRef}
          transform={`translate(${translateRef.current.x}, ${translateRef.current.y}) scale(${scaleRef.current})`}
        >
          <g stroke="rgba(148, 163, 184, 0.35)" strokeWidth={1.1} strokeLinecap="round">
            {simLinks.map((link) => {
              /*
               * Links rest hidden. The picture at rest is a spread of dots; a relationship line
               * earns its ink only while it describes the node the viewer is asking about — the
               * hovered node, the selected node, the focused entity, or an explicitly selected
               * thread. Everything is still in the simulation, so the tension is unchanged; only
               * the ink appears on demand.
               */
              const touchesHovered =
                hoveredNodeId != null && (link.sourceId === hoveredNodeId || link.targetId === hoveredNodeId);
              const touchesSelected =
                selectedNodeId != null &&
                (link.sourceId === selectedNodeId || link.targetId === selectedNodeId);
              const touchesHighlighted =
                highlightedNodeId != null &&
                (link.sourceId === highlightedNodeId || link.targetId === highlightedNodeId);
              // In focus mode the focused entity's own threads are the subject of the picture.
              const touchesFocusCenter =
                focusHops !== undefined &&
                centerNodeId != null &&
                (link.sourceId === centerNodeId || link.targetId === centerNodeId);
              const isThread = link.id === selectedLinkId;
              // Zoomed past the LOD threshold, the fetched section edges show themselves faintly —
              // the "re-render this section" reveal — without anyone pointing at a node yet.
              const sectionRevealed = lodMode && lodView.zoomedIn;
              const askedFor =
                isThread || touchesHovered || touchesSelected || touchesHighlighted || touchesFocusCenter;
              const revealed = askedFor || sectionRevealed;

              // A link with either end out in the context ring runs away from the focused node
              // rather than describing it, so it recedes with the node it leads to.
              const contextual = isContext(link.sourceId) || isContext(link.targetId);
              // Webbed Feet draws its loosest chain dashed; a weak tie is our equivalent.
              const weak = clampRelationshipStrength(link.strength) < WEAK_TIE_THRESHOLD;

              const opacity = !revealed
                ? 0
                : !askedFor
                  ? LOD_SECTION_LINK_OPACITY
                  : isThread
                    ? 1
                    : hoveredNodeId != null && !touchesHovered
                      ? 0.25
                      : contextual
                        ? CONTEXT_LINK_OPACITY
                        : 1;

              return (
                <g
                  key={link.id}
                  ref={(element) => {
                    if (element) {
                      linkElsRef.current.set(link.id, element);
                    } else {
                      linkElsRef.current.delete(link.id);
                    }
                  }}
                  data-force-link
                  data-testid="force-link"
                  data-selected={isThread ? 'true' : undefined}
                  data-hidden={revealed ? undefined : 'true'}
                  className={onLinkSelect && revealed ? 'cursor-pointer' : undefined}
                  // A hidden link must not swallow clicks meant for the canvas behind it.
                  pointerEvents={revealed ? undefined : 'none'}
                  onClick={
                    onLinkSelect
                      ? (clickEvent) => {
                          clickEvent.stopPropagation();
                          onLinkSelect(link.id);
                        }
                      : undefined
                  }
                >
                  <title>{link.relationship_type.split('_').join(' ').toLowerCase()}</title>
                  {/* Invisible, wide hit area: a 1px line is not a clickable thing. */}
                  {onLinkSelect && revealed && (
                    <line
                      x1={link.source.x}
                      y1={link.source.y}
                      x2={link.target.x}
                      y2={link.target.y}
                      stroke="transparent"
                      strokeWidth={12}
                    />
                  )}
                  <line
                    x1={link.source.x}
                    y1={link.source.y}
                    x2={link.target.x}
                    y2={link.target.y}
                    markerEnd="url(#arrowhead)"
                    stroke={isThread ? 'hsl(var(--primary))' : undefined}
                    opacity={opacity}
                    strokeWidth={isThread ? 2.5 : touchesHovered || touchesSelected ? 2 : undefined}
                    strokeDasharray={weak && !isThread ? '4 4' : undefined}
                    style={{ transition: 'opacity 150ms ease' }}
                  />
                </g>
              );
            })}
          </g>

          <g>
            {renderOrder.map((node) => {
              const isHighlighted = node.id === highlightedNodeId;
              const isSelected = node.id === selectedNodeId;
              const isHovered = node.id === hoveredNodeId;
              const dimmed = isDimmed(node.id);
              const emphasised = isSelected || isHighlighted || isHovered;
              // Context recedes until the viewer asks about it. Pointing at a faded node brings it
              // back to full weight along with its name, which is what makes the ring explorable
              // rather than merely quiet.
              const contextual = node.context && !emphasised;
              // LOD dots stay the size the layout gave them; emphasis is what expands one to the
              // classic (labelled, full-size) rendering.
              const radius =
                lodMode && !emphasised
                  ? node.radius
                  : nodeRadius(
                      node.degree,
                      isSelected ? 'selected' : isHighlighted ? 'highlighted' : 'none',
                    ) * (contextual ? CONTEXT_NODE_SCALE : 1);
              const lodLabelled = lodMode && lodView.zoomedIn && lodView.labelIds.has(node.id);
              const baseColor = getTypeColor(node.entity_type);
              const fillColor = isSelected ? 'hsl(var(--primary))' : baseColor;
              const opacity = isSelected ? 1 : isHighlighted ? 1 : lodMode ? LOD_DOT_FILL_OPACITY : 0.9;
              const arriving = arrivingIds.has(node.id);

              return (
                <g
                  key={node.id}
                  ref={(element) => {
                    if (element) {
                      nodeElsRef.current.set(node.id, element);
                    } else {
                      nodeElsRef.current.delete(node.id);
                    }
                  }}
                  transform={`translate(${node.x}, ${node.y})`}
                  className="cursor-pointer"
                  data-force-node
                  data-testid="force-node"
                  data-context={node.context ? 'true' : undefined}
                  data-arriving={arriving ? 'true' : undefined}
                  opacity={
                    dimmed
                      ? lodMode
                        ? hoveredNeighbors && hoveredNeighbors.size > 0
                          ? 0.55
                          : 0.78
                        : 0.35
                      : contextual
                        ? CONTEXT_NODE_OPACITY
                        : 1
                  }
                  onPointerEnter={() => setHoveredNodeId(node.id)}
                  onPointerLeave={() => setHoveredNodeId((current) => (current === node.id ? null : current))}
                  onPointerDown={handleNodePointerDown(node)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;

                      return;
                    }

                    onNodeSelect?.(node.id);
                  }}
                >
                  <title>
                    {node.fullLabel}
                    {node.degree > 0 ? ` — ${node.degree} connection${node.degree === 1 ? '' : 's'}` : ''}
                  </title>
                  <circle
                    className={arriving ? 'force-dot-arrive' : undefined}
                    r={radius}
                    fill={fillColor}
                    fillOpacity={opacity}
                    stroke={isSelected ? 'hsl(var(--primary-foreground))' : 'rgba(15, 23, 42, 0.35)'}
                    strokeWidth={isSelected ? 2 : lodMode ? 0.9 : 1}
                  />
                  {/*
                    The layout keeps these boxes from overlapping (see labelLayout.ts), so the halo
                    below is no longer load-bearing — it just keeps a label legible where it crosses
                    a link line. Long names are clipped to a fixed budget so one label cannot eat the
                    room several others need; the full value lives in the <title> above and is drawn
                    in full on hover.

                    A dense graph gives a standing label only to the nodes worth naming, so a node
                    without one draws no text until it is hovered or selected. That text is NOT in
                    the layout's budget — it is transient, and reflowing the graph under the pointer
                    to make room for it would be worse than letting it overlap for the moment.
                  */}
                  {(node.label !== '' || emphasised || lodLabelled) && (
                    <text
                      x={radius + LABEL_GAP_PX}
                      y={4}
                      className={emphasised ? 'text-xs font-semibold' : 'text-xs'}
                      fill="hsl(var(--foreground))"
                      stroke="hsl(var(--background))"
                      strokeWidth={emphasised ? 4 : 3}
                      strokeLinejoin="round"
                      style={{ paintOrder: 'stroke fill' }}
                    >
                      {emphasised
                        ? node.fullLabel
                        : // Zoom-earned labels are transient like hover labels: drawn truncated,
                          // never reserved room in the layout.
                          node.label || truncateLabel(node.fullLabel)}
                    </text>
                  )}
                  {/* The neighbour count, for the node the viewer is asking about. Transient like
                      the hover label: not in the layout's budget, gone when the emphasis is. */}
                  {emphasised && node.degree > 0 && (
                    <text
                      x={radius + LABEL_GAP_PX}
                      y={17}
                      data-testid="force-node-degree"
                      className="text-[10px]"
                      fill="hsl(var(--muted-foreground))"
                      stroke="hsl(var(--background))"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      style={{ paintOrder: 'stroke fill' }}
                    >
                      {node.degree} connection{node.degree === 1 ? '' : 's'}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}

export const ForceGraph = memo(ForceGraphBase);

export type { ForceGraphProps };
