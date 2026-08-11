import { useEffect, useMemo, useRef } from 'react';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import R3fForceGraph, { type GraphMethods } from 'r3f-forcegraph';
import {
  CanvasTexture,
  Group,
  LineBasicMaterial,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';
import { colorForRawType } from '@/components/entities/entityVisuals';
import {
  CONTEXT_NODE_OPACITY,
  CONTEXT_NODE_SCALE,
  hopDistances,
  isContextNode,
  nodeRadius,
  standingLabelIds,
  truncateLabel,
} from '@/components/ForceGraph/labelLayout';

/**
 * The 3D rendering of the Webbed Feet graph view, on r3f-forcegraph (react-three-fiber bindings
 * for three-forcegraph). A sibling of the 2D `ForceGraph`, not a replacement: it accepts the same
 * selection/focus contract the shell already speaks — node and link selection, background-click
 * deselect, camera pull toward the selected node, and the focus-mode context ring — and renders
 * them with the library's own d3-force-3d simulation instead of our hand-tuned 2D one.
 *
 * Deliberately NOT ported into 3D: node dragging (r3f-forcegraph exposes no drag interaction; the
 * orbit camera owns the pointer), dashed weak ties (LineDashedMaterial needs per-line distance
 * recomputation every tick; weak ties read as fainter lines instead), and the standing-label
 * collision layout (labels billboard toward the camera, so 2D box separation has no meaning).
 */

interface GraphCanvas3DProps {
  nodes: GraphNode[];
  links: GraphLink[];
  height?: number;
  centerNodeId?: string | null;
  selectedNodeId?: string | null;
  selectedLinkId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onLinkSelect?: (linkId: string) => void;
  onBackgroundClick?: () => void;
  focusHops?: number;
}

type SceneNode = {
  id: string;
  fullLabel: string;
  label: string;
  entityType: string;
  color: string;
  /** World-unit sphere radius, from the same degree curve as the 2D dots. */
  radius: number;
  /** On screen as neighbourhood context rather than as subject (focus mode). */
  context: boolean;
  /** Carries a standing label sprite; everything else answers on hover only. */
  labelled: boolean;
  x?: number;
  y?: number;
  z?: number;
};

type SceneLink = {
  id: string;
  relationship_type: string;
  strength: number;
  /** Endpoint ids, kept flat because the library rewrites source/target to node objects. */
  sourceId: string;
  targetId: string;
  /** Touches a context node, so it recedes with it. */
  context: boolean;
  source: string;
  target: string;
};

/** Ties looser than this read as faint threads — the 3D stand-in for the 2D dashed stroke. */
const WEAK_TIE_THRESHOLD = 0.35;
/** 2D px radii land at 5–14; the 3D world reads best at roughly half that in world units. */
const WORLD_RADIUS_SCALE = 0.55;
const LABEL_FONT_PX = 30;
/** World units per label-canvas pixel. */
const LABEL_WORLD_PER_PX = 0.16;

/** Effective theme: the explicit root class when present, the system preference otherwise. */
function isDarkTheme(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }

  const root = document.documentElement.classList;
  if (root.contains('dark')) {
    return true;
  }

  if (root.contains('light')) {
    return false;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/**
 * Resolves a theme token to a literal color three.Color can eat, by letting the browser do the
 * resolving: paint a probe element with the token and read the computed rgb back. Rebuilding the
 * color by string ("hsl(<raw components>)") breaks silently the moment a token is authored in any
 * other format — the invalid string parses to black, which on the dark canvas is an invisible
 * label. The probe works whatever the token holds.
 */
function resolveThemeColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') {
    return fallback;
  }

  const probe = document.createElement('span');
  probe.style.display = 'none';

  document.body.appendChild(probe);
  try {
    // shadcn tokens hold raw HSL components (used as `hsl(var(--x))`); tokens holding a full
    // color only resolve bare. Try both — an invalid value leaves `color` empty.
    for (const expression of [`hsl(var(${variable}))`, `var(${variable})`]) {
      probe.style.color = '';
      probe.style.color = expression;
      const resolved = getComputedStyle(probe).color;
      if (resolved && resolved !== 'rgba(0, 0, 0, 0)' && probe.style.color !== '') {
        return resolved;
      }
    }

    return fallback;
  } finally {
    probe.remove();
  }
}

