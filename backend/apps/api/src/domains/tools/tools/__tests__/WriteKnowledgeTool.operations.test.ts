import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// entityId/relationshipId/fromEntityId/toEntityId are all `z.string().uuid()` in
// WriteKnowledgeInputSchema, so fixtures need real UUIDs or validateInput rejects the
// whole call before executeInternal ever runs.
const E1 = '11111111-1111-1111-1111-111111111111';
const E2 = '22222222-2222-2222-2222-222222222222';
const E_MISSING = '99999999-9999-9999-9999-999999999999';
const R1 = '33333333-3333-3333-3333-333333333333';
const R_MISSING = '44444444-4444-4444-4444-444444444444';
const FROM = '55555555-5555-5555-5555-555555555555';
const TO = '66666666-6666-6666-6666-666666666666';
const E_FORGOTTEN = '77777777-7777-7777-7777-777777777777';
const R_FORGOTTEN = '88888888-8888-8888-8888-888888888888';

// `is_active` is required on both, mirroring the NOT NULL DEFAULT true columns
// on ci.entities/ci.relationships. An optional flag let fixtures produce rows
// with is_active === undefined — a shape no row read back from Postgres can
// have, and the one under which a resurrection guard silently reads as "this
// is already forgotten".
interface FakeNode {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  search_content: string | null;
  linked_table: string | null;
  linked_id: string | null;
  is_active: boolean;
}

interface FakeRelationship {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  properties: Record<string, unknown>;
  strength: number;
  is_bidirectional: boolean;
  is_active: boolean;
}

function node(overrides: Partial<FakeNode> & { entity_id: string; entity_type: string }): FakeNode {
  return {
    name: null,
    description: null,
    properties: {},
    search_content: null,
    linked_table: null,
    linked_id: null,
    is_active: true,
    ...overrides,
  };
}

/**
 * Builds jest-mock graphEvents/graphQuery doubles backed by plain maps, mirroring the
 * conventions in WriteKnowledgeTool.coerce.test.ts but seeded with pre-existing
 * nodes/relationships so entity.update / relationship.update paths (which look up an
 * existing row before writing) have something to find.
 */
function makeGraph(seedNodes: FakeNode[] = [], seedRelationships: FakeRelationship[] = []) {
  const nodes = new Map(seedNodes.map((n) => [n.entity_id, n]));
  const relationships = new Map(seedRelationships.map((r) => [r.relationship_id, r]));
  let nextId = 1;

  const upsertNode = jest.fn(
    async (
      _owner: string,
      input: {
        entityId?: string;
        entityType: string;
        name?: string | null;
        properties?: Record<string, unknown>;
      },
    ) => {
      const entityId = input.entityId ?? `new-${nextId++}`;
      nodes.set(
        entityId,
        node({
          ...nodes.get(entityId),
          entity_id: entityId,
          entity_type: input.entityType,
          name: input.name ?? null,
          properties: input.properties ?? {},
          // GraphUtilityService.createOrUpdateNode sets is_active = true on
          // BOTH branches, so an id-reuse write revives a forgotten row. A
          // double that left the flag alone could not show the resurrection
          // the guards under test exist to stop.
          is_active: true,
        }),
      );

      return { entityId };
    },
  );

  const upsertRelationship = jest.fn(
    async (
      _owner: string,
      input: {
        relationshipId?: string;
        fromEntityId: string;
        toEntityId: string;
        relationshipType: string;
        properties?: Record<string, unknown>;
        strength?: number;
        isBidirectional?: boolean;
      },
    ) => {
      const relationshipId = input.relationshipId ?? `rel-${nextId++}`;
      relationships.set(relationshipId, {
        relationship_id: relationshipId,
        from_entity_id: input.fromEntityId,
        to_entity_id: input.toEntityId,
        relationship_type: input.relationshipType,
        properties: input.properties ?? {},
        strength: input.strength ?? 1,
        is_bidirectional: input.isBidirectional ?? false,
        // See upsertNode above: createOrUpdateRelationship ends both branches
        // with is_active = true.
        is_active: true,
      });

      return { relationshipId };
    },
  );

  const graphEvents = { upsertNode, upsertRelationship };

  const graphQuery = {
    getNode: jest.fn(async (_owner: string, id: string, options: { includeInactive?: boolean } = {}) => {
      const found = nodes.get(id) ?? null;
      if (found && !found.is_active && !options.includeInactive) {
        return null;
      }

      return found;
    }),
    getNodes: jest.fn(async () => [] as FakeNode[]),
    getNodesByIds: jest.fn(async (_owner: string, ids: string[]) =>
      ids.map((id) => nodes.get(id)).filter((n): n is FakeNode => Boolean(n)),
    ),
    searchNodesByPrefix: jest.fn(async () => [] as FakeNode[]),
    getRelationships: jest.fn(
      async (_owner: string, options: { relationshipIds?: string[]; includeInactive?: boolean }) =>
        (options.relationshipIds ?? [])
          .map((id) => relationships.get(id))
          .filter((r): r is FakeRelationship => Boolean(r))
          .filter((r) => options.includeInactive || r.is_active),
    ),
  };

  return { nodes, relationships, graphEvents, graphQuery };
}

