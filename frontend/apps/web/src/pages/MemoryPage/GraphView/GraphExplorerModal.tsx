import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiKeyHeaders, buildApiUrl } from '@ci/common';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { Badge, Button, Input, Label, Slider, cn } from '@ci/shadcn';
import { AlertCircle, Anchor, Loader2, Sparkles, Users } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { useGraphOverview, type GraphNode, type GraphLink } from '@/api/useGraphOverview';
import { colorForRawType } from '@/components/entities/entityVisuals';
import { ForceGraph, ForceGraph3D } from '@/components/ForceGraph';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';
import { useAuth } from '@/hooks';
import { formatEnumLabel } from '@/lib/utils';
import { Empty } from '@/pages/MemoryPage/Components';
import { useEntityService } from '@/pages/MemoryPage/useEntityService';

const DEFAULT_SPAWN_LIMIT = 10;
const DEFAULT_HOP_DEPTH = 2;
const MIN_HOP_DEPTH = 1;
const MAX_HOP_DEPTH = 7;

// Colour nodes/badges by entity type from the shared LifeScope palette.
function getTypeColor(entityType: string): string {
  return colorForRawType(entityType);
}

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

function hashWithSeed(value: string, seed: string): number {
  const combined = `${seed}:${value}`;
  let hash = 0;

  for (let i = 0; i < combined.length; i += 1) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash |= 0;
  }

  return hash;
}

const resolveEndpointId = (endpoint: unknown): string | undefined => {
  if (typeof endpoint === 'string' || typeof endpoint === 'number') {
    return String(endpoint);
  }

  if (endpoint && typeof endpoint === 'object' && 'id' in endpoint) {
    const candidate = (endpoint as { id?: unknown }).id;
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return String(candidate);
    }
  }

  return undefined;
};

