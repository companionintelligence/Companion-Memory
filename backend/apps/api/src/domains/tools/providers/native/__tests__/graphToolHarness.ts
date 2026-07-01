/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Deterministic in-memory test harness for the agent's graph/memory tools.
 *
 * The graph tools (ReadKnowledgeTool, GetUserPreferencesTool,
 * GetEntertainmentPreferencesTool, GetFamilyMembersTool, …) layer on top of
 * GraphReadService → GraphQueryService → GraphUtilityService, plus a raw
 * DataSource for the user→entity lookup in ReadKnowledgeTool. There is no real
 * Postgres here: instead {@link InMemoryGraph} reimplements the small slice of
 * GraphUtilityService that the tools touch (getNodeById, getNodesByIds,
 * queryNodes, getRelationships, traverseGraph) over plain JS maps, and a fake
 * DataSource answers the `SELECT entity_id FROM ci.users …` queries.
 *
 * The REAL GraphQueryService and GraphReadService run on top of the fake, so
 * the traversal / preference / family read logic under test is exercised for
 * real — only the database layer is substituted. Tools are registered through a
 * real NativeToolProvider + ToolRegistry so cases can drive them exactly the
 * way production does: `registry.executeTool(name, { userId }, input)`.
 */
import type { RequestContext } from '@ci/common/context';
import { GraphNodeEntity, GraphQueryService, GraphReadService, RelationshipEntity } from '@ci/domains/memory';

import type { BaseTool } from '../../../core/BaseTool';
import { ToolRegistry } from '../../../registry/ToolRegistry';
import { GetEntertainmentPreferencesTool } from '../GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from '../GetFamilyMembersTool';
import { GetUserPreferencesTool } from '../GetUserPreferencesTool';
import { NativeToolProvider } from '../NativeToolProvider';
import { ReadKnowledgeTool } from '../ReadKnowledgeTool';