/**
 * Billboard label sprite: text with a background-colored halo, drawn once into a canvas texture.
 * Rendered on top (no depth test) — a label a sphere or a link can occlude is a label that
 * cannot be read from half the orbit angles.
 */
function makeLabelSprite(text: string, color: string, haloColor: string): Sprite | null {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const font = `600 ${LABEL_FONT_PX}px Inter, system-ui, sans-serif`;
  context.font = font;
  const padding = 12;
  canvas.width = Math.max(2, Math.ceil(context.measureText(text).width) + padding * 2);
  canvas.height = LABEL_FONT_PX + padding * 2;

  // Setting canvas dimensions resets the context state, so the font goes back on.
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.strokeStyle = haloColor;
  context.lineWidth = 7;
  context.strokeText(text, canvas.width / 2, canvas.height / 2);
  context.fillStyle = color;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
  );
  sprite.renderOrder = 2;
  sprite.scale.set(canvas.width * LABEL_WORLD_PER_PX, canvas.height * LABEL_WORLD_PER_PX, 1);

  return sprite;
}

function GraphScene({
  sceneNodes,
  sceneLinks,
  centerNodeId,
  focusCenterId,
  selectedNodeId,
  selectedLinkId,
  onNodeSelect,
  onLinkSelect,
}: {
  sceneNodes: SceneNode[];
  sceneLinks: SceneLink[];
  centerNodeId?: string | null;
  /** The focused entity in focus mode; its threads stay visible like the 2D canvas'. */
  focusCenterId?: string | null;
  selectedNodeId?: string | null;
  selectedLinkId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onLinkSelect?: (linkId: string) => void;
}) {
  const fgRef = useRef<GraphMethods<SceneNode, SceneLink>>(undefined);
  const controlsRef = useRef<OrbitControls | null>(null);
  const flyTargetRef = useRef<Vector3>(new Vector3());
  const { camera, gl } = useThree();

  const graphData = useMemo(() => ({ nodes: sceneNodes, links: sceneLinks }), [sceneNodes, sceneLinks]);

  const selectedLink = selectedLinkId ? sceneLinks.find((link) => link.id === selectedLinkId) : undefined;
  const threadEndpointIds = selectedLink ? [selectedLink.sourceId, selectedLink.targetId] : [];
  const threadKey = threadEndpointIds.join('|');

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 12;
    controls.maxDistance = 1400;
    controlsRef.current = controls;

    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl]);

  // Retune the library's stock forces toward the Webbed Feet settle: strength-mapped link
  // distances so strong ties pull close, and a slightly softer charge than the default.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) {
      return;
    }

    const linkForce = fg.d3Force('link') as
      | {
          distance: (fn: (link: SceneLink) => number) => void;
          strength: (fn: (link: SceneLink) => number) => void;
        }
      | undefined;
    linkForce?.distance((link) => 26 + (1 - link.strength) * 60);
    linkForce?.strength((link) => 0.25 + link.strength * 0.55);

    const chargeForce = fg.d3Force('charge') as { strength: (value: number) => void } | undefined;
    chargeForce?.strength(-95);

    fg.d3ReheatSimulation();
  }, [graphData]);

  useFrame(() => {
    fgRef.current?.tickFrame();

    const controls = controlsRef.current;
    if (!controls) {
      return;
    }

    // The camera leans toward the selected node the way the 2D camera flies to it — but through
    // the orbit target, and gently, so it composes with (instead of fighting) manual orbiting.
    if (selectedNodeId) {
      const node = sceneNodes.find((candidate) => candidate.id === selectedNodeId);
      if (node && typeof node.x === 'number') {
        flyTargetRef.current.set(node.x, node.y ?? 0, node.z ?? 0);
        controls.target.lerp(flyTargetRef.current, 0.06);
      }
    }

    controls.update();
  });

  // Label ink is plain white-on-dark / black-on-light rather than a theme token — tinted
  // foregrounds read as muddy at sprite sizes. Keyed to the selection state rather than the
  // theme: selection changes are the moments the scene rebuilds anyway, so the ink follows a
  // theme change by the next interaction — the right economy for a spike.
  const dark = useMemo(() => isDarkTheme(), [selectedNodeId, threadKey]);
  const labelColor = dark ? '#ffffff' : '#000000';
  const haloColor = dark ? 'rgba(0, 0, 0, 0.75)' : 'rgba(255, 255, 255, 0.85)';
  const primaryColor = useMemo(() => resolveThemeColor('--primary', '#7dd3a8'), [selectedNodeId, threadKey]);

  // Node objects rebuild whenever the selection state changes — that is what re-dresses emphasis
  // and dimming. At overview scale (<=150 nodes) a rebuild is cheap.
  const nodeThreeObject = useMemo(() => {
    const threadIds = new Set(threadEndpointIds);

    return (node: SceneNode) => {
      const isSelected = node.id === selectedNodeId;
      const isCenter = node.id === centerNodeId;
      const dimmedByThread = threadIds.size > 0 && !threadIds.has(node.id);

      const opacity = dimmedByThread ? 0.15 : node.context ? CONTEXT_NODE_OPACITY : 0.92;
      const radius = node.radius * (isSelected ? 1.25 : 1);

      const sphere = new Mesh(
        new SphereGeometry(radius, 24, 24),
        new MeshLambertMaterial({
          color: node.color,
          emissive: isSelected || isCenter ? node.color : '#000000',
          emissiveIntensity: isSelected ? 0.9 : isCenter ? 0.55 : 0,
          transparent: true,
          opacity,
        }),
      );

      const group = new Group();
      group.add(sphere);

      if (node.labelled && !node.context && !dimmedByThread) {
        const sprite = makeLabelSprite(node.label, labelColor, haloColor);
        if (sprite) {
          sprite.position.set(0, radius + sprite.scale.y / 2 + 1.2, 0);
          group.add(sprite);
        }
      }

      return group;
    };
  }, [threadKey, selectedNodeId, centerNodeId, labelColor, haloColor]);

  // Links rest hidden, matching the 2D canvas: a line earns its ink only while it describes the
  // selected node, the focused entity, or an explicitly selected thread.
  const isLinkRevealed = useMemo(() => {
    return (link: SceneLink) =>
      link.id === selectedLinkId ||
      (selectedNodeId != null && (link.sourceId === selectedNodeId || link.targetId === selectedNodeId)) ||
      (focusCenterId != null && (link.sourceId === focusCenterId || link.targetId === focusCenterId));
  }, [selectedLinkId, selectedNodeId, focusCenterId]);

  // Non-thread links carry their own material so opacity can vary per link; the selected thread
  // returns null to take the library's default cylinder material, colored by linkColor below.
  const linkMaterial = useMemo(() => {
    return (link: SceneLink) => {
      if (link.id === selectedLinkId) {
        return null;
      }

      if (!isLinkRevealed(link)) {
        return new LineBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0, visible: false });
      }

      const dimmedByThread = Boolean(selectedLinkId);
      const opacity = dimmedByThread
        ? 0.08
        : link.context
          ? 0.2
          : link.strength < WEAK_TIE_THRESHOLD
            ? 0.3
            : 0.55;

      return new LineBasicMaterial({ color: '#94a3b8', transparent: true, opacity });
    };
  }, [selectedLinkId, isLinkRevealed]);

  return (
    <R3fForceGraph<SceneNode, SceneLink>
      ref={fgRef}
      graphData={graphData}
      nodeThreeObject={nodeThreeObject}
      linkMaterial={linkMaterial}
      linkColor={() => primaryColor}
      linkWidth={(link) => (link.id === selectedLinkId ? 1.4 : 0)}
      linkDirectionalParticles={(link) => (link.id === selectedLinkId ? 3 : 0)}
      linkDirectionalParticleWidth={1.6}
      linkDirectionalParticleSpeed={0.006}
      linkDirectionalParticleColor={() => primaryColor}
      onNodeClick={(node) => {
        if (node.id) {
          onNodeSelect?.(String(node.id));
        }
      }}
      onLinkClick={(link) => {
        const typed = link as SceneLink;
        // The raycaster still hits an invisible line; a hidden thread is not a clickable thing.
        if (typed.id && isLinkRevealed(typed)) {
          onLinkSelect?.(typed.id);
        }
      }}
      onNodeHover={(node) => {
        gl.domElement.style.cursor = node ? 'pointer' : '';
      }}
      onLinkHover={(link) => {
        gl.domElement.style.cursor = link ? 'pointer' : '';
      }}
      d3AlphaDecay={0.03}
      d3VelocityDecay={0.35}
      warmupTicks={60}
    />
  );
}

