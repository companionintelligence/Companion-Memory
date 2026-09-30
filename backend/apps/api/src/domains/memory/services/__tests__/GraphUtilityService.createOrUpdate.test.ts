import { InMemoryRepository } from '../../../__tests__/support/inMemoryRepository';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * The write contract every graph-node producer relies on: on UPDATE, a field
 * left `undefined` keeps its stored value and `null` clears it.
 *
 * `linkedTable`/`linkedId` are why it matters. An importer upserts on
 * `(owner, entity_type, linked_table, linked_id)`, so a write that clears the
 * linked key — or changes the type — detaches the row, and the next import of
 * the same source mints a duplicate beside it. The `memory.remember` pipeline
 * used to turn every field its caller omitted into `null` on the way here.
 */

const OWNER = 'owner-1';
const NODE = 'node-1';
const EDGE = 'edge-1';

function storedNode(overrides: Partial<GraphNodeEntity> = {}): GraphNodeEntity {
  return Object.assign(new GraphNodeEntity(), {
    entity_id: NODE,
    owner_user_id: OWNER,
    entity_type: 'Person',
    outgoing_relationships: [],
    name: 'Alex Rivera',
    description: 'Google Contacts card',
    properties: { emails: ['alex@example.com'], planner: { trust_mode: 'ask' } },
    dossier: null,
    search_content: 'Alex Rivera alex@example.com',
    linked_table: 'import:google-contacts',
    linked_id: '6c1f7a52-9d1e-5b0a-8f3e-2a4b6c8d0e1f',
    is_active: true,
    is_archived: false,
    ...overrides,
  });
}

function storedEdge(overrides: Partial<RelationshipEntity> = {}): RelationshipEntity {
  return Object.assign(new RelationshipEntity(), {
    relationship_id: EDGE,
    owner_user_id: OWNER,
    from_entity_id: 'from-1',
    to_entity_id: 'to-1',
    relationship_type: 'KNOWS',
    properties: { since: '2019', source: 'google-contacts' },
    strength: 0.4,
    is_bidirectional: true,
    start_date: null,
    end_date: null,
    is_active: true,
    ...overrides,
  });
}

function setup(seed: { nodes?: GraphNodeEntity[]; edges?: RelationshipEntity[] } = {}) {
  const nodes = new InMemoryRepository<GraphNodeEntity>('entity_id');
  const edges = new InMemoryRepository<RelationshipEntity>('relationship_id');
  nodes.seed(...(seed.nodes ?? []));
  edges.seed(...(seed.edges ?? []));

  const service = new GraphUtilityService(nodes as never, edges as never, { setContext: jest.fn() } as never);

  return { service, nodes, edges };
}