function makeTool(graph: ReturnType<typeof makeGraph>) {
  return new WriteKnowledgeTool(graph.graphEvents as never, graph.graphQuery as never, makeLogger() as never);
}

const OWNER = { userId: 'user-1' };

describe('WriteKnowledgeTool entity.update', () => {
  it('merges incoming properties onto existing ones by default and fills in the rest from the existing row', async () => {
    const graph = makeGraph([
      node({
        entity_id: E1,
        entity_type: 'Concept',
        name: 'Yoga',
        description: 'A practice',
        properties: { category: 'fitness', level: 'beginner' },
      }),
    ]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        { kind: 'entity.update', entityId: E1, properties: { level: 'intermediate', pace: 'slow' } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });
    expect(graph.graphEvents.upsertNode).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        entityId: E1,
        entityType: 'Concept',
        name: 'Yoga',
        description: 'A practice',
        properties: { category: 'fitness', level: 'intermediate', pace: 'slow' },
      }),
    );
  });

  it('replaces properties wholesale when mergeProperties is false', async () => {
    const graph = makeGraph([
      node({ entity_id: E1, entity_type: 'Concept', name: 'Yoga', properties: { category: 'fitness' } }),
    ]);
    const tool = makeTool(graph);

    await tool.execute(OWNER, {
      operations: [
        {
          kind: 'entity.update',
          entityId: E1,
          mergeProperties: false,
          properties: { level: 'intermediate' },
        },
      ],
    });

    expect(graph.graphEvents.upsertNode).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ properties: { level: 'intermediate' } }),
    );
  });

  it('applies removeProperties after merging', async () => {
    const graph = makeGraph([
      node({
        entity_id: E1,
        entity_type: 'Concept',
        name: 'Yoga',
        properties: { category: 'fitness', stale: 'drop-me' },
      }),
    ]);
    const tool = makeTool(graph);

    await tool.execute(OWNER, {
      operations: [
        {
          kind: 'entity.update',
          entityId: E1,
          properties: { level: 'intermediate' },
          removeProperties: ['stale'],
        },
      ],
    });

    expect(graph.graphEvents.upsertNode).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ properties: { category: 'fitness', level: 'intermediate' } }),
    );
  });

  it('fails the operation without writing when the entity is not found or not owned by the user', async () => {
    const graph = makeGraph([]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [{ kind: 'entity.update', entityId: E1, properties: { level: 'x' } }],
    });

    expect(result.data).toMatchObject({ updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({ status: 'failed' });
    expect(graph.graphEvents.upsertNode).not.toHaveBeenCalled();
  });

  it('dry-run reports the update without persisting it', async () => {
    const graph = makeGraph([node({ entity_id: E1, entity_type: 'Concept', name: 'Yoga' })]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      dryRun: true,
      operations: [{ kind: 'entity.update', entityId: E1, properties: { level: 'x' } }],
    });

    expect(result.data).toMatchObject({ dryRun: true, updatedNodes: 1, failures: 0 });
    expect(result.data?.results[0].message).toContain('Dry run');
    expect(graph.graphEvents.upsertNode).not.toHaveBeenCalled();
  });
});

