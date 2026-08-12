import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { apiKeyHeaders, buildApiUrl } from '@ci/common';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { Button, cn } from '@ci/shadcn';
import { AlertCircle, ArrowLeft, Loader2, Sparkles } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { useGraphDots } from '@/api/useGraphDots';
import { useGraphOverview, type GraphNode, type GraphLink } from '@/api/useGraphOverview';
import { useNodeGraphService } from '@/api/useNodeGraphService';
import { colorForRawType } from '@/components/entities/entityVisuals';
import { ForceGraph } from '@/components/ForceGraph';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';
import { useAuth } from '@/hooks';
import { formatEnumLabel } from '@/lib/utils';
import { Empty } from '@/pages/MemoryPage/Components';
import { useEntityService } from '@/pages/MemoryPage/useEntityService';

import { ConnectionThreadDialog } from './ConnectionThreadDialog';
import { EntityInfoDialog, type EntityRelation } from './EntityInfoDialog';

// The 3D renderer pulls in three.js and react-three-fiber; loaded only when 3D is switched on.
const GraphCanvas3D = lazy(() => import('./GraphCanvas3D'));

/**
 * Webbed Feet-inspired graph view (spike/webbed-feet-graph-view).
 *
 * The old explorer drove visibility through spawn limits, hop-depth sliders and click-count
 * expansion; this shell replaces that with three explicit modes over the same read APIs:
 *
 * - Overview: the bounded `/api/graph/data` payload, capped to the busiest nodes.
 * - Focus: one entity's subgraph from `/api/graph/node`, entered from the info dialog and left
 *   through an explicit "Overview" control.
 * - Search: `/api/graph/search` results scoped by the explorer's shared URL filters.
 *
 * Selection opens floating dialogs over the canvas (entity info, connection thread) rather than
 * panels below it. Removed controls are recorded in docs/spikes/webbed-feet-graph-view.md.
 */

/** Overview cap: past this the O(n²) simulation and the label budget both stop earning their keep. */
const MAX_OVERVIEW_NODES = 150;
/** How many viewport node ids the zoomed-in section-edge fetch sends (the endpoint's own cap). */
const SECTION_EDGE_ID_LIMIT = 300;
const SEARCH_RESULT_LIMIT = 20;
/** Focus-mode expansion bounds forwarded to /api/graph/node (client-side caps applied on top). */
const FOCUS_NODE_LIMIT = 60;
/**
 * How far out the focus fetch reaches. One hop is the focused entity's own connections; the rest
 * is drawn as a context ring of receding dots (see FOCUS_OWN_HOPS), so the neighbourhood beyond
 * the subject stays visible — and explorable via hover/click — without competing with it.
 */
const FOCUS_HOP_DEPTH = 3;
/** Hops that count as the focused entity's own graph; everything further renders as context dots. */
const FOCUS_OWN_HOPS = 1;
const MAX_LEGEND_TYPES = 8;
/** The 2D/3D choice survives navigation; a rendering preference, not a per-visit mode. */
const GRAPH_DIMENSION_STORAGE_KEY = 'ci-graph-view-dimension';

interface GraphTabPanelProps {
  variant: 'desktop' | 'mobile';
}

type GraphSearchResponseNode = {
  id?: string;
  entity_id?: string;
  entity_type?: string;
  name?: string | null;
  description?: string | null;
  properties?: Record<string, unknown>;
  score?: number | null;
  distance?: number | null;
};

type DisplayGraph = { nodes: GraphNode[]; links: GraphLink[] };

const EMPTY_GRAPH: DisplayGraph = { nodes: [], links: [] };