/** A no-op logger that satisfies the LoggerService surface the tools use. */
export function makeFakeLogger(): any {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

export interface SeedNode {
  entityId: string;
  entityType: string;
  name?: string | null;
  description?: string | null;
  properties?: Record<string, unknown>;
  linkedTable?: string | null;
  linkedId?: string | null;
  isActive?: boolean;
}

export interface SeedRelationship {
  relationshipId?: string;
  from: string;
  to: string;
  type: string;
  strength?: number;
  properties?: Record<string, unknown>;
  bidirectional?: boolean;
  isActive?: boolean;
}

let relCounter = 0;

function buildNode(ownerUserId: string, seed: SeedNode): GraphNodeEntity {
  const node = new GraphNodeEntity();
  node.entity_id = seed.entityId;
  node.entity_type = seed.entityType;
  node.outgoing_relationships = [];
  node.name = seed.name ?? null;
  node.description = seed.description ?? null;
  node.properties = seed.properties ?? {};
  node.dossier = null;
  node.search_content = null;
  node.linked_table = seed.linkedTable ?? null;
  node.linked_id = seed.linkedId ?? null;
  node.owner_user_id = ownerUserId;
  node.is_active = seed.isActive ?? true;
  node.is_archived = false;
  node.created_at = new Date('2026-01-01T00:00:00.000Z');
  node.updated_at = new Date('2026-01-01T00:00:00.000Z');
  node.last_accessed = new Date('2026-01-01T00:00:00.000Z');

  return node;
}

function buildRelationship(ownerUserId: string, seed: SeedRelationship): RelationshipEntity {
  const rel = new RelationshipEntity();
  rel.relationship_id = seed.relationshipId ?? `rel-${++relCounter}`;
  rel.from_entity_id = seed.from;
  rel.to_entity_id = seed.to;
  rel.relationship_type = seed.type;
  rel.strength = seed.strength ?? 1.0;
  rel.properties = seed.properties ?? {};
  rel.is_bidirectional = seed.bidirectional ?? false;
  rel.is_active = seed.isActive ?? true;
  rel.start_date = null;
  rel.end_date = null;
  rel.owner_user_id = ownerUserId;
  rel.created_at = new Date('2026-01-01T00:00:00.000Z');
  rel.updated_at = new Date('2026-01-01T00:00:00.000Z');

  return rel;
}

/**
 * In-memory reimplementation of the GraphUtilityService surface used by the
 * graph tools. Owner-scoped and is_active-aware, mirroring the real SQL
 * predicates so the tools behave the same way they would against Postgres.
 */
export class InMemoryGraph {
  private readonly nodes: GraphNodeEntity[] = [];

  private readonly relationships: RelationshipEntity[] = [];

  addNode(ownerUserId: string, seed: SeedNode): GraphNodeEntity {
    const node = buildNode(ownerUserId, seed);
    // Upsert by (owner, entity_id) so re-seeding a node (e.g. enriching its
    // properties) mirrors the real primary-key behaviour instead of producing
    // duplicate rows.
    const existingIndex = this.nodes.findIndex(
      (n) => n.owner_user_id === ownerUserId && n.entity_id === node.entity_id,
    );
    if (existingIndex >= 0) {
      this.nodes[existingIndex] = node;
    } else {
      this.nodes.push(node);
    }

    return node;
  }

  addRelationship(ownerUserId: string, seed: SeedRelationship): RelationshipEntity {
    const rel = buildRelationship(ownerUserId, seed);
    this.relationships.push(rel);

    return rel;
  }

  private activeNodes(ownerUserId: string): GraphNodeEntity[] {
    return this.nodes.filter((n) => n.owner_user_id === ownerUserId && n.is_active);
  }

  private activeRelationships(ownerUserId: string): RelationshipEntity[] {
    return this.relationships.filter((r) => r.owner_user_id === ownerUserId && r.is_active);
  }

  async getNodeById(entityId: string, ownerUserId: string): Promise<GraphNodeEntity | null> {
    return this.activeNodes(ownerUserId).find((n) => n.entity_id === entityId) ?? null;
  }

  async getNodesByIds(entityIds: string[], ownerUserId: string): Promise<GraphNodeEntity[]> {
    if (entityIds.length === 0) {
      return [];
    }

    const set = new Set(entityIds);

    return this.activeNodes(ownerUserId).filter((n) => set.has(n.entity_id));
  }

  async getNodeByLinkedRecord(
    ownerUserId: string,
    linkedTable: string,
    linkedId: string,
  ): Promise<GraphNodeEntity | null> {
    return (
      this.activeNodes(ownerUserId).find((n) => n.linked_table === linkedTable && n.linked_id === linkedId) ??
      null
    );
  }

  async queryNodes(
    ownerUserId: string,
    filters: {
      entityType?: string;
      excludeEntityTypes?: string[];
      nameContains?: string;
      propertyEquals?: Record<string, string | number | boolean>;
    } = {},
    options: { limit?: number; offset?: number } = {},
  ): Promise<GraphNodeEntity[]> {
    const limit = Math.min(options.limit ?? 25, 200);
    const offset = options.offset ?? 0;

    let result = this.activeNodes(ownerUserId);

    if (filters.entityType) {
      result = result.filter((n) => n.entity_type === filters.entityType);
    }

    if (filters.excludeEntityTypes && filters.excludeEntityTypes.length > 0) {
      const exclude = new Set(filters.excludeEntityTypes);
      result = result.filter((n) => !exclude.has(n.entity_type));
    }

    if (filters.nameContains) {
      const needle = filters.nameContains.toLowerCase();
      result = result.filter((n) => (n.name ?? '').toLowerCase().includes(needle));
    }

    if (filters.propertyEquals) {
      result = result.filter((n) =>
        Object.entries(filters.propertyEquals as Record<string, unknown>).every(
          ([key, value]) => String(n.properties?.[key]) === String(value),
        ),
      );
    }

    // Mirror the deterministic SQL ordering: created_at DESC, entity_id ASC.
    result = [...result].sort((a, b) => {
      const byDate = b.created_at.getTime() - a.created_at.getTime();
      if (byDate !== 0) {
        return byDate;
      }

      return a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0;
    });

    return result.slice(offset, offset + limit);
  }

  async getRelationships(
    ownerUserId: string,
    options: {
      entityIds?: string[];
      relationshipIds?: string[];
      relationshipTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      includeInactive?: boolean;
    } = {},
  ): Promise<RelationshipEntity[]> {
    let result = options.includeInactive
      ? this.relationships.filter((r) => r.owner_user_id === ownerUserId)
      : this.activeRelationships(ownerUserId);

    if (options.relationshipIds?.length) {
      const ids = new Set(options.relationshipIds);
      result = result.filter((r) => ids.has(r.relationship_id));
    }

    if (options.relationshipTypes?.length) {
      const types = new Set(options.relationshipTypes);
      result = result.filter((r) => types.has(r.relationship_type));
    }

    if (options.entityIds?.length) {
      const ids = new Set(options.entityIds);
      const direction = options.direction ?? 'both';
      result = result.filter((r) => {
        if (direction === 'outbound') {
          return ids.has(r.from_entity_id);
        }

        if (direction === 'inbound') {
          return ids.has(r.to_entity_id);
        }

        return ids.has(r.from_entity_id) || ids.has(r.to_entity_id);
      });
    }

    return result;
  }

  /** Faithful port of GraphUtilityService.traverseGraph (BFS over layers). */
  async traverseGraph(
    ownerUserId: string,
    seedEntityIds: string[],
    options: {
      relationshipTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      maxDepth?: number;
      maxNodes?: number;
      maxEdges?: number;
    } = {},
  ): Promise<{ nodes: Map<string, GraphNodeEntity>; edges: RelationshipEntity[] }> {
    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 25, 250));
    const maxEdges = Math.max(0, Math.min(options.maxEdges ?? 50, 500));
    const direction = options.direction ?? 'both';

    const visitedNodes = new Map<string, GraphNodeEntity>();
    const collectedEdges: RelationshipEntity[] = [];

    let currentLayer = new Set(seedEntityIds);
    let depth = 0;

    while (currentLayer.size > 0 && depth <= maxDepth && visitedNodes.size < maxNodes) {
      const layerIds = Array.from(currentLayer).filter((id) => !visitedNodes.has(id));
      if (layerIds.length === 0) {
        break;
      }

      const nodes = await this.getNodesByIds(layerIds, ownerUserId);
      nodes.forEach((node) => {
        if (!visitedNodes.has(node.entity_id) && visitedNodes.size < maxNodes) {
          visitedNodes.set(node.entity_id, node);
        }
      });

      if (depth === maxDepth || visitedNodes.size >= maxNodes || collectedEdges.length >= maxEdges) {
        break;
      }

      const relationships = await this.getRelationships(ownerUserId, {
        entityIds: layerIds,
        relationshipTypes: options.relationshipTypes,
        direction,
      });

      const nextLayer = new Set<string>();
      for (const rel of relationships) {
        if (collectedEdges.length >= maxEdges) {
          break;
        }

        collectedEdges.push(rel);

        if (direction === 'outbound' || direction === 'both') {
          if (layerIds.includes(rel.from_entity_id) && !visitedNodes.has(rel.to_entity_id)) {
            nextLayer.add(rel.to_entity_id);
          }
        }

        if (direction === 'inbound' || direction === 'both') {
          if (layerIds.includes(rel.to_entity_id) && !visitedNodes.has(rel.from_entity_id)) {
            nextLayer.add(rel.from_entity_id);
          }
        }
      }

      currentLayer = nextLayer;
      depth += 1;
    }

    return { nodes: visitedNodes, edges: collectedEdges.slice(0, maxEdges) };
  }
}