describe('GraphUtilityService.createOrUpdateNode — updating an existing row', () => {
  it.each([
    ['name', 'name'],
    ['description', 'description'],
    ['searchContent', 'search_content'],
    ['linkedTable', 'linked_table'],
    ['linkedId', 'linked_id'],
  ] as const)(
    'keeps the stored %s when the write leaves it undefined, and clears it on an explicit null',
    async (field, column) => {
      const before = storedNode();

      const untouched = setup({ nodes: [before] });
      await untouched.service.createOrUpdateNode(OWNER, { entityId: NODE, [field]: undefined });
      expect(untouched.nodes.get(NODE)?.[column]).toEqual(before[column]);

      const cleared = setup({ nodes: [before] });
      await cleared.service.createOrUpdateNode(OWNER, { entityId: NODE, [field]: null });
      expect(cleared.nodes.get(NODE)?.[column]).toBeNull();
    },
  );

  it('keeps entity_type unless a type is given', async () => {
    const { service, nodes } = setup({ nodes: [storedNode()] });

    await service.createOrUpdateNode(OWNER, { entityId: NODE, name: 'Alex R.' });

    expect(nodes.get(NODE)?.entity_type).toBe('Person');
  });

  it('merges properties over the stored bag by default', async () => {
    const { service, nodes } = setup({ nodes: [storedNode()] });

    await service.createOrUpdateNode(OWNER, { entityId: NODE, properties: { occupation: 'dentist' } });

    expect(nodes.get(NODE)?.properties).toEqual({
      emails: ['alex@example.com'],
      planner: { trust_mode: 'ask' },
      occupation: 'dentist',
    });
  });

  it('replaces the bag when mergeProperties is false and properties are sent', async () => {
    const { service, nodes } = setup({ nodes: [storedNode()] });

    await service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      properties: { occupation: 'dentist' },
      mergeProperties: false,
    });

    expect(nodes.get(NODE)?.properties).toEqual({ occupation: 'dentist' });
  });

  it('never empties the bag on mergeProperties: false alone — there is nothing to replace it with', async () => {
    const { service, nodes } = setup({ nodes: [storedNode()] });

    await service.createOrUpdateNode(OWNER, { entityId: NODE, name: 'Alex R.', mergeProperties: false });

    expect(nodes.get(NODE)?.properties).toEqual(storedNode().properties);
  });

  it('deletes removeProperties keys after merging, and on their own', async () => {
    const merged = setup({ nodes: [storedNode()] });
    await merged.service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      properties: { occupation: 'dentist' },
      removeProperties: ['planner'],
    });
    expect(merged.nodes.get(NODE)?.properties).toEqual({
      emails: ['alex@example.com'],
      occupation: 'dentist',
    });

    const removalOnly = setup({ nodes: [storedNode()] });
    await removalOnly.service.createOrUpdateNode(OWNER, { entityId: NODE, removeProperties: ['emails'] });
    expect(removalOnly.nodes.get(NODE)?.properties).toEqual({ planner: { trust_mode: 'ask' } });
  });

  it('reports the write as an update of the same row', async () => {
    const { service, nodes } = setup({ nodes: [storedNode()] });

    const { node, created } = await service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      entityType: 'Person',
    });

    expect(created).toBe(false);
    expect(node.entity_id).toBe(NODE);
    expect(nodes.all()).toHaveLength(1);
  });
});

describe('GraphUtilityService.createOrUpdateNode — inserting a new row', () => {
  it('defaults an omitted field exactly as it would a null one', async () => {
    const omitted = setup();
    const { node: fromUndefined } = await omitted.service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      entityType: 'Concept',
      name: 'Pilates',
    });

    const nulled = setup();
    const { node: fromNull } = await nulled.service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      entityType: 'Concept',
      name: 'Pilates',
      description: null,
      searchContent: null,
      linkedTable: null,
      linkedId: null,
    });

    expect(fromUndefined).toEqual(fromNull);
    expect(fromUndefined).toMatchObject({
      entity_type: 'Concept',
      name: 'Pilates',
      description: 'Pilates',
      search_content: 'Pilates',
      properties: {},
      linked_table: null,
      linked_id: null,
      is_active: true,
    });
  });

  it('still requires a type', async () => {
    const { service } = setup();

    await expect(service.createOrUpdateNode(OWNER, { entityId: NODE, name: 'Nameless' })).rejects.toThrow(
      'entityType is required',
    );
  });
});

describe('GraphUtilityService.createOrUpdateRelationship', () => {
  it('keeps the stored strength, direction and properties a write leaves undefined', async () => {
    const { service, edges } = setup({ edges: [storedEdge()] });

    await service.createOrUpdateRelationship(OWNER, {
      relationshipId: EDGE,
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
    });

    expect(edges.get(EDGE)).toMatchObject({
      strength: 0.4,
      is_bidirectional: true,
      properties: { since: '2019', source: 'google-contacts' },
    });
  });

  it('merges properties by default and deletes removeProperties keys afterwards', async () => {
    const { service, edges } = setup({ edges: [storedEdge()] });

    await service.createOrUpdateRelationship(OWNER, {
      relationshipId: EDGE,
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      properties: { context: 'dentist' },
      removeProperties: ['source'],
    });

    expect(edges.get(EDGE)?.properties).toEqual({ since: '2019', context: 'dentist' });
  });

  // A brand-new relationship goes in through INSERT … ON CONFLICT, which this
  // in-memory table cannot run; its insert defaults, the yield to a concurrent
  // writer and the owner checks are pinned against Postgres in
  // GraphUtilityService.createOrUpdateRelationship.integration.test.ts.
});