export function GraphTabPanel({ variant }: GraphTabPanelProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [focusEntityId, setFocusEntityId] = useState<string | null>(null);
  const [is3D, setIs3D] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GRAPH_DIMENSION_STORAGE_KEY) === '3d';
    } catch {
      return false;
    }
  });

  const handleDimensionChange = useCallback((next: boolean) => {
    setIs3D(next);
    try {
      localStorage.setItem(GRAPH_DIMENSION_STORAGE_KEY, next ? '3d' : '2d');
    } catch {
      // Preference-only; losing persistence is fine.
    }
  }, []);

  const [searchParams] = useSearchParams();

  const trimmedSearchQuery = searchParams?.get('search')?.trim() ?? '';
  const isSearchMode = trimmedSearchQuery.length > 0;

  // Mirror the explorer's entity-type filter (shared via URL with List/Gallery/Map) onto the
  // graph. Translates the explorer display types to the GraphQL vocabulary the graph endpoints
  // expect. `undefined` => filter inactive (all types selected); an array (possibly empty) =>
  // active filter forwarded to the backend.
  const includedEntityTypesParam = searchParams?.get('includedEntityTypes') ?? '';
  const excludedEntityTypesParam = searchParams?.get('excludedEntityTypes') ?? '';

  const explorerIncludeTypes = useMemo<string[] | undefined>(() => {
    const included = includedEntityTypesParam.split(',').filter(Boolean);
    const excluded = excludedEntityTypesParam.split(',').filter(Boolean);

    const selectedDisplayTypes =
      included.length > 0
        ? AVAILABLE_ENTITY_TYPES.filter((type) => included.includes(type))
        : AVAILABLE_ENTITY_TYPES.filter((type) => !excluded.includes(type));

    if (selectedDisplayTypes.length >= AVAILABLE_ENTITY_TYPES.length) {
      return undefined;
    }

    return selectedDisplayTypes
      .map((type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP])
      .filter((type): type is string => Boolean(type));
  }, [includedEntityTypesParam, excludedEntityTypesParam]);

  // Explorer's `tags` URL param (comma-separated labels). Present (even empty)
  // means the tag filter is active; absent leaves the graph unfiltered.
  const rawTags = searchParams?.get('tags');
  const tagsParam = rawTags ?? undefined;

  // Event-scoped LifeScope dimensions, shared via URL with List/Gallery/Map.
  const connectorsParam = searchParams?.get('connectors') ?? '';
  const peopleParamRaw = searchParams?.get('people') ?? '';
  const placesParamRaw = searchParams?.get('places') ?? '';
  const eventTypesParamRaw = searchParams?.get('eventTypes') ?? '';
  const hasLocationParam = searchParams?.get('hasLocation') === '1';
  const dateFromParam = searchParams?.get('from') || undefined;
  const dateToParam = searchParams?.get('to') || undefined;

  const explorerConnectors = useMemo(() => connectorsParam.split(',').filter(Boolean), [connectorsParam]);
  const explorerPeople = useMemo(() => peopleParamRaw.split(',').filter(Boolean), [peopleParamRaw]);
  const explorerPlaces = useMemo(() => placesParamRaw.split(',').filter(Boolean), [placesParamRaw]);
  const explorerEventTypes = useMemo(
    () => eventTypesParamRaw.split(',').filter(Boolean),
    [eventTypesParamRaw],
  );

  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNodes, setSearchNodes] = useState<GraphNode[]>([]);
  const [searchLinks, setSearchLinks] = useState<GraphLink[]>([]);

  const [{ authToken }] = useAuth();

  /**
   * DOTS overview: the default zoomed-out picture — every data type as thousands of tiny dots from
   * GET /graph/dots. Only the filters that endpoint can honor cheaply (entity types, event types)
   * keep it eligible; the restrictive dimensions (tags, connectors, who/where, dates) resolve
   * through the classic /graph/data path with its server-computed match sets.
   */
  const dotsEligible =
    tagsParam === undefined &&
    explorerConnectors.length === 0 &&
    explorerPeople.length === 0 &&
    explorerPlaces.length === 0 &&
    !hasLocationParam &&
    !dateFromParam &&
    !dateToParam;

  const { loading, error, subgraph, userEntityId, filterMatchedEntityIds, filterScope } = useGraphOverview(
    authToken,
    {
      maxDepth: 3,
      includeTypes: explorerIncludeTypes,
      tags: tagsParam,
      connectors: explorerConnectors,
      people: explorerPeople,
      places: explorerPlaces,
      eventTypes: explorerEventTypes,
      hasLocation: hasLocationParam,
      dateFrom: dateFromParam,
      dateTo: dateToParam,
      skip: dotsEligible,
    },
  );

  const {
    loading: dotsLoading,
    hydrating: dotsHydrating,
    error: dotsError,
    nodes: dotNodes,
    userEntityId: dotsUserEntityId,
    counts: dotsCounts,
    truncated: dotsTruncated,
    connectivity: dotsConnectivity,
  } = useGraphDots(authToken, {
    includeTypes: explorerIncludeTypes,
    eventTypes: explorerEventTypes,
    skip: !dotsEligible,
  });

  const dotsUniverseTotal = useMemo(
    () => Object.values(dotsCounts).reduce((sum, count) => sum + count, 0),
    [dotsCounts],
  );

  const sampleHubs = useMemo(() => {
    if (!dotsEligible) {
      return { linked: 0, alone: 0 };
    }

    let linked = 0;
    let alone = 0;
    for (const node of dotNodes) {
      if ((node.degree ?? 0) > 0) {
        linked += 1;
      } else {
        alone += 1;
      }
    }

    return { linked, alone };
  }, [dotsEligible, dotNodes]);

  const isFilterActive = filterScope.tags || filterScope.events;
  const [, { setActiveEntity }] = useEntityService();

  // Focus mode: one entity's neighbourhood from GET /api/graph/node, bounded server- and
  // client-side by useNodeGraphService.
  const {
    data: focusGraph,
    loading: focusLoading,
    error: focusError,
  } = useNodeGraphService({
    entityId: focusEntityId ?? undefined,
    nodeLimit: FOCUS_NODE_LIMIT,
    maxDepth: FOCUS_HOP_DEPTH,
    skip: !focusEntityId,
  });

  /**
   * Section edges for the dots overview: once the viewer zooms past the LOD threshold, fetch the
   * relationships among the nodes actually in frame (POST /graph/edges) and hand them to the
   * canvas, which reveals them faintly. Keyed on the visible-id set so panning within the same
   * neighbourhood doesn't refetch; a new section aborts the previous fetch.
   */
  const [sectionLinks, setSectionLinks] = useState<GraphLink[]>([]);
  const sectionAbortRef = useRef<AbortController | null>(null);
  const sectionKeyRef = useRef('');
  const dotDegreeById = useMemo(
    () => new Map(dotNodes.map((node) => [node.id, node.degree ?? 0])),
    [dotNodes],
  );

  // The fetched section resets with the picture it belongs to.
  useEffect(() => {
    setSectionLinks([]);
    sectionKeyRef.current = '';
  }, [dotNodes]);

  const handleViewportChange = useCallback(
    (visibleNodeIds: string[], zoomedIn: boolean) => {
      if (!dotsEligible || focusEntityId || isSearchMode || !zoomedIn || visibleNodeIds.length === 0) {
        return;
      }

      // The endpoint caps the id list; send the busiest nodes in frame, whose edges are the ones
      // most worth drawing.
      const ids = [...visibleNodeIds]
        .sort((a, b) => (dotDegreeById.get(b) ?? 0) - (dotDegreeById.get(a) ?? 0))
        .slice(0, SECTION_EDGE_ID_LIMIT);

      const key = [...ids].sort().join(',');
      if (key === sectionKeyRef.current) {
        return;
      }

      sectionKeyRef.current = key;
      sectionAbortRef.current?.abort();
      const controller = new AbortController();
      sectionAbortRef.current = controller;

      (async () => {
        try {
          const response = await fetch(buildApiUrl('/api/graph/edges'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...apiKeyHeaders(),
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            credentials: 'include',
            body: JSON.stringify({ ids }),
            signal: controller.signal,
          });

          if (!response.ok) {
            return;
          }

          const payload = await response.json();
          const links = Array.isArray(payload?.data?.links) ? (payload.data.links as GraphLink[]) : [];

          if (!controller.signal.aborted) {
            setSectionLinks(links);
          }
        } catch {
          // A failed/aborted section fetch just leaves the current edges standing.
        }
      })();
    },
    [authToken, dotDegreeById, dotsEligible, focusEntityId, isSearchMode],
  );

  useEffect(() => () => sectionAbortRef.current?.abort(), []);

  // Graph search, scoped by the same explorer filters as /data. Unchanged contract from the
  // previous view, minus the spawn-limit coupling (a fixed result cap instead).
  useEffect(() => {
    if (!isSearchMode) {
      setSearchNodes([]);
      setSearchError(null);
      setSearchLinks([]);
      setSearchLoading(false);

      return;
    }

    if (!authToken) {
      setSearchError('Authentication required for graph search.');
      setSearchNodes([]);
      setSearchLinks([]);

      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function fetchSearch() {
      try {
        setSearchLoading(true);
        setSearchError(null);

        const params = new URLSearchParams({ query: trimmedSearchQuery, limit: '10' });
        if (explorerIncludeTypes !== undefined) {
          params.set('includeTypes', explorerIncludeTypes.join(','));
        }

        if (tagsParam !== undefined) {
          params.set('tags', tagsParam);
        }

        if (explorerConnectors.length > 0) {
          params.set('connectors', explorerConnectors.join(','));
        }

        if (explorerPeople.length > 0) {
          params.set('people', explorerPeople.join(','));
        }

        if (explorerPlaces.length > 0) {
          params.set('places', explorerPlaces.join(','));
        }

        if (explorerEventTypes.length > 0) {
          params.set('eventTypes', explorerEventTypes.join(','));
        }

        if (hasLocationParam) {
          params.set('hasLocation', '1');
        }

        if (dateFromParam) {
          params.set('from', dateFromParam);
        }

        if (dateToParam) {
          params.set('to', dateToParam);
        }

        const response = await fetch(buildApiUrl(`/api/graph/search?${params.toString()}`), {
          headers: {
            ...apiKeyHeaders(),
            Authorization: `Bearer ${authToken}`,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            response.status === 404 ? 'Graph search endpoint not available.' : response.statusText,
          );
        }

        const payload = await response.json();
        const nodesPayload = Array.isArray(payload?.nodes)
          ? (payload.nodes as GraphSearchResponseNode[])
          : [];
        const linksPayload = Array.isArray(payload?.links) ? (payload.links as Partial<GraphLink>[]) : [];

        if (cancelled) {
          return;
        }

        const mapped: GraphNode[] = nodesPayload
          .map((node: GraphSearchResponseNode): GraphNode | null => {
            const entityId: string | undefined = node?.entity_id ?? node?.id;
            if (!entityId) {
              return null;
            }

            return {
              id: entityId,
              entity_id: entityId,
              entity_type: String(node?.entity_type ?? ''),
              name: node?.name ?? null,
              description: node?.description ?? null,
              properties: (node?.properties as Record<string, unknown>) ?? {},
            };
          })
          .filter((node): node is GraphNode => node !== null)
          .slice(0, SEARCH_RESULT_LIMIT);

        const allowedIds = new Set(mapped.map((node) => node.id));

        setSearchNodes(mapped);

        const mappedLinks: GraphLink[] = linksPayload
          .map((link): GraphLink | null => {
            const id =
              typeof link?.id === 'string'
                ? link.id
                : typeof link?.relationship_id === 'string'
                  ? link.relationship_id
                  : null;
            const source = typeof link?.source === 'string' ? link.source : null;
            const target = typeof link?.target === 'string' ? link.target : null;
            if (!id || !source || !target) {
              return null;
            }

            return {
              id,
              relationship_id: (link.relationship_id as string) ?? id,
              source,
              target,
              relationship_type: (link.relationship_type as string) ?? 'UNKNOWN',
              strength: typeof link?.strength === 'number' ? link.strength : 0.5,
              properties: (link?.properties as Record<string, unknown>) ?? {},
            };
          })
          .filter((link): link is GraphLink => link !== null)
          .filter((link) => allowedIds.has(link.source) && allowedIds.has(link.target));
        setSearchLinks(mappedLinks);
      } catch (err) {
        if (cancelled || controller.signal.aborted) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Graph search failed.';
        setSearchError(message);
        setSearchNodes([]);
        setSearchLinks([]);
      } finally {
        if (!cancelled) {
          setSearchLoading(false);
        }
      }
    }

    fetchSearch();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    authToken,
    isSearchMode,
    trimmedSearchQuery,
    explorerIncludeTypes,
    tagsParam,
    explorerConnectors,
    explorerPeople,
    explorerPlaces,
    explorerEventTypes,
    hasLocationParam,
    dateFromParam,
    dateToParam,
  ]);

  /**
   * The overview picture: the bounded /data payload, scoped to restrictive-filter matches when one
   * is active, then capped to the busiest nodes so the whole thing stays layable-out. The owner's
   * node is always kept — it is the anchor the overview is framed around.
   */
  const overviewGraph = useMemo<DisplayGraph>(() => {
    // Dots overview: the type-balanced /graph/dots payload, plus whatever section edges the
    // current zoom has fetched. No cap here — LOD rendering is what makes the count affordable.
    if (dotsEligible) {
      if (dotNodes.length === 0) {
        return EMPTY_GRAPH;
      }

      const dotIds = new Set(dotNodes.map((node) => node.id));

      return {
        nodes: dotNodes,
        links: sectionLinks.filter((link) => dotIds.has(link.source) && dotIds.has(link.target)),
      };
    }

    const nodes = subgraph?.nodes ?? [];
    const links = subgraph?.links ?? [];

    const scopedNodes = filterMatchedEntityIds
      ? nodes.filter((node) => filterMatchedEntityIds.has(node.id))
      : nodes;

    if (scopedNodes.length === 0) {
      return EMPTY_GRAPH;
    }

    const scopedIds = new Set(scopedNodes.map((node) => node.id));
    const scopedLinks = links.filter((link) => scopedIds.has(link.source) && scopedIds.has(link.target));

    if (scopedNodes.length <= MAX_OVERVIEW_NODES) {
      return { nodes: scopedNodes, links: scopedLinks };
    }

    const degrees = new Map<string, number>();
    for (const link of scopedLinks) {
      degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
      degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
    }

    const keep = new Set<string>(
      [...scopedNodes]
        .sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0))
        .slice(0, MAX_OVERVIEW_NODES)
        .map((node) => node.id),
    );

    if (userEntityId && scopedIds.has(userEntityId)) {
      keep.add(userEntityId);
    }

    return {
      nodes: scopedNodes.filter((node) => keep.has(node.id)),
      links: scopedLinks.filter((link) => keep.has(link.source) && keep.has(link.target)),
    };
  }, [dotsEligible, dotNodes, sectionLinks, subgraph, filterMatchedEntityIds, userEntityId]);

  const searchGraph = useMemo<DisplayGraph>(() => {
    const scopedNodes = filterMatchedEntityIds
      ? searchNodes.filter((node) => filterMatchedEntityIds.has(node.id))
      : searchNodes;
    const scopedIds = new Set(scopedNodes.map((node) => node.id));

    return {
      nodes: scopedNodes,
      links: searchLinks.filter((link) => scopedIds.has(link.source) && scopedIds.has(link.target)),
    };
  }, [filterMatchedEntityIds, searchLinks, searchNodes]);

  const mode: 'focus' | 'search' | 'overview' = focusEntityId
    ? 'focus'
    : isSearchMode
      ? 'search'
      : 'overview';

  const displayGraph: DisplayGraph =
    mode === 'focus' ? (focusGraph ?? EMPTY_GRAPH) : mode === 'search' ? searchGraph : overviewGraph;

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of displayGraph.nodes) {
      map.set(node.id, node);
    }

    return map;
  }, [displayGraph.nodes]);

  // A selection only means something while its subject is on screen; mode/data changes that drop
  // the subject drop the selection (and its dialog) with it.
  useEffect(() => {
    if (selectedNodeId && !nodeById.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [nodeById, selectedNodeId]);

  useEffect(() => {
    if (selectedLinkId && !displayGraph.links.some((link) => link.id === selectedLinkId)) {
      setSelectedLinkId(null);
    }
  }, [displayGraph.links, selectedLinkId]);

  const selectedNode = selectedNodeId ? (nodeById.get(selectedNodeId) ?? null) : null;
  const selectedLink = selectedLinkId
    ? (displayGraph.links.find((link) => link.id === selectedLinkId) ?? null)
    : null;

  const selectedNodeRelations = useMemo<EntityRelation[]>(() => {
    if (!selectedNode) {
      return [];
    }

    return displayGraph.links
      .filter((link) => link.source === selectedNode.id || link.target === selectedNode.id)
      .map((link) => {
        const outbound = link.source === selectedNode.id;
        const otherId = outbound ? link.target : link.source;

        return {
          link,
          otherNode: nodeById.get(otherId) ?? null,
          direction: outbound ? ('outbound' as const) : ('inbound' as const),
        };
      });
  }, [displayGraph.links, nodeById, selectedNode]);

  /** Entity types on screen, for the floating legend. */
  const legendTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of displayGraph.nodes) {
      if (node.entity_type) {
        counts.set(node.entity_type, (counts.get(node.entity_type) ?? 0) + 1);
      }
    }

    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LEGEND_TYPES);
  }, [displayGraph.nodes]);

  const handleNodeSelect = useCallback(
    (nodeId: string) => {
      setSelectedLinkId(null);
      setSelectedNodeId(nodeId);

      // In the dots overview a click IS the focus gesture: fly to the dot and expand its subgraph
      // (the webbed-feet zoomToNode + focus pattern). Focus and search keep click = select only.
      if (dotsEligible && !focusEntityId && !isSearchMode) {
        setFocusEntityId(nodeId);
      }
    },
    [dotsEligible, focusEntityId, isSearchMode],
  );

  const handleLinkSelect = useCallback((linkId: string) => {
    setSelectedNodeId(null);
    setSelectedLinkId(linkId);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedLinkId(null);
  }, []);

  const handleFocus = useCallback((entityId: string) => {
    setSelectedLinkId(null);
    setSelectedNodeId(entityId);
    setFocusEntityId(entityId);
  }, []);

  const handleBackToOverview = useCallback(() => {
    setFocusEntityId(null);
    setSelectedNodeId(null);
    setSelectedLinkId(null);
  }, []);

  const handleOpenDetails = useCallback(
    (node: GraphNode) => {
      setActiveEntity({
        __typename: 'GenericEntity',
        id: node.id,
        name: node.name,
        entityType: node.entity_type,
        description: node.description,
        properties: node.properties,
      });
    },
    [setActiveEntity],
  );

  // Full-bleed canvas: the shell owns whatever height the memory hub hands it, measured live so
  // the SVG always fills the frame.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasHeight, setCanvasHeight] = useState(variant === 'mobile' ? 480 : 640);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.height > 200) {
          setCanvasHeight(Math.floor(entry.contentRect.height));
        }
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const overviewLoading = dotsEligible ? dotsLoading : loading;
  const overviewError = dotsEligible ? dotsError : error;
  const overviewUserEntityId = dotsEligible ? dotsUserEntityId : userEntityId;

  const dataLoading = mode === 'search' ? searchLoading : mode === 'focus' ? focusLoading : overviewLoading;
  const dataError =
    mode === 'search' ? searchError : mode === 'focus' ? (focusError?.message ?? null) : overviewError;

  const centerNodeId = mode === 'focus' ? focusEntityId : (overviewUserEntityId ?? undefined);

  let stateOverlay: ReactNode = null;

  if (dataLoading && displayGraph.nodes.length === 0) {
    stateOverlay = (
      <div className="absolute inset-0 z-10 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  } else if (dataError) {
    stateOverlay = (
      <div className="absolute inset-0 z-10 flex items-center justify-center">
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{dataError}</span>
        </div>
      </div>
    );
  } else if (displayGraph.nodes.length === 0) {
    const title = isSearchMode
      ? `No graph nodes found for "${trimmedSearchQuery}"`
      : isFilterActive
        ? 'No graph nodes match the current filters'
        : 'Your knowledge graph is still taking shape';
    const description = isSearchMode
      ? 'Try a different name or keyword — search matches people, places, and concepts.'
      : isFilterActive
        ? 'No entities match the active explorer filters. Try broadening or clearing them.'
        : 'The graph links the entities — people, places, and concepts — drawn out of your memories. It fills in as your imports are processed.';

    stateOverlay = (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 px-4 py-6 text-center">
        <Empty title={title} description={description} icon={Sparkles} />
        {!isSearchMode && !isFilterActive && (
          <p className="max-w-md text-xs text-muted-foreground">
            Imported emails, messages, and events appear in the <span className="font-medium">List</span>,{' '}
            <span className="font-medium">Gallery</span>, and <span className="font-medium">Search</span>{' '}
            views right away — the graph focuses on the people and things they connect.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="graph-shell"
      className={cn(
        'relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background/90',
        variant === 'mobile' ? 'min-h-[420px]' : 'min-h-[480px]',
      )}
    >
      {displayGraph.nodes.length > 0 &&
        (is3D ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 z-10 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            }
          >
            <GraphCanvas3D
              nodes={displayGraph.nodes}
              links={displayGraph.links}
              height={canvasHeight}
              centerNodeId={centerNodeId ?? undefined}
              selectedNodeId={selectedNodeId ?? undefined}
              selectedLinkId={selectedLinkId ?? undefined}
              onNodeSelect={handleNodeSelect}
              onLinkSelect={handleLinkSelect}
              onBackgroundClick={handleBackgroundClick}
              focusHops={mode === 'focus' ? FOCUS_OWN_HOPS : undefined}
            />
          </Suspense>
        ) : (
          <ForceGraph
            nodes={displayGraph.nodes}
            links={displayGraph.links}
            height={canvasHeight}
            centerNodeId={centerNodeId ?? undefined}
            highlightedNodeId={selectedNodeId ?? undefined}
            selectedNodeId={selectedNodeId ?? undefined}
            selectedLinkId={selectedLinkId ?? undefined}
            onNodeSelect={handleNodeSelect}
            onLinkSelect={handleLinkSelect}
            onBackgroundClick={handleBackgroundClick}
            flyToNodeId={selectedNodeId}
            focusHops={mode === 'focus' ? FOCUS_OWN_HOPS : undefined}
            onViewportChange={handleViewportChange}
            forceLod={dotsEligible && mode === 'overview'}
            ambientBreath={dotsEligible && mode === 'overview'}
          />
        ))}

      {/* Soft fog while the second dots wave densifies — canvas stays interactive underneath. */}
      {dotsEligible && mode === 'overview' && dotsHydrating && displayGraph.nodes.length > 0 && (
        <div className="constellation-mist absolute inset-0 z-[5]" aria-hidden />
      )}

      {stateOverlay}

      {/* Floating chrome: mode controls top-left, legend + counts bottom-left. Pointer events stay
          off on the layout wrappers so the canvas underneath keeps its pan/zoom. */}
      <div className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2">
        {mode === 'focus' && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-events-auto shadow"
            onClick={handleBackToOverview}
            data-testid="graph-back-to-overview"
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Overview
          </Button>
        )}
        {mode === 'focus' && focusLoading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        {mode === 'search' && (
          <span className="rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
            Search: “{trimmedSearchQuery}”
          </span>
        )}
      </div>

      {/* Rendering dimension: a persisted preference, orthogonal to the overview/focus/search
          modes. One tiny button labelled with the dimension it switches TO; 3D loads its
          renderer on first use. */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-20">
        <button
          type="button"
          data-testid="graph-dimension-toggle"
          aria-label={is3D ? 'Switch to 2D graph' : 'Switch to 3D graph'}
          title={is3D ? 'Switch to 2D' : 'Switch to 3D'}
          onClick={() => handleDimensionChange(!is3D)}
          className="pointer-events-auto rounded border bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          {is3D ? '2D' : '3D'}
        </button>
      </div>

      {displayGraph.nodes.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex max-w-[min(36rem,85%)] flex-col gap-1.5 rounded-md border bg-background/90 px-2.5 py-2 text-xs text-muted-foreground shadow-sm">
          {dotsEligible && mode === 'overview' && dotsConnectivity && dotsConnectivity.total > 0 && (
            <div className="flex flex-col gap-1" data-testid="graph-relatedness">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Relatedness
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {Math.round(dotsConnectivity.relatedRatio * 100)}% linked
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Share of entities with at least one relationship"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(dotsConnectivity.relatedRatio * 100)}
              >
                <div
                  className="h-full rounded-full bg-primary/80 transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.max(2, Math.round(dotsConnectivity.relatedRatio * 100))}%` }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
                <span>
                  <span className="font-medium text-foreground">
                    {dotsConnectivity.related.toLocaleString()}
                  </span>{' '}
                  related
                </span>
                <span className="text-muted-foreground/50">·</span>
                <span>
                  <span className="font-medium text-foreground">
                    {dotsConnectivity.isolated.toLocaleString()}
                  </span>{' '}
                  alone
                </span>
                <span className="text-muted-foreground/50">·</span>
                <span>{dotsConnectivity.total.toLocaleString()} total</span>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-foreground">
              {displayGraph.nodes.length.toLocaleString()}
              {dotsEligible && dotsUniverseTotal > displayGraph.nodes.length
                ? ` of ~${dotsUniverseTotal.toLocaleString()}`
                : ''}{' '}
              shown
              {dotsEligible && mode === 'overview' ? ` · ${sampleHubs.linked.toLocaleString()} hubs` : ''}
              {displayGraph.links.length > 0 ? ` · ${displayGraph.links.length} connections` : ''}
              {dotsTruncated && dotsEligible ? ' · top by links' : ''}
            </span>
            {dotsEligible && mode === 'overview' && dotsHydrating && (
              <span className="constellation-hydrating-chip text-[10px] uppercase tracking-wide text-primary/80">
                materializing
              </span>
            )}
            {legendTypes.map(([type]) => (
              <span key={type} className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: colorForRawType(type) }}
                  aria-hidden
                />
                {formatEnumLabel(type)}
              </span>
            ))}
          </div>
        </div>
      )}

      {selectedNode && (
        <EntityInfoDialog
          node={selectedNode}
          relations={selectedNodeRelations}
          isFocused={mode === 'focus' && focusEntityId === selectedNode.id}
          onFocus={() => handleFocus(selectedNode.id)}
          onOpenDetails={() => handleOpenDetails(selectedNode)}
          onSelectNode={handleNodeSelect}
          onSelectLink={handleLinkSelect}
          onClose={() => setSelectedNodeId(null)}
        />
      )}

      {selectedLink && !selectedNode && (
        <ConnectionThreadDialog
          link={selectedLink}
          sourceNode={nodeById.get(selectedLink.source) ?? null}
          targetNode={nodeById.get(selectedLink.target) ?? null}
          onSelectNode={handleNodeSelect}
          onClose={() => setSelectedLinkId(null)}
        />
      )}
    </div>
  );
}