/**
 * Fake UserService backing GraphQueryService.getUserEntity. `findById` returns
 * `{ entityId }` so getUserEntity resolves to the linked graph node, or `null`
 * to simulate "user has no linked graph entity".
 */
export class FakeUserService {
  private readonly users = new Map<string, { id: string; entityId: string | null } | null>();

  setUser(userId: string, entityId: string | null): void {
    this.users.set(userId, { id: userId, entityId });
  }

  setMissing(userId: string): void {
    this.users.set(userId, null);
  }

  async findById(_context: unknown, id: string): Promise<{ id: string; entityId: string | null } | null> {
    return this.users.get(id) ?? null;
  }
}

/**
 * Fake DataSource for ReadKnowledgeTool, which resolves the current user's
 * entity via raw SQL against ci.users / ci.entities. We pattern-match on the
 * query text and answer from the same user/entity maps the rest of the harness
 * uses, so ReadKnowledge and the GraphQueryService-backed tools agree.
 */
export class FakeDataSource {
  constructor(
    private readonly userService: FakeUserService,
    private readonly graph: InMemoryGraph,
  ) {}

  async query(sql: string, params: any[]): Promise<any[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.includes('FROM ci.users')) {
      const user = await this.userService.findById(null, params[0]);
      if (user?.entityId) {
        return [{ entity_id: user.entityId }];
      }

      return [];
    }

