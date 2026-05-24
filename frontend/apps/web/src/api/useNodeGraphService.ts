import { useEffect, useState, useRef, useCallback } from 'react';

import { useAuth } from '@/hooks';

export interface NodeDetailsResponse {
  node: {
    entityId: string;
    entityType: string;
    name: string | null;
    description: string | null;
    properties: Record<string, unknown>;
  };
  relationships: Array<{
    relationshipId: string;
    relationshipType: string;
    direction: 'inbound' | 'outbound';
    properties: Record<string, unknown>;
    strength?: number;
    otherEntity: {
      entityId: string;
      entityType: string;
      name: string | null;
      description: string | null;
      properties: Record<string, unknown>;
    };
  }>;
}

export interface GraphNode {
  id: string;
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
}

export interface GraphLink {
  id: string;
  relationship_id: string;
  source: string;
  target: string;
  relationship_type: string;
  strength: number;
  properties: Record<string, unknown>;
}

export interface Subgraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface GraphDataResponse {
  success: boolean;
  data?: Subgraph;
}

function buildNeighborhoodGraph(details: NodeDetailsResponse, nodeLimit: number): Subgraph {
  const centerNode: GraphNode = {
    id: details.node.entityId,
    entity_id: details.node.entityId,
    entity_type: details.node.entityType,
    name: details.node.name,
    description: details.node.description,
    properties: details.node.properties ?? {},
  };

  const nodes: GraphNode[] = [centerNode];
  const links: GraphLink[] = [];

  const neighborSlots = Math.max(0, nodeLimit - 1);

  if (neighborSlots > 0) {
    const included = new Set<string>();

    for (const rel of details.relationships) {
      const other = rel.otherEntity;
      if (!other) {
        continue;
      }

      if (included.has(other.entityId)) {
        continue;
      }

      included.add(other.entityId);

      nodes.push({
        id: other.entityId,
        entity_id: other.entityId,
        entity_type: other.entityType,
        name: other.name,
        description: other.description,
        properties: other.properties ?? {},
      });

      const source = rel.direction === 'outbound' ? details.node.entityId : other.entityId;
      const target = rel.direction === 'outbound' ? other.entityId : details.node.entityId;

      links.push({
        id: rel.relationshipId,
        relationship_id: rel.relationshipId,
        source,
        target,
        relationship_type: rel.relationshipType,
        strength: rel.strength ?? 0.5,
        properties: rel.properties ?? {},
      });

      if (included.size >= neighborSlots) {
        break;
      }
    }
  }

  return { nodes, links };
}

function buildSubgraphFromGraphData(
  data: Subgraph,
  seedId: string,
  maxDepth: number,
  maxNodes: number,
  maxEdges: number,
): Subgraph {
  const visited = new Set<string>([seedId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];
  const adjacency = new Map<string, GraphLink[]>();
  const includedLinkIds = new Set<string>();

  for (const link of data.links) {
    adjacency.set(link.source, [...(adjacency.get(link.source) ?? []), link]);
    adjacency.set(link.target, [...(adjacency.get(link.target) ?? []), link]);
  }

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    for (const link of adjacency.get(current.id) ?? []) {
      const neighborId = link.source === current.id ? link.target : link.source;
      if (!visited.has(neighborId) && current.depth + 1 <= maxDepth && visited.size < maxNodes) {
        visited.add(neighborId);
        queue.push({ id: neighborId, depth: current.depth + 1 });
      }

      if (visited.has(neighborId) && includedLinkIds.size < maxEdges) {
        includedLinkIds.add(link.id);
      }
    }
  }

  const nodes = data.nodes.filter((node) => visited.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = data.links
    .filter((link) => includedLinkIds.has(link.id) && nodeIds.has(link.source) && nodeIds.has(link.target))
    .slice(0, maxEdges);

  return { nodes, links };
}

interface Props {
  entityId?: string;
  nodeLimit?: number;
  maxDepth?: number;
  skip?: boolean;
}

interface NodeDetailsApiResponse extends NodeDetailsResponse {
  subgraph?: Subgraph;
}

export function useNodeGraphService({ entityId, nodeLimit = 25, maxDepth = 1, skip = false }: Props) {
  const [{ authToken }] = useAuth();

  const tokenRef = useRef(authToken);

  const [data, setData] = useState<Subgraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    tokenRef.current = authToken;
  }, [authToken]);

  const fetchNodeGraph = useCallback(async (id: string, limit: number, depth: number) => {
    setLoading(true);
    setError(null);

    try {
      const requestedMaxNodes = Math.min(250, Math.max(50, limit * depth));
      const requestedMaxEdges = Math.min(500, Math.max(150, requestedMaxNodes * 3));
      const displayMaxEdges = Math.min(500, Math.max(100, limit * 4));
      const params = new URLSearchParams({
        entityId: id,
        maxDepth: String(depth),
        maxNodes: String(requestedMaxNodes),
        maxEdges: String(requestedMaxEdges),
      });

      const response = await fetch(`/api/graph/node?${params.toString()}`, {
        headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : undefined,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch node graph: ${response.statusText}`);
      }

      const rawData: NodeDetailsApiResponse = await response.json();
      if (rawData.subgraph?.nodes != null && rawData.subgraph?.links != null) {
        const boundedSubgraph = buildSubgraphFromGraphData(
          rawData.subgraph,
          rawData.node?.entityId ?? id,
          depth,
          limit,
          displayMaxEdges,
        );
        setData(boundedSubgraph);

        return;
      }

      if (depth > 1) {
        try {
          const fallbackResponse = await fetch('/api/graph/data', {
            headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : undefined,
          });

          if (fallbackResponse.ok) {
            const fallbackData: GraphDataResponse = await fallbackResponse.json();
            if (fallbackData.success && fallbackData.data) {
              const seedId = rawData.node?.entityId ?? id;
              const fallbackSubgraph = buildSubgraphFromGraphData(
                fallbackData.data,
                seedId,
                depth,
                limit,
                displayMaxEdges,
              );

              if (fallbackSubgraph.nodes.length > 0) {
                setData(fallbackSubgraph);

                return;
              }
            }
          }
        } catch {
          // Fall back to the 1-hop neighborhood shape below if graph data request fails.
        }
      }

      const graphData = buildNeighborhoodGraph(rawData, limit);

      setData(graphData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error occurred'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (skip || !entityId) {
      return;
    }

    fetchNodeGraph(entityId, nodeLimit, maxDepth);
  }, [entityId, nodeLimit, maxDepth, skip, fetchNodeGraph]);

  return {
    data,
    loading,
    error,
    refresh: () => entityId && fetchNodeGraph(entityId, nodeLimit, maxDepth),
  };
}