export default function GraphCanvas3D({
  nodes,
  links,
  height = 600,
  centerNodeId,
  selectedNodeId,
  selectedLinkId,
  onNodeSelect,
  onLinkSelect,
  onBackgroundClick,
  focusHops,
}: GraphCanvas3DProps) {
  // Same input hygiene as the 2D graph: duplicate link ids draw twice and self-loops add nothing.
  const sceneLinksBase = useMemo(() => {
    const seen = new Set<string>();

    return links.filter((link) => {
      if (link.source === link.target || seen.has(link.id)) {
        return false;
      }

      seen.add(link.id);

      return true;
    });
  }, [links]);

  // Scene data identity is stable across selection changes so the simulation keeps its layout;
  // selection is dressed by the accessors inside GraphScene instead.
  const { sceneNodes, sceneLinks } = useMemo(() => {
    const degrees = new Map<string, number>();
    for (const link of sceneLinksBase) {
      degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
      degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
    }

    const distances = hopDistances(
      focusHops === undefined ? null : centerNodeId,
      sceneLinksBase.map((link) => ({ sourceId: link.source, targetId: link.target })),
    );

    const contextIds = new Set<string>();
    for (const node of nodes) {
      if (isContextNode(distances.get(node.id), focusHops)) {
        contextIds.add(node.id);
      }
    }

    const labelled = standingLabelIds(
      nodes,
      (id) => degrees.get(id) ?? 0,
      [centerNodeId],
      (id) => !contextIds.has(id),
    );

    const mappedNodes: SceneNode[] = nodes.map((node) => {
      const fullLabel = node.name ?? node.entity_type ?? 'Unknown';
      const context = contextIds.has(node.id);

      return {
        id: node.id,
        fullLabel,
        label: truncateLabel(fullLabel),
        entityType: node.entity_type,
        color: colorForRawType(node.entity_type),
        radius:
          nodeRadius(degrees.get(node.id) ?? 0) * WORLD_RADIUS_SCALE * (context ? CONTEXT_NODE_SCALE : 1),
        context,
        labelled: labelled.has(node.id),
      };
    });

    const mappedLinks: SceneLink[] = sceneLinksBase.map((link) => ({
      id: link.id,
      relationship_type: link.relationship_type,
      strength: link.strength,
      sourceId: link.source,
      targetId: link.target,
      context: contextIds.has(link.source) || contextIds.has(link.target),
      source: link.source,
      target: link.target,
    }));

    return { sceneNodes: mappedNodes, sceneLinks: mappedLinks };
  }, [nodes, sceneLinksBase, centerNodeId, focusHops]);

  return (
    <div data-testid="graph-canvas-3d" style={{ height: `${height}px` }} className="w-full">
      <Canvas
        camera={{ position: [0, 0, Math.max(160, 90 + sceneNodes.length * 2.2)], far: 8000 }}
        onPointerMissed={(event) => {
          // Orbit drags end with a pointer-missed too; only a true click clears the selection.
          if (event.type === 'click') {
            onBackgroundClick?.();
          }
        }}
      >
        <ambientLight intensity={2.4} />
        <directionalLight position={[140, 200, 260]} intensity={1.6} />
        <GraphScene
          sceneNodes={sceneNodes}
          sceneLinks={sceneLinks}
          centerNodeId={centerNodeId}
          focusCenterId={focusHops !== undefined ? centerNodeId : null}
          selectedNodeId={selectedNodeId}
          selectedLinkId={selectedLinkId}
          onNodeSelect={onNodeSelect}
          onLinkSelect={onLinkSelect}
        />
      </Canvas>
    </div>
  );
}