export function GraphTabPanel({ variant }: GraphTabPanelProps) {
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<string[]>([]);
  const [spawnLimitInput, setSpawnLimitInput] = useState(String(DEFAULT_SPAWN_LIMIT));
  const [hopDepth, setHopDepth] = useState(DEFAULT_HOP_DEPTH);
  const [nodeClickCounts, setNodeClickCounts] = useState<Record<string, number>>({});
  const [anchoringEnabled, setAnchoringEnabled] = useState(false);
  const [traversalEnabled, setTraversalEnabled] = useState(false);
  const [includedEntityTypes, setIncludedEntityTypes] = useState<string[]>([]);
  const [includedRelationshipTypes, setIncludedRelationshipTypes] = useState<string[]>([]);
  const previousVisibleRef = useRef<Set<string>>(new Set());
  const entityTypesKeyRef = useRef<string | null>(null);
  const relationshipTypesKeyRef = useRef<string | null>(null);

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
  // Forwarded to the graph data fetch so the graph reflects the same filtered
  // subset. Memoized so the hook's effect only re-runs on a real value change.
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
  const [searchNodes, setSearchNodes] = useState<Array<GraphNode & { score?: number | null }>>([]);
  const [searchLinks, setSearchLinks] = useState<GraphLink[]>([]);

  const [{ authToken }] = useAuth();
  const { loading, error, subgraph, userEntityId, quickStats, filterMatchedEntityIds, filterScope } =
    useGraphOverview(authToken, {
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
    });
  // A restrictive explorer filter (tags and/or the event-scoped dimensions) is
  // engaged — the graph scopes to the matched subset instead of the click-driven
  // interactive view.
  const isFilterActive = filterScope.tags || filterScope.events;
  const [, { setActiveEntity }] = useEntityService();

  const spawnLimit = useMemo(() => {
    const parsed = Number.parseInt(spawnLimitInput, 10);

    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_SPAWN_LIMIT;
  }, [spawnLimitInput]);

  const handleSpawnLimitBlur = useCallback(() => {
    const parsed = Number.parseInt(spawnLimitInput, 10);

    if (Number.isNaN(parsed) || parsed <= 0) {
      setSpawnLimitInput(String(DEFAULT_SPAWN_LIMIT));
    }
  }, [spawnLimitInput]);

  const handleHopDepthChange = useCallback((values: number[]) => {
    const [next] = values;
    if (typeof next === 'number') {
      setHopDepth(Math.min(MAX_HOP_DEPTH, Math.max(MIN_HOP_DEPTH, next)));
    }
  }, []);

  const baseNodes = subgraph?.nodes ?? [];
  const baseLinks = subgraph?.links ?? [];

  const combinedNodes = useMemo<Array<GraphNode & { score?: number | null }>>(() => {
    const map = new Map<string, GraphNode & { score?: number | null }>();

    for (const node of baseNodes) {
      map.set(node.id, node as GraphNode & { score?: number | null });
    }

    for (const node of searchNodes) {
      map.set(node.id, node);
    }

    return Array.from(map.values());
  }, [baseNodes, searchNodes]);

  const combinedLinks = useMemo<GraphLink[]>(() => {
    const map = new Map<string, GraphLink>();

    for (const link of baseLinks) {
      map.set(link.id, link);
    }

    for (const link of searchLinks) {
      map.set(link.id, link);
    }

    return Array.from(map.values());
  }, [baseLinks, searchLinks]);

  const rawNodes = combinedNodes;
  const rawLinks = combinedLinks;
  // Anchor on the owner's entity only when its node is actually in the loaded
  // set — seeding visibility from an absent node renders an empty graph even
  // though data arrived. Without an anchor the expansion effect below falls
  // back to the first loaded node.
  const effectiveUserEntityId = useMemo(() => {
    if (isSearchMode || !userEntityId) {
      return null;
    }

    return rawNodes.some((node) => node.id === userEntityId) ? userEntityId : null;
  }, [isSearchMode, rawNodes, userEntityId]);
  const currentCenterNodeId = traversalEnabled
    ? (selectedNodeId ?? effectiveUserEntityId ?? null)
    : (effectiveUserEntityId ?? null);
  const dataLoading = isSearchMode ? searchLoading : loading;
  const dataError = isSearchMode ? searchError : error;

  const searchSeedIds = useMemo(() => searchNodes.map((node) => node.id), [searchNodes]);
  const searchSeedKey = useMemo(() => searchSeedIds.join('|'), [searchNodes]);
  const lastSearchSeedKeyRef = useRef<string>('');

  useEffect(() => {
    if (!isSearchMode) {
      setSearchNodes([]);
      setSearchError(null);
      setSearchLinks([]);
      setSearchLoading(false);
      lastSearchSeedKeyRef.current = '';

      return;
    }

    if (!authToken) {
      setSearchError('Authentication required for graph search.');
      setSearchNodes([]);
      setSearchLinks([]);
      lastSearchSeedKeyRef.current = '';

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

        // Forward the explorer's restrictive filters so search returns the same
        // scoped subset as /data and the rest of the explorer. Mirrors the param
        // contract in useGraphOverview: `tags` present (even empty) marks the tag
        // filter active; the event-scoped dimensions forward only when set.
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

        const mapped: Array<GraphNode & { score?: number | null }> = nodesPayload
          .map((node: GraphSearchResponseNode): (GraphNode & { score?: number | null }) | null => {
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
              score:
                typeof node?.score === 'number'
                  ? node.score
                  : typeof node?.distance === 'number'
                    ? node.distance
                    : undefined,
            };
          })
          .filter(
            (
              node: (GraphNode & { score?: number | null }) | null,
            ): node is GraphNode & { score?: number | null } => node !== null,
          );

        const limitedNodes = mapped.slice(0, spawnLimit);
        const allowedIds = new Set(limitedNodes.map((node) => node.id));

        setSearchNodes(limitedNodes);

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
          .filter((link: GraphLink | null): link is GraphLink => link !== null)
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
    spawnLimit,
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

  useEffect(() => {
    if (!isSearchMode) {
      lastSearchSeedKeyRef.current = '';

      return;
    }

    if (searchSeedIds.length === 0) {
      setExpandedNodes([]);
      setNodeClickCounts({});
      setSelectedNodeId(null);
      lastSearchSeedKeyRef.current = searchSeedKey;

      return;
    }

    if (lastSearchSeedKeyRef.current === searchSeedKey) {
      return;
    }

    lastSearchSeedKeyRef.current = searchSeedKey;
    const nextCounts: Record<string, number> = {};
    for (const id of searchSeedIds) {
      nextCounts[id] = 0;
    }

    setExpandedNodes(searchSeedIds);
    setNodeClickCounts(nextCounts);
    setSelectedNodeId((current) => {
      if (current && searchSeedIds.includes(current)) {
        return current;
      }

      return searchSeedIds[0] ?? null;
    });
  }, [isSearchMode, searchSeedKey]);

  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>();

    for (const link of rawLinks) {
      const sourceId = resolveEndpointId(link.source);
      const targetId = resolveEndpointId(link.target);

      if (!sourceId || !targetId) {
        continue;
      }

      if (!map.has(sourceId)) {
        map.set(sourceId, new Set());
      }

      if (!map.has(targetId)) {
        map.set(targetId, new Set());
      }

      map.get(sourceId)!.add(targetId);
      map.get(targetId)!.add(sourceId);
    }

    return map;
  }, [rawLinks]);

  const getOrderedNeighbors = useCallback(
    (nodeId: string) => {
      const neighbors = adjacencyMap.get(nodeId);

      if (!neighbors) {
        return [] as string[];
      }

      // Hash each neighbor once up front. Hashing inside the comparator ran
      // O(k log k) string hashes per call, which locked up the main thread on
      // hub nodes with large neighbor sets (this runs on every visibility
      // recompute, i.e. every node click).
      const hashes = new Map<string, number>();
      for (const neighborId of neighbors) {
        hashes.set(neighborId, hashWithSeed(neighborId, nodeId));
      }

      return Array.from(neighbors).sort((a, b) => hashes.get(a)! - hashes.get(b)!);
    },
    [adjacencyMap],
  );

  const getSpawnedNeighbors = useCallback(
    (nodeId: string) => {
      const orderedNeighbors = getOrderedNeighbors(nodeId);

      if (orderedNeighbors.length === 0) {
        return [] as string[];
      }

      const clickCount = nodeClickCounts[nodeId] ?? 0;

      if (clickCount === 0) {
        return [] as string[];
      }

      const effectiveLimit = Math.max(spawnLimit, 1);
      const limit = Math.min(orderedNeighbors.length, clickCount * effectiveLimit);

      return orderedNeighbors.slice(0, limit);
    },
    [getOrderedNeighbors, nodeClickCounts, spawnLimit],
  );

  const getBoundedNeighbors = useCallback(
    (nodeId: string) => {
      const orderedNeighbors = getOrderedNeighbors(nodeId);

      if (orderedNeighbors.length === 0) {
        return [] as string[];
      }

      const effectiveLimit = Math.max(spawnLimit, 1);

      return orderedNeighbors.slice(0, effectiveLimit);
    },
    [getOrderedNeighbors, spawnLimit],
  );

  useEffect(() => {
    if (isSearchMode) {
      previousVisibleRef.current = new Set(rawNodes.map((node) => node.id));

      return;
    }

    if (rawNodes.length === 0) {
      setExpandedNodes((prev) => (prev.length === 0 ? prev : []));
      setNodeClickCounts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      setSelectedNodeId((prev) => (prev === null ? prev : null));

      return;
    }

    const existingIds = new Set(rawNodes.map((node) => node.id));
    const filtered = expandedNodes.filter((id) => existingIds.has(id));
    const initialId = effectiveUserEntityId ?? (rawNodes[0] ? rawNodes[0].id : undefined);

    if (!initialId) {
      return;
    }

    if (filtered.length === 0) {
      setExpandedNodes([initialId]);
      setNodeClickCounts({ [initialId]: 1 });
      setSelectedNodeId((current) => current ?? initialId);

      return;
    }

    if (
      filtered.length !== expandedNodes.length ||
      filtered.some((id, index) => id !== expandedNodes[index])
    ) {
      setExpandedNodes(filtered);
    }

    setNodeClickCounts((prev) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const id of filtered) {
        const existingCount = prev[id] ?? 1;
        next[id] = existingCount;

        if (prev[id] !== existingCount) {
          changed = true;
        }
      }

      if (Object.keys(prev).length !== Object.keys(next).length) {
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [effectiveUserEntityId, expandedNodes, isSearchMode, rawNodes]);

  const visibility = useMemo(() => {
    const set = new Set<string>();
    const seedNodeIds = new Set(expandedNodes);

    if (selectedNodeId) {
      seedNodeIds.add(selectedNodeId);
    }

    if (effectiveUserEntityId) {
      seedNodeIds.add(effectiveUserEntityId);
    }

    const effectiveHopDepth = Math.max(MIN_HOP_DEPTH, hopDepth);

    for (const seedNodeId of seedNodeIds) {
      set.add(seedNodeId);

      const traversed = new Set<string>([seedNodeId]);
      let frontier = [seedNodeId];

      for (let depth = 1; depth <= effectiveHopDepth; depth += 1) {
        if (frontier.length === 0) {
          break;
        }

        const nextFrontier: string[] = [];

        for (const currentNodeId of frontier) {
          const neighbors =
            depth === 1 ? getSpawnedNeighbors(currentNodeId) : getBoundedNeighbors(currentNodeId);

          for (const neighborId of neighbors) {
            set.add(neighborId);

            if (traversed.has(neighborId)) {
              continue;
            }

            traversed.add(neighborId);
            nextFrontier.push(neighborId);
          }
        }

        frontier = nextFrontier;
      }
    }

    const ids = Array.from(set);

    return { ids, set };
  }, [
    effectiveUserEntityId,
    expandedNodes,
    getBoundedNeighbors,
    getSpawnedNeighbors,
    hopDepth,
    selectedNodeId,
  ]);

  const anchoredNodeIds = useMemo(() => {
    const previous = previousVisibleRef.current;
    const anchored: string[] = [];

    for (const id of visibility.ids) {
      if (previous.has(id)) {
        anchored.push(id);
      }
    }

    return anchoringEnabled ? anchored : [];
  }, [anchoringEnabled, visibility.ids]);

  useEffect(() => {
    previousVisibleRef.current = new Set(visibility.ids);
  }, [visibility.ids]);

  // Nodes passing the visibility + explorer-filter gate, BEFORE the in-graph
  // node-type toggle. The "Node types" / "Relationship types" chips derive from
  // this set so they reflect the filtered visible graph rather than every loaded
  // node — yet stay stable under the chip toggles themselves. Deriving them from
  // the post-toggle visible set would let a deselected type drop out of the chip
  // list and never come back (a feedback loop), which is why this is pre-toggle.
  const filterScopedNodeIds = useMemo(() => {
    const scoped = new Set<string>();
    const visibilitySet = new Set(visibility.ids);

    for (const node of rawNodes) {
      if (filterMatchedEntityIds) {
        if (isSearchMode) {
          if (!visibilitySet.has(node.id) || !filterMatchedEntityIds.has(node.id)) {
            continue;
          }
        } else if (!filterMatchedEntityIds.has(node.id)) {
          continue;
        }
      } else if (!visibilitySet.has(node.id)) {
        continue;
      }

      scoped.add(node.id);
    }

    return scoped;
  }, [filterMatchedEntityIds, isSearchMode, rawNodes, visibility.ids]);

  const availableEntityTypes = useMemo(() => {
    const types = new Set<string>();

    for (const node of rawNodes) {
      if (filterScopedNodeIds.has(node.id) && node.entity_type) {
        types.add(node.entity_type);
      }
    }

    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }, [filterScopedNodeIds, rawNodes]);
  const availableEntityTypesKey = useMemo(() => JSON.stringify(availableEntityTypes), [availableEntityTypes]);

  const availableRelationshipTypes = useMemo(() => {
    const types = new Set<string>();

    for (const link of rawLinks) {
      const sourceId = resolveEndpointId(link.source);
      const targetId = resolveEndpointId(link.target);

      if (
        link.relationship_type &&
        sourceId &&
        targetId &&
        filterScopedNodeIds.has(sourceId) &&
        filterScopedNodeIds.has(targetId)
      ) {
        types.add(link.relationship_type);
      }
    }

    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }, [filterScopedNodeIds, rawLinks]);
  const availableRelationshipTypesKey = useMemo(
    () => JSON.stringify(availableRelationshipTypes),
    [availableRelationshipTypes],
  );

  useEffect(() => {
    if (entityTypesKeyRef.current === availableEntityTypesKey) {
      return;
    }

    entityTypesKeyRef.current = availableEntityTypesKey;

    setIncludedEntityTypes((prev) => {
      if (availableEntityTypes.length === 0) {
        return prev.length === 0 ? prev : [];
      }

      const nextSet = new Set(prev.filter((type) => availableEntityTypes.includes(type)));

      if (nextSet.size === 0) {
        availableEntityTypes.forEach((type) => nextSet.add(type));
      } else {
        for (const type of availableEntityTypes) {
          if (!nextSet.has(type)) {
            nextSet.add(type);
          }
        }
      }

      const next = availableEntityTypes.filter((type) => nextSet.has(type));

      if (next.length === prev.length && next.every((type, index) => prev[index] === type)) {
        return prev;
      }

      return next;
    });
  }, [availableEntityTypes, availableEntityTypesKey]);

  useEffect(() => {
    if (relationshipTypesKeyRef.current === availableRelationshipTypesKey) {
      return;
    }

    relationshipTypesKeyRef.current = availableRelationshipTypesKey;

    setIncludedRelationshipTypes((prev) => {
      if (availableRelationshipTypes.length === 0) {
        return prev.length === 0 ? prev : [];
      }

      const nextSet = new Set(prev.filter((type) => availableRelationshipTypes.includes(type)));

      if (nextSet.size === 0) {
        availableRelationshipTypes.forEach((type) => nextSet.add(type));
      } else {
        for (const type of availableRelationshipTypes) {
          if (!nextSet.has(type)) {
            nextSet.add(type);
          }
        }
      }

      const next = availableRelationshipTypes.filter((type) => nextSet.has(type));

      if (next.length === prev.length && next.every((type, index) => prev[index] === type)) {
        return prev;
      }

      return next;
    });
  }, [availableRelationshipTypes, availableRelationshipTypesKey]);

  const entityTypeFilterSet = useMemo(() => new Set(includedEntityTypes), [includedEntityTypes]);
  const relationshipTypeFilterSet = useMemo(
    () => new Set(includedRelationshipTypes),
    [includedRelationshipTypes],
  );

  const isEntityFilterActive = useMemo(
    () =>
      availableEntityTypes.length > 0 &&
      entityTypeFilterSet.size > 0 &&
      entityTypeFilterSet.size < availableEntityTypes.length,
    [availableEntityTypes.length, entityTypeFilterSet],
  );

  const isRelationshipFilterActive = useMemo(
    () =>
      availableRelationshipTypes.length > 0 &&
      relationshipTypeFilterSet.size > 0 &&
      relationshipTypeFilterSet.size < availableRelationshipTypes.length,
    [availableRelationshipTypes.length, relationshipTypeFilterSet],
  );

  const allowedNodeIds = useMemo(() => {
    const allowed = new Set<string>();

    for (const node of rawNodes) {
      // `filterScopedNodeIds` already encodes the visibility + explorer-filter
      // gate (including the search-mode "visibility AND filter match" rule that
      // drops non-matching expanded neighbors). Here we only layer the in-graph
      // node-type toggle on top.
      if (!filterScopedNodeIds.has(node.id)) {
        continue;
      }

      if (isEntityFilterActive) {
        if (!node.entity_type) {
          allowed.add(node.id);

          continue;
        }

        if (!entityTypeFilterSet.has(node.entity_type)) {
          continue;
        }
      }

      allowed.add(node.id);
    }

    return allowed;
  }, [entityTypeFilterSet, isEntityFilterActive, filterScopedNodeIds, rawNodes]);

  const entityTypesAllSelected = includedEntityTypes.length === availableEntityTypes.length;
  const relationshipTypesAllSelected = includedRelationshipTypes.length === availableRelationshipTypes.length;

  const handleEntityTypeToggle = useCallback(
    (type: string) => {
      setIncludedEntityTypes((prev) => {
        const set = new Set(prev);

        if (set.has(type)) {
          set.delete(type);
          if (set.size === 0) {
            availableEntityTypes.forEach((item) => set.add(item));
          }
        } else {
          set.add(type);
        }

        return availableEntityTypes.filter((item) => set.has(item));
      });
    },
    [availableEntityTypes],
  );

  const handleEntityTypeSelectAll = useCallback(() => {
    setIncludedEntityTypes(availableEntityTypes);
  }, [availableEntityTypes]);

  const handleRelationshipTypeToggle = useCallback(
    (type: string) => {
      setIncludedRelationshipTypes((prev) => {
        const set = new Set(prev);

        if (set.has(type)) {
          set.delete(type);
          if (set.size === 0) {
            availableRelationshipTypes.forEach((item) => set.add(item));
          }
        } else {
          set.add(type);
        }

        return availableRelationshipTypes.filter((item) => set.has(item));
      });
    },
    [availableRelationshipTypes],
  );

  const handleRelationshipTypeSelectAll = useCallback(() => {
    setIncludedRelationshipTypes(availableRelationshipTypes);
  }, [availableRelationshipTypes]);

  useEffect(() => {
    if (visibility.ids.length === 0) {
      setSelectedNodeId(null);

      return;
    }

    const visibleSet = new Set(visibility.ids);

    if (!selectedNodeId || !visibleSet.has(selectedNodeId)) {
      const fallback = effectiveUserEntityId ?? visibility.ids[0];
      setSelectedNodeId(fallback ?? null);
    }
  }, [visibility.ids, selectedNodeId, effectiveUserEntityId]);

  const visibleNodes = useMemo(
    () => rawNodes.filter((node) => allowedNodeIds.has(node.id)),
    [allowedNodeIds, rawNodes],
  );

  const visibleLinks = useMemo(() => {
    return rawLinks.filter((link) => {
      const sourceId = resolveEndpointId(link.source);
      const targetId = resolveEndpointId(link.target);

      if (!sourceId || !targetId) {
        return false;
      }

      if (!allowedNodeIds.has(sourceId) || !allowedNodeIds.has(targetId)) {
        return false;
      }

      if (isRelationshipFilterActive) {
        if (!link.relationship_type || !relationshipTypeFilterSet.has(link.relationship_type)) {
          return false;
        }
      }

      return true;
    });
  }, [allowedNodeIds, isRelationshipFilterActive, relationshipTypeFilterSet, rawLinks]);

  const relatedLinks = useMemo(() => {
    if (!selectedNodeId) {
      return [] as typeof visibleLinks;
    }

    return visibleLinks.filter((link) => {
      const sourceId = resolveEndpointId(link.source);
      const targetId = resolveEndpointId(link.target);

      return sourceId === selectedNodeId || targetId === selectedNodeId;
    });
  }, [visibleLinks, selectedNodeId]);

  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.id === selectedNodeId) ?? null,
    [visibleNodes, selectedNodeId],
  );

  const handleNodeSelect = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      setExpandedNodes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));

      // Open the shared EntityDetails sheet, consistent with the List/Gallery/Map
      // views. Graph nodes are REST objects, so map them to the GenericEntity
      // shape that GenericDetails renders. The in-panel sidebar below stays as a
      // secondary preview.
      const node = rawNodes.find((item) => item.id === nodeId);
      if (node) {
        setActiveEntity({
          __typename: 'GenericEntity',
          id: node.id,
          name: node.name,
          entityType: node.entity_type,
          description: node.description,
          properties: node.properties,
        });
      }

      setNodeClickCounts((prev) => {
        const totalNeighbors = adjacencyMap.get(nodeId)?.size ?? 0;
        if (totalNeighbors === 0) {
          return prev[nodeId] ? { ...prev, [nodeId]: 0 } : prev;
        }

        const effectiveLimit = Math.max(spawnLimit, 1);
        const maxClicks = Math.max(1, Math.ceil(totalNeighbors / effectiveLimit));
        const current = prev[nodeId] ?? 0;
        const nextValue = Math.min(maxClicks, current + 1);

        if (nextValue === current) {
          return prev;
        }

        return { ...prev, [nodeId]: nextValue };
      });
    },
    [adjacencyMap, rawNodes, setActiveEntity, spawnLimit],
  );

  const detailGridClass = variant === 'desktop' ? 'grid gap-4 md:grid-cols-3' : 'grid gap-4 grid-cols-1';
  const graphHeight = variant === 'mobile' ? 440 : 640;

  if (dataLoading) {
    return (
      <div className="flex h-[540px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (dataError) {
    return (
      <div className="flex h-[540px] items-center justify-center">
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{dataError}</span>
        </div>
      </div>
    );
  }

  if (visibleNodes.length === 0) {
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

    return (
      <div className="flex h-[540px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-muted px-4 py-6 text-center">
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
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border bg-background p-1">
            <Button
              type="button"
              size="sm"
              variant={viewMode === '2d' ? 'default' : 'ghost'}
              onClick={() => setViewMode('2d')}
              aria-pressed={viewMode === '2d'}
            >
              2D
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === '3d' ? 'default' : 'ghost'}
              onClick={() => setViewMode('3d')}
              aria-pressed={viewMode === '3d'}
            >
              3D
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="neighbor-limit" className="text-xs font-medium text-muted-foreground">
              Neighbors
            </Label>
            <Input
              id="neighbor-limit"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              className="h-8 w-20"
              value={spawnLimitInput}
              onChange={(event) => setSpawnLimitInput(event.target.value)}
              onBlur={handleSpawnLimitBlur}
            />
          </div>

          <div className="flex min-w-56 flex-1 items-center gap-3">
            <Label className="whitespace-nowrap text-xs font-medium text-muted-foreground">Hop depth</Label>
            <Slider
              value={[hopDepth]}
              min={MIN_HOP_DEPTH}
              max={MAX_HOP_DEPTH}
              step={1}
              onValueChange={handleHopDepthChange}
              aria-label="Hop depth"
              className="min-w-32 flex-1"
            />
            <span className="w-10 text-right text-sm font-medium tabular-nums">{hopDepth}</span>
          </div>

          <Button
            type="button"
            size="sm"
            variant={anchoringEnabled ? 'default' : 'secondary'}
            onClick={() => setAnchoringEnabled((prev) => !prev)}
            aria-pressed={anchoringEnabled}
          >
            <Anchor className="mr-2 h-4 w-4" />
            Anchor
          </Button>
          <Button
            type="button"
            size="sm"
            variant={traversalEnabled ? 'default' : 'secondary'}
            onClick={() => setTraversalEnabled((prev) => !prev)}
            aria-pressed={traversalEnabled}
          >
            Traversal
          </Button>
        </div>

        {(availableEntityTypes.length > 0 || availableRelationshipTypes.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
            {availableEntityTypes.length > 0 && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant={entityTypesAllSelected ? 'default' : 'secondary'}
                  onClick={handleEntityTypeSelectAll}
                >
                  All nodes
                </Button>
                {availableEntityTypes.map((type) => {
                  const isActive = includedEntityTypes.includes(type);

                  return (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant={isActive ? 'default' : 'secondary'}
                      onClick={() => handleEntityTypeToggle(type)}
                      aria-pressed={isActive}
                    >
                      <span
                        className="mr-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: getTypeColor(type) }}
                      />
                      {type}
                    </Button>
                  );
                })}
              </>
            )}

            {availableRelationshipTypes.length > 0 && (
              <>
                <span className="mx-1 h-7 w-px self-center bg-border" />
                <Button
                  type="button"
                  size="sm"
                  variant={relationshipTypesAllSelected ? 'default' : 'secondary'}
                  onClick={handleRelationshipTypeSelectAll}
                >
                  All links
                </Button>
                {availableRelationshipTypes.map((type) => {
                  const isActive = includedRelationshipTypes.includes(type);

                  return (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant={isActive ? 'default' : 'secondary'}
                      onClick={() => handleRelationshipTypeToggle(type)}
                      aria-pressed={isActive}
                    >
                      {formatEnumLabel(type)}
                    </Button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      <div className="relative overflow-hidden">
        <div
          className={cn('rounded-lg border bg-background/90 p-2 overflow-hidden')}
          style={{ height: graphHeight }}
        >
          {viewMode === '2d' ? (
            <ForceGraph
              nodes={visibleNodes}
              links={visibleLinks}
              centerNodeId={currentCenterNodeId ?? undefined}
              highlightedNodeId={selectedNodeId ?? undefined}
              selectedNodeId={selectedNodeId ?? undefined}
              onNodeSelect={handleNodeSelect}
              anchoredNodeIds={anchoredNodeIds}
              height={graphHeight}
            />
          ) : (
            <ForceGraph3D
              nodes={visibleNodes}
              links={visibleLinks}
              centerNodeId={currentCenterNodeId ?? undefined}
              selectedNodeId={selectedNodeId ?? undefined}
              onNodeSelect={handleNodeSelect}
              anchoredNodeIds={anchoredNodeIds}
              height={graphHeight}
            />
          )}
        </div>
      </div>

      <div className={detailGridClass}>
        <div className="space-y-4 min-w-0">
          <div className="rounded-lg border bg-muted/30 p-4 overflow-hidden">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Users className="h-4 w-4 text-primary" />
              Summary
            </h3>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Nodes</dt>
                <dd className="font-medium">{visibleNodes.length}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Relationships</dt>
                <dd className="font-medium">{visibleLinks.length}</dd>
              </div>
              {quickStats && (
                <>
                  {/* Account totals from /api/graph/context — not scoped to the
                      filtered/searched view above, so label them to avoid
                      conflating them with the current Nodes/Relationships counts. */}
                  <div className="border-t border-border/60 pt-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Account-wide
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Preferences</dt>
                    <dd className="font-medium">{quickStats.totalPreferences}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Dislikes</dt>
                    <dd className="font-medium">{quickStats.totalDislikes}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Family Size</dt>
                    <dd className="font-medium">{quickStats.familySize}</dd>
                  </div>
                </>
              )}
            </dl>
          </div>
        </div>

        <div className="md:col-span-2 space-y-3 rounded-lg border bg-muted/10 p-4 overflow-hidden min-w-0">
          <h3 className="text-sm font-semibold">Entity details</h3>
          {selectedNode ? (
            <div className="space-y-2 text-sm min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-base font-semibold truncate">
                  {selectedNode.name ?? 'Untitled Entity'}
                </span>
                <Badge
                  variant="outline"
                  style={{ borderColor: getTypeColor(selectedNode.entity_type) }}
                  className="flex-shrink-0"
                >
                  {selectedNode.entity_type}
                </Badge>
              </div>
              {selectedNode.description && (
                <p className="text-muted-foreground break-words">{selectedNode.description}</p>
              )}
              {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
                <div className="space-y-1 min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Properties
                  </p>
                  <ul className="space-y-1">
                    {Object.entries(selectedNode.properties)
                      .slice(0, 8)
                      .map(([key, value]) => (
                        <li key={key} className="flex gap-2 text-xs min-w-0">
                          <span className="min-w-[80px] md:min-w-[96px] text-muted-foreground flex-shrink-0">
                            {key}
                          </span>
                          <span className="truncate min-w-0">{String(value)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {relatedLinks.length > 0 && (
                <div className="space-y-1 min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Connected Entities
                  </p>
                  <ul className="space-y-1">
                    {relatedLinks.slice(0, 8).map((link) => {
                      const sourceId = resolveEndpointId(link.source);
                      const targetId = resolveEndpointId(link.target);
                      const otherId = sourceId === selectedNode.id ? targetId : sourceId;
                      const targetNode = rawNodes.find((node) => node.id === otherId);

                      return (
                        <li key={link.id} className="flex items-center justify-between gap-2 text-xs min-w-0">
                          <span className="truncate min-w-0">
                            {targetNode?.name ?? targetNode?.entity_type ?? 'Unknown'}
                          </span>
                          <Badge variant="secondary" className="flex-shrink-0">
                            {link.relationship_type}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Select a node to view entity details.</p>
          )}
        </div>
      </div>
    </div>
  );
}