describe('GraphUtilityService.createOrUpdateRelationship — an edge already on the coordinate', () => {
  // relationships_unique_directed_idx allows one active edge per (from, to,
  // type). A write that names no row by id used to INSERT beside it and die on
  // that index; it now lands on the edge that is there.

  it.each([
    ['no relationshipId', undefined],
    ['a relationshipId that names no row', 'edge-never-written'],
  ])('merges into the stored edge when the write carries %s', async (_label, relationshipId) => {
    const { service, edges } = setup({ edges: [storedEdge({ is_bidirectional: false })] });

    const { relationship, created } = await service.createOrUpdateRelationship(OWNER, {
      relationshipId,
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      properties: { context: 'dentist' },
    });

    expect(created).toBe(false);
    expect(relationship.relationship_id).toBe(EDGE);
    expect(edges.all()).toHaveLength(1);
    expect(edges.get(EDGE)).toMatchObject({
      strength: 0.4,
      is_bidirectional: false,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
  });

  it('applies the same write-time merge as an update by id: replace, removals, explicit fields', async () => {
    const replaced = setup({ edges: [storedEdge()] });
    await replaced.service.createOrUpdateRelationship(OWNER, {
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      properties: { only: 'this' },
      mergeProperties: false,
      strength: 0.9,
    });
    expect(replaced.edges.get(EDGE)).toMatchObject({ properties: { only: 'this' }, strength: 0.9 });

    const pruned = setup({ edges: [storedEdge()] });
    await pruned.service.createOrUpdateRelationship(OWNER, {
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      removeProperties: ['source'],
    });
    expect(pruned.edges.get(EDGE)?.properties).toEqual({ since: '2019' });
  });

  it('lands on a bidirectional edge written the other way round and keeps its stored orientation', async () => {
    const { service, edges } = setup({ edges: [storedEdge()] });

    const { created } = await service.createOrUpdateRelationship(OWNER, {
      fromEntityId: 'to-1',
      toEntityId: 'from-1',
      relationshipType: 'KNOWS',
      properties: { context: 'dentist' },
    });

    expect(created).toBe(false);
    expect(edges.all()).toHaveLength(1);
    expect(edges.get(EDGE)).toMatchObject({
      from_entity_id: 'from-1',
      to_entity_id: 'to-1',
      is_bidirectional: true,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
  });
});

describe('GraphUtilityService.findActiveRelationship', () => {
  const coordinate = { fromEntityId: 'from-1', toEntityId: 'to-1', relationshipType: 'KNOWS' };
  const reversed = { fromEntityId: 'to-1', toEntityId: 'from-1', relationshipType: 'KNOWS' };

  it('finds the active edge on the coordinate, and a bidirectional one stored the other way round', async () => {
    const { service } = setup({ edges: [storedEdge()] });

    expect((await service.findActiveRelationship(OWNER, coordinate))?.relationship_id).toBe(EDGE);
    expect((await service.findActiveRelationship(OWNER, reversed))?.relationship_id).toBe(EDGE);
  });

  it('prefers the edge in the orientation asked for when both exist', async () => {
    const { service } = setup({
      edges: [
        storedEdge(),
        storedEdge({ relationship_id: 'edge-2', from_entity_id: 'to-1', to_entity_id: 'from-1' }),
      ],
    });

    expect((await service.findActiveRelationship(OWNER, reversed))?.relationship_id).toBe('edge-2');
  });

  it('does not reverse a one-way edge, or a bidirectional one for a write that asks for one-way', async () => {
    const oneWay = setup({ edges: [storedEdge({ is_bidirectional: false })] });
    expect(await oneWay.service.findActiveRelationship(OWNER, reversed)).toBeNull();

    const both = setup({ edges: [storedEdge()] });
    expect(
      await both.service.findActiveRelationship(OWNER, { ...reversed, isBidirectional: false }),
    ).toBeNull();
    expect(
      await both.service.findActiveRelationship(OWNER, { ...coordinate, isBidirectional: false }),
    ).not.toBeNull();
  });

  it("ignores a forgotten edge, another type, and another owner's edge", async () => {
    const forgotten = setup({ edges: [storedEdge({ is_active: false })] });
    expect(await forgotten.service.findActiveRelationship(OWNER, coordinate)).toBeNull();

    const retyped = setup({ edges: [storedEdge()] });
    expect(
      await retyped.service.findActiveRelationship(OWNER, { ...coordinate, relationshipType: 'LIKES' }),
    ).toBeNull();

    const foreign = setup({ edges: [storedEdge({ owner_user_id: 'owner-2' })] });
    expect(await foreign.service.findActiveRelationship(OWNER, coordinate)).toBeNull();
  });
});