    if (normalized.includes('FROM ci.entities')) {
      // linked_table = 'users' AND linked_id = $1 AND owner_user_id = $2
      const node = await this.graph.getNodeByLinkedRecord(params[1], 'users', params[0]);
      if (node) {
        return [{ entity_id: node.entity_id }];
      }

      return [];
    }

    return [];
  }
}

export interface GraphToolHarness {
  graph: InMemoryGraph;
  userService: FakeUserService;
  registry: ToolRegistry;
  graphQuery: GraphQueryService;
  graphRead: GraphReadService;
  /** Convenience: run a tool through the registry as production does. */
  run: (name: string, context: RequestContext, input: unknown) => ReturnType<ToolRegistry['executeTool']>;
}

/**
 * Wires the real GraphQueryService + GraphReadService onto an InMemoryGraph,
 * builds the graph tools, and registers them in a real ToolRegistry via a real
 * NativeToolProvider. Returns helpers so a test can seed data and drive tools.
 */
export async function createGraphToolHarness(): Promise<GraphToolHarness> {
  const graph = new InMemoryGraph();
  const userService = new FakeUserService();

  // Real GraphQueryService on top of the fake utility + fake user service.
  const graphQuery = new GraphQueryService(userService as any, graph as any);
  const graphRead = new GraphReadService(graphQuery);
  const dataSource = new FakeDataSource(userService, graph);

  const tools: BaseTool[] = [
    new ReadKnowledgeTool(graphQuery, dataSource as any, makeFakeLogger()),
    new GetUserPreferencesTool(graphQuery, graphRead, makeFakeLogger()),
    new GetEntertainmentPreferencesTool(graphQuery, graphRead, makeFakeLogger()),
    new GetFamilyMembersTool(graphQuery, graphRead, makeFakeLogger()),
  ];

  const registry = new ToolRegistry(makeFakeLogger());
  const provider = new NativeToolProvider(tools, makeFakeLogger(), registry);
  await registry.registerProvider(provider);

  return {
    graph,
    userService,
    registry,
    graphQuery,
    graphRead,
    run: (name, context, input) => registry.executeTool(name, context, input),
  };
}

/** Stable UUIDs for a deterministic fixture. */
export const IDS = {
  user: '00000000-0000-0000-0000-0000000000aa',
  self: '11111111-1111-1111-1111-111111111111',
  alice: '22222222-2222-2222-2222-222222222222',
  bob: '33333333-3333-3333-3333-333333333333',
  acme: '44444444-4444-4444-4444-444444444444',
  italian: '55555555-5555-5555-5555-555555555555',
  scifi: '66666666-6666-6666-6666-666666666666',
} as const;