describe('WriteKnowledgeTool relationship.update', () => {
  it('fails when the relationship is not found or not owned by the user', async () => {
    const graph = makeGraph();
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [{ kind: 'relationship.update', relationshipId: R_MISSING, strength: 0.5 }],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({ status: 'failed' });
    expect(graph.graphEvents.upsertRelationship).not.toHaveBeenCalled();
  });

  it('keeps the existing endpoints and merges properties, falling back to existing type/strength when omitted', async () => {
    const graph = makeGraph(
      [],
      [
        {
          relationship_id: R1,
          from_entity_id: FROM,
          to_entity_id: TO,
          relationship_type: 'KNOWS',
          properties: { since: '2020' },
          strength: 0.6,
          is_bidirectional: false,
          is_active: true,
        },
      ],
    );
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [{ kind: 'relationship.update', relationshipId: R1, properties: { closeness: 'high' } }],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 1, failures: 0 });
    expect(graph.graphEvents.upsertRelationship).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        relationshipId: R1,
        fromEntityId: FROM,
        toEntityId: TO,
        relationshipType: 'KNOWS',
        properties: { since: '2020', closeness: 'high' },
        strength: 0.6,
        isBidirectional: false,
      }),
    );
  });

  it('dry-run reports the update without persisting it', async () => {
    const graph = makeGraph(
      [],
      [
        {
          relationship_id: R1,
          from_entity_id: FROM,
          to_entity_id: TO,
          relationship_type: 'KNOWS',
          properties: {},
          strength: 1,
          is_bidirectional: false,
          is_active: true,
        },
      ],
    );
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      dryRun: true,
      operations: [{ kind: 'relationship.update', relationshipId: R1, strength: 0.9 }],
    });

    expect(result.data).toMatchObject({ dryRun: true, updatedRelationships: 1, failures: 0 });
    expect(result.data?.results[0].message).toContain('Dry run');
    expect(graph.graphEvents.upsertRelationship).not.toHaveBeenCalled();
  });
});

describe('WriteKnowledgeTool per-operation failure aggregation', () => {
  it('keeps processing later operations in the batch after an earlier one fails', async () => {
    const graph = makeGraph([node({ entity_id: E1, entity_type: 'Concept', name: 'Yoga' })]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        { kind: 'entity.update', entityId: E_MISSING, properties: {} },
        { kind: 'entity.create', entityType: 'Concept', name: 'Pilates' },
      ],
    });

    expect(result.data).toMatchObject({ failures: 1, createdNodes: 1, updatedNodes: 0 });
    expect(result.data?.results.map((r) => r.status)).toEqual(['failed', 'created']);
  });

  it('fails relationship.create when an endpoint cannot be resolved by id or name', async () => {
    const graph = makeGraph([node({ entity_id: E1, entity_type: 'Person', name: 'Alex' })]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        { kind: 'relationship.create', fromEntityId: E1, relationshipType: 'KNOWS', to: { name: 'Nobody' } },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, failures: 1 });
    expect(graph.graphEvents.upsertRelationship).not.toHaveBeenCalled();
  });

  it('fails relationship.create when a resolved endpoint id is not actually owned by the user', async () => {
    // fromEntityId resolves via getNode, but getNodesByIds (the ownership re-check before
    // the write) comes back short — simulates a race/ownership mismatch between the two reads.
    const graph = makeGraph([
      node({ entity_id: E1, entity_type: 'Person', name: 'Alex' }),
      node({ entity_id: E2, entity_type: 'Person', name: 'Sam' }),
    ]);
    graph.graphQuery.getNodesByIds.mockResolvedValueOnce([graph.nodes.get(E1)!]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        { kind: 'relationship.create', fromEntityId: E1, toEntityId: E2, relationshipType: 'KNOWS' },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, failures: 1 });
    expect(result.data?.results[0].message).toContain('must exist and be owned');
  });
});

