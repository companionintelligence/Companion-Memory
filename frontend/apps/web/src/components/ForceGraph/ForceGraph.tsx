import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';
import { colorForRawType } from '@/components/entities/entityVisuals';

import { clampScale, fitTransform } from './fitTransform';

type ForceNode = GraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchored?: boolean;
};

type SimulationLink = {
  id: string;
  sourceId: string;
  targetId: string;
  relationship_type: string;
  strength: number;
};

interface ForceGraphProps {
  nodes: GraphNode[];
  links: GraphLink[];
  highlightedNodeId?: string | null;
  centerNodeId?: string | null;
  height?: number;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  anchoredNodeIds?: string[];
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

const defaultHeight = 420;
const REPULSION_STRENGTH = 1200;
const MIN_SPRING_LENGTH = 30;
const MAX_SPRING_LENGTH = 300;
const MIN_SPRING_STRENGTH = 0.025;
const MAX_SPRING_STRENGTH = 0.16;
const STRENGTH_CURVE_EXPONENT = 2.2;
const DAMPING = 0.85;
const MAX_TICKS = 240;
const MIN_ALPHA = 0.02;
const ALPHA_DECAY = 0.96;

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

function getSpringStrengthFromRelationship(value: number): number {
  const normalized = clampRelationshipStrength(value);
  const curved = Math.pow(normalized, STRENGTH_CURVE_EXPONENT);

  return MIN_SPRING_STRENGTH + curved * (MAX_SPRING_STRENGTH - MIN_SPRING_STRENGTH);
}

function ForceGraphBase({
  nodes,
  links,
  highlightedNodeId,
  centerNodeId,
  selectedNodeId,
  onNodeSelect,
  anchoredNodeIds = [],
  height = defaultHeight,
}: ForceGraphProps) {
  const { ref, width } = useContainerWidth(720);
  const [simNodes, setSimNodes] = useState<ForceNode[]>([]);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const panStartRef = useRef({ x: 0, y: 0 });
  const translateStartRef = useRef({ x: 0, y: 0 });
  const previousPositionsRef = useRef<Map<string, ForceNode>>(new Map());
  const anchoredKey = useMemo(() => anchoredNodeIds.join('|'), [anchoredNodeIds]);
  const nodesKey = useMemo(() => nodes.map((node) => node.id).join('|'), [nodes]);
  const fittedKeyRef = useRef<string | null>(null);
  const viewerMovedCameraRef = useRef(false);

  // A new node set is a new picture, so it earns a new frame even if the viewer
  // moved the camera around the old one.
  useEffect(() => {
    viewerMovedCameraRef.current = false;
  }, [nodesKey]);

  const renderLinks = useMemo<SimulationLink[]>(
    () =>
      links.map((link) => ({
        id: link.id,
        sourceId: link.source,
        targetId: link.target,
        relationship_type: link.relationship_type,
        strength: link.strength,
      })),
    [links],
  );

  useEffect(() => {
    if (nodes.length === 0) {
      previousPositionsRef.current = new Map();
      setSimNodes([]);

      return;
    }

    const boundsWidth = width || 720;
    const boundsHeight = height;
    const previousPositions = previousPositionsRef.current;

    const anchoredSet = new Set(anchoredNodeIds);

    const findNeighborPosition = (nodeId: string) => {
      for (const link of renderLinks) {
        if (link.sourceId === nodeId) {
          const neighbor = previousPositions.get(link.targetId);
          if (neighbor) {
            return { x: neighbor.x, y: neighbor.y };
          }
        } else if (link.targetId === nodeId) {
          const neighbor = previousPositions.get(link.sourceId);
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

    const nodeCopies: ForceNode[] = nodes.map((node) => {
      const previous = previousPositions.get(node.id);
      const anchored = anchoredSet.has(node.id);

      if (previous) {
        return {
          ...node,
          x: previous.x,
          y: previous.y,
          vx: previous.vx ?? 0,
          vy: previous.vy ?? 0,
          anchored,
        };
      }

      const neighborPosition = findNeighborPosition(node.id);
      const position = withOffset(neighborPosition);

      return {
        ...node,
        x: position.x,
        y: position.y,
        vx: 0,
        vy: 0,
        anchored,
      };
    });

    const nodeIndex = new Map<string, number>();
    nodeCopies.forEach((node, idx) => nodeIndex.set(node.id, idx));

    let tickCount = 0;
    let alpha = 1;
    let animationFrame = 0;

    const publishSnapshot = () => {
      const snapshot = nodeCopies.map((node) => ({ ...node }));
      setSimNodes(snapshot);
      previousPositionsRef.current = new Map(snapshot.map((node) => [node.id, node]));
    };

    // Identifies the picture being framed: the same nodes at the same canvas size
    // are the same shot, so they are fitted once.
    const fitKey = `${nodesKey}@${boundsWidth}x${boundsHeight}`;

    const fitToNodes = () => {
      if (viewerMovedCameraRef.current || fittedKeyRef.current === fitKey) {
        return;
      }

      // A pinned centre node is an explicit "put this in the middle"; the fit
      // reframes around it rather than overriding it.
      const anchor = centerNodeId ? { x: boundsWidth / 2, y: boundsHeight / 2 } : null;
      const fitted = fitTransform(nodeCopies, boundsWidth, boundsHeight, anchor);

      if (!fitted) {
        return;
      }

      fittedKeyRef.current = fitKey;
      setScale(fitted.scale);
      setTranslate(fitted.translate);
    };

    const tick = () => {
      tickCount += 1;

      // Repulsion between every pair of nodes
      for (let i = 0; i < nodeCopies.length; i += 1) {
        for (let j = i + 1; j < nodeCopies.length; j += 1) {
          const source = nodeCopies[i];
          const target = nodeCopies[j];
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const distanceSq = Math.max(dx * dx + dy * dy, 0.01);
          const distance = Math.sqrt(distanceSq);
          const force = (REPULSION_STRENGTH * alpha) / distanceSq;
          const fx = (force * dx) / distance;
          const fy = (force * dy) / distance;

          if (!source.anchored) {
            source.vx -= fx;
            source.vy -= fy;
          }

          if (!target.anchored) {
            target.vx += fx;
            target.vy += fy;
          }
        }
      }

      // Spring forces for relationships
      for (const link of renderLinks) {
        const sourceIdx = nodeIndex.get(link.sourceId);
        const targetIdx = nodeIndex.get(link.targetId);
        if (sourceIdx === undefined || targetIdx === undefined) {
          continue;
        }

        const source = nodeCopies[sourceIdx];
        const target = nodeCopies[targetIdx];
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const desired = getSpringLengthFromStrength(link.strength);
        const springStrength = getSpringStrengthFromRelationship(link.strength);
        const springForce = (distance - desired) * springStrength * alpha;
        const fx = (springForce * dx) / distance;
        const fy = (springForce * dy) / distance;

        if (!source.anchored) {
          source.vx += fx;
          source.vy += fy;
        }

        if (!target.anchored) {
          target.vx -= fx;
          target.vy -= fy;
        }
      }

      // Integrate velocities, apply damping, and keep within bounds
      let centerX = 0;
      let centerY = 0;
      for (const node of nodeCopies) {
        if (centerNodeId && node.id === centerNodeId) {
          node.vx = 0;
          node.vy = 0;
          node.x = boundsWidth / 2;
          node.y = boundsHeight / 2;
        } else if (!node.anchored) {
          node.vx *= DAMPING;
          node.vy *= DAMPING;

          node.x += node.vx;
          node.y += node.vy;

          const padding = 32;
          node.x = Math.min(boundsWidth - padding, Math.max(padding, node.x));
          node.y = Math.min(boundsHeight - padding, Math.max(padding, node.y));
        } else {
          node.vx = 0;
          node.vy = 0;
        }

        centerX += node.x;
        centerY += node.y;
      }

      // Recentre around canvas middle
      centerX /= nodeCopies.length;
      centerY /= nodeCopies.length;
      const offsetX = boundsWidth / 2 - centerX;
      const offsetY = boundsHeight / 2 - centerY;
      for (const node of nodeCopies) {
        if (!node.anchored) {
          node.x += offsetX * 0.1;
          node.y += offsetY * 0.1;
        }
      }

      if (tickCount % 2 === 0 || tickCount === 1) {
        publishSnapshot();
      }

      alpha *= ALPHA_DECAY;
      if (tickCount < MAX_TICKS && alpha > MIN_ALPHA) {
        animationFrame = requestAnimationFrame(tick);
      } else {
        publishSnapshot();
        fitToNodes();
      }
    };

    publishSnapshot();
    animationFrame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrame);
      previousPositionsRef.current = new Map(nodeCopies.map((node) => [node.id, { ...node }]));
    };
  }, [anchoredKey, centerNodeId, height, nodes, nodesKey, renderLinks, width]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.cancelable) {
      event.preventDefault();
    }

    const svgElement = svgRef.current;
    if (!svgElement) {
      return;
    }

    const rect = svgElement.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;

    setScale((prevScale) => {
      const delta = -event.deltaY * 0.0015;
      const nextScale = clampScale(prevScale * (1 + delta));

      setTranslate((prevTranslate) => ({
        x: cursorX - ((cursorX - prevTranslate.x) * nextScale) / prevScale,
        y: cursorY - ((cursorY - prevTranslate.y) * nextScale) / prevScale,
      }));

      return nextScale;
    });

    viewerMovedCameraRef.current = true;
  }, []);

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

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && target.closest('[data-force-node]')) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      panStartRef.current = { x: event.clientX, y: event.clientY };
      translateStartRef.current = translate;
      setIsPanning(true);
    },
    [translate],
  );

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

      setTranslate({
        x: translateStartRef.current.x + dx,
        y: translateStartRef.current.y + dy,
      });
    },
    [isPanning],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!isPanning) {
        return;
      }

      event.currentTarget.releasePointerCapture(event.pointerId);
      setIsPanning(false);
    },
    [isPanning],
  );

  const positionsById = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const node of simNodes) {
      if (typeof node.x === 'number' && typeof node.y === 'number') {
        map.set(node.id, { x: node.x, y: node.y });
      }
    }

    return map;
  }, [simNodes]);

  return (
    <div ref={ref} className="w-full">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="img"
        aria-label="Knowledge graph overview"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{ cursor: isPanning ? 'grabbing' : 'grab', touchAction: 'none' }}
        className="fill-foreground text-foreground"
      >
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
        <g transform={`translate(${translate.x}, ${translate.y}) scale(${scale})`}>
          <g stroke="rgba(148, 163, 184, 0.35)" strokeWidth={1.1} strokeLinecap="round">
            {renderLinks.map((link) => {
              const source = positionsById.get(link.sourceId);
              const target = positionsById.get(link.targetId);

              if (!source || !target) {
                return null;
              }

              return (
                <line
                  key={link.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  markerEnd="url(#arrowhead)"
                />
              );
            })}
          </g>

          <g>
            {simNodes.map((node) => {
              if (typeof node.x !== 'number' || typeof node.y !== 'number') {
                return null;
              }

              const isHighlighted = node.id === highlightedNodeId;
              const isSelected = node.id === selectedNodeId;
              const radius = isSelected ? 12 : isHighlighted ? 10 : 6;
              const baseColor = getTypeColor(node.entity_type);
              const fillColor = isSelected ? 'hsl(var(--primary))' : baseColor;
              const opacity = isSelected ? 1 : isHighlighted ? 0.95 : 0.85;

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className="cursor-pointer"
                  data-force-node
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onNodeSelect?.(node.id);
                  }}
                >
                  <circle
                    r={radius}
                    fill={fillColor}
                    fillOpacity={opacity}
                    stroke={isSelected ? 'hsl(var(--primary-foreground))' : 'rgba(15, 23, 42, 0.2)'}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  {/*
                    Dense clusters overlap labels ("Mark Thompson" over "Maya Patel",
                    "Emma Smith" over "Anita Garcia"), which turned them into
                    unreadable mush. `paint-order: stroke` draws a background-coloured
                    halo behind each glyph so the topmost label stays legible wherever
                    two collide. Selected/highlighted labels also render above the
                    rest via a larger halo and bolder weight.
                  */}
                  <text
                    x={radius + 4}
                    y={4}
                    className={isSelected || isHighlighted ? 'text-xs font-semibold' : 'text-xs'}
                    fill="hsl(var(--foreground))"
                    stroke="hsl(var(--background))"
                    strokeWidth={isSelected || isHighlighted ? 4 : 3}
                    strokeLinejoin="round"
                    style={{ paintOrder: 'stroke fill' }}
                  >
                    {node.name ?? node.entity_type}
                  </text>
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