/**
 * Seeds a tiny graph that mirrors what the IMPORTER actually writes:
 * a `self` Person anchored to the user, 2 contacts via KNOWS, an Organization
 * via MENTIONS, and a couple of Concepts (with NO preference/family edges and
 * NO `properties.type` of cuisine/movie_genre). This is the "imported
 * vocabulary" baseline the preference/family tools must degrade gracefully on.
 */
export function seedImporterGraph(harness: GraphToolHarness): void {
  const { graph, userService } = harness;
  const owner = IDS.user;

  userService.setUser(owner, IDS.self);

  graph.addNode(owner, {
    entityId: IDS.self,
    entityType: 'Person',
    name: 'Me',
    linkedTable: 'users',
    linkedId: owner,
    properties: { importerType: 'self' },
  });
  graph.addNode(owner, {
    entityId: IDS.alice,
    entityType: 'Person',
    name: 'Alice Example',
    properties: { importerType: 'contact', emails: ['alice@example.com'] },
  });
  graph.addNode(owner, {
    entityId: IDS.bob,
    entityType: 'Person',
    name: 'Bob Example',
    properties: { importerType: 'contact', phones: ['5551234567'] },
  });
  graph.addNode(owner, {
    entityId: IDS.acme,
    entityType: 'Organization',
    name: 'Acme Corp',
    properties: { importerType: 'organization' },
  });
  // Concepts the importer might create — but WITHOUT a `type` property and
  // WITHOUT PREFERS/DISLIKES edges, so preference tools should see nothing.
  graph.addNode(owner, {
    entityId: IDS.italian,
    entityType: 'Concept',
    name: 'Italian',
  });
  graph.addNode(owner, {
    entityId: IDS.scifi,
    entityType: 'Concept',
    name: 'Science Fiction',
  });

  // Importer vocabulary only: KNOWS (people) and MENTIONS (everything else).
  graph.addRelationship(owner, { from: IDS.self, to: IDS.alice, type: 'KNOWS', strength: 0.8 });
  graph.addRelationship(owner, { from: IDS.self, to: IDS.bob, type: 'KNOWS', strength: 0.6 });
  graph.addRelationship(owner, { from: IDS.self, to: IDS.acme, type: 'MENTIONS', strength: 0.4 });
}

/**
 * Adds the "richer" vocabulary the LLM-extraction step is expected to produce:
 * PREFERS/DISLIKES edges to typed Concepts and a SPOUSE family edge. Used by
 * the correctness cases to prove the tools light up once the gap is closed.
 */
export function seedEnrichedGraph(harness: GraphToolHarness): void {
  const { graph } = harness;
  const owner = IDS.user;

  // Type the concepts so the preference tools can categorize them.
  graph.addNode(owner, {
    entityId: IDS.italian,
    entityType: 'Concept',
    name: 'Italian',
    properties: { type: 'cuisine' },
  });
  graph.addNode(owner, {
    entityId: IDS.scifi,
    entityType: 'Concept',
    name: 'Science Fiction',
    properties: { type: 'movie_genre' },
  });

  graph.addNode(owner, {
    entityId: IDS.self,
    entityType: 'Person',
    name: 'Me',
    linkedTable: 'users',
    linkedId: owner,
  });
  graph.addNode(owner, {
    entityId: IDS.alice,
    entityType: 'Person',
    name: 'Alice Example',
  });

  graph.addRelationship(owner, {
    from: IDS.self,
    to: IDS.italian,
    type: 'PREFERS',
    strength: 0.9,
  });
  graph.addRelationship(owner, {
    from: IDS.self,
    to: IDS.scifi,
    type: 'PREFERS',
    strength: 0.85,
  });
  graph.addRelationship(owner, {
    from: IDS.self,
    to: IDS.alice,
    type: 'SPOUSE',
    strength: 1.0,
    bidirectional: true,
  });
}