describe('WriteKnowledgeTool soft-delete resurrection guard', () => {
  it('fails entity.create instead of resurrecting a soft-deleted node by id reuse', async () => {
    const graph = makeGraph([
      node({ entity_id: E_FORGOTTEN, entity_type: 'Concept', name: 'Old fact', is_active: false }),
    ]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [{ kind: 'entity.create', entityId: E_FORGOTTEN, entityType: 'Concept', name: 'New fact' }],
    });

    expect(result.data).toMatchObject({ createdNodes: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({ status: 'failed' });
    expect(result.data?.results[0].message).toContain('forgotten');
    expect(graph.graphEvents.upsertNode).not.toHaveBeenCalled();
  });

  it('still allows entity.create with a fresh id that has never existed', async () => {
    const graph = makeGraph();
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [{ kind: 'entity.create', entityType: 'Concept', name: 'Pilates' }],
    });

    expect(result.data).toMatchObject({ createdNodes: 1, failures: 0 });
    expect(graph.graphEvents.upsertNode).toHaveBeenCalledTimes(1);
  });

  it('fails relationship.create instead of resurrecting a soft-deleted relationship by id reuse', async () => {
    const graph = makeGraph(
      [
        node({ entity_id: FROM, entity_type: 'Person', name: 'Alex' }),
        node({ entity_id: TO, entity_type: 'Person', name: 'Sam' }),
      ],
      [
        {
          relationship_id: R_FORGOTTEN,
          from_entity_id: FROM,
          to_entity_id: TO,
          relationship_type: 'KNOWS',
          properties: {},
          strength: 1,
          is_bidirectional: false,
          is_active: false,
        },
      ],
    );
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: R_FORGOTTEN,
          fromEntityId: FROM,
          toEntityId: TO,
          relationshipType: 'KNOWS',
        },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({ status: 'failed' });
    expect(result.data?.results[0].message).toContain('forgotten');
    expect(graph.graphEvents.upsertRelationship).not.toHaveBeenCalled();
  });

  it('fails relationship.update instead of reactivating a soft-deleted relationship', async () => {
    // relationship.update reads with includeInactive: true (it needs the row to
    // merge properties onto), so a forgotten relationship IS found here and,
    // unguarded, walks straight into the same reactivating upsert that
    // relationship.create is stopped from reaching.
    const graph = makeGraph(
      [],
      [
        {
          relationship_id: R_FORGOTTEN,
          from_entity_id: FROM,
          to_entity_id: TO,
          relationship_type: 'KNOWS',
          properties: {},
          strength: 1,
          is_bidirectional: false,
          is_active: false,
        },
      ],
    );
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [{ kind: 'relationship.update', relationshipId: R_FORGOTTEN, strength: 0.5 }],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({ status: 'failed' });
    expect(result.data?.results[0].message).toContain('forgotten');
    expect(graph.graphEvents.upsertRelationship).not.toHaveBeenCalled();
    expect(graph.relationships.get(R_FORGOTTEN)?.is_active).toBe(false);
  });
});

describe('WriteKnowledgeTool.resolveNamedRef fuzzy matching', () => {
  it('resolves a single contains-hit even when it is not an exact name match', async () => {
    const graph = makeGraph([node({ entity_id: E1, entity_type: 'Person', name: 'Alex' })]);
    graph.graphQuery.getNodes.mockResolvedValueOnce([graph.nodes.get(E1)!]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        {
          kind: 'relationship.create',
          fromEntityId: E1,
          relationshipType: 'KNOWS',
          to: { name: 'Ale' },
        },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 1, failures: 0 });
    expect(graph.graphEvents.upsertRelationship).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ toEntityId: E1 }),
    );
    expect(graph.graphQuery.searchNodesByPrefix).not.toHaveBeenCalled();
  });

  it('falls back to prefix search and prefers the type-filtered exact match when contains search is ambiguous', async () => {
    // E1/E2 are the real, owned nodes the endpoint-ownership recheck must find; their names here
    // are irrelevant to that check, only to which one resolveNamedRef picks for "Alex".
    const graph = makeGraph([
      node({ entity_id: E1, entity_type: 'Person', name: 'irrelevant-1' }),
      node({ entity_id: E2, entity_type: 'Organization', name: 'irrelevant-2' }),
    ]);
    // Ambiguous: two contains hits, neither an exact case-insensitive match for "Alex" —
    // "Alexander" and "Alex Consulting" both contain the substring but neither equals it.
    graph.graphQuery.getNodes.mockResolvedValueOnce([
      { ...node({ entity_id: 'contains-1', entity_type: 'Organization', name: 'Alex Consulting' }) },
      { ...node({ entity_id: 'contains-2', entity_type: 'Person', name: 'Alexander' }) },
    ]);
    // Prefix search resolves the ambiguity: after filtering to the requested type (Person),
    // exactly one hit is an exact case-insensitive name match — that's the one that should win.
    graph.graphQuery.searchNodesByPrefix.mockResolvedValueOnce([
      { ...node({ entity_id: 'prefix-org', entity_type: 'Organization', name: 'Alex Corp' }) },
      { ...node({ entity_id: E1, entity_type: 'Person', name: 'Alex' }) },
    ]);
    const tool = makeTool(graph);

    const result = await tool.execute(OWNER, {
      operations: [
        {
          kind: 'relationship.create',
          toEntityId: E2,
          relationshipType: 'EMPLOYS',
          from: { name: 'Alex', entityType: 'Person' },
        },
      ],
    });

    expect(graph.graphQuery.searchNodesByPrefix).toHaveBeenCalled();
    expect(result.data).toMatchObject({ createdRelationships: 1, failures: 0 });
    expect(graph.graphEvents.upsertRelationship).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ fromEntityId: E1 }),
    );
  });
});
