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

describe('GraphUtilityService.createOrUpdateNode — a write onto a linked key another row holds', () => {
  // entities_linked_uniq allows one row per (owner, entity_type, linked_table,
  // linked_id), and it is partial on linked_table alone, so a forgotten or
  // merged-away row still holds its key. A write that retyped or re-keyed its row
  // onto a key another row held, or inserted a row there, died on that index —
  // against Postgres, in WriteKnowledgeTool.importKey.integration.test.ts. This
  // table enforces no index: it shows the write stops before it saves anything.
  const LINKED_ID = storedNode().linked_id;
  const HELD = `the Person linked to import:google-contacts record ${LINKED_ID}`;

  /** The Concept an older parser filed the same contact card as, on the same linked key. */
  const concept = (overrides: Partial<GraphNodeEntity> = {}) =>
    storedNode({ entity_type: 'Concept', properties: { source: 'vcard' }, ...overrides });
  /** The Person already on that key. */
  const holder = (overrides: Partial<GraphNodeEntity> = {}) =>
    storedNode({ entity_id: 'node-2', ...overrides });

  it.each([
    ['retypes its row', [concept(), holder()], { entityId: NODE, entityType: 'Person' }],
    [
      're-keys its row',
      [storedNode({ linked_table: null, linked_id: null }), holder()],
      { entityId: NODE, linkedTable: 'import:google-contacts', linkedId: LINKED_ID },
    ],
    [
      'inserts a row',
      [holder()],
      {
        entityId: 'node-new',
        entityType: 'Person',
        name: 'Alex R.',
        linkedTable: 'import:google-contacts',
        linkedId: LINKED_ID,
      },
    ],
  ])(
    'refuses a write that %s onto the key, names the row holding it, and saves nothing',
    async (_label, seeded, write) => {
      const { service, nodes } = setup({ nodes: seeded });

      await expect(
        service.createOrUpdateNode(OWNER, { ...write, properties: { occupation: 'dentist' } }),
      ).rejects.toThrow(`Entity ${write.entityId} cannot become ${HELD}: entity node-2 already is`);

      expect(nodes.all()).toEqual(seeded);
    },
  );

  it('refuses the key while a forgotten or merged-away row holds it, and says the holder is inactive', async () => {
    const inactive = holder({ is_active: false });
    const { service, nodes } = setup({ nodes: [concept(), inactive] });

    await expect(service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'Person' })).rejects.toThrow(
      `Entity ${NODE} cannot become ${HELD}: entity node-2 already is, although it is no longer active`,
    );

    expect(nodes.get(NODE)).toEqual(concept());
    expect(nodes.get('node-2')).toEqual(inactive);
  });

  it('retypes, re-keys and inserts onto a key no other row holds', async () => {
    const retype = setup({ nodes: [concept()] });
    await retype.service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'Person' });
    expect(retype.nodes.get(NODE)).toMatchObject({ entity_type: 'Person', linked_id: LINKED_ID });

    // Another type on the same linked_table and linked_id is a different key.
    const rekey = setup({
      nodes: [storedNode({ linked_table: null, linked_id: null }), concept({ entity_id: 'node-2' })],
    });
    await rekey.service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      linkedTable: 'import:google-contacts',
      linkedId: LINKED_ID,
    });
    expect(rekey.nodes.get(NODE)).toMatchObject({ entity_type: 'Person', linked_id: LINKED_ID });

    const insert = setup({ nodes: [concept({ entity_id: 'node-2' })] });
    const { created } = await insert.service.createOrUpdateNode(OWNER, {
      entityId: 'node-new',
      entityType: 'Person',
      linkedTable: 'import:google-contacts',
      linkedId: LINKED_ID,
    });
    expect(created).toBe(true);
    expect(insert.nodes.all()).toHaveLength(2);
  });

  it('never counts a key the index does not hold: no linked_table, or no linked_id', async () => {
    // Outside the index's predicate, or NULL — and in a unique index one NULL
    // never equals another, so rows like these can share everything else.
    const noLinkedId = setup({ nodes: [concept({ linked_id: null }), holder({ linked_id: null })] });
    await noLinkedId.service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'Person' });
    expect(noLinkedId.nodes.get(NODE)?.entity_type).toBe('Person');

    const noLinkedTable = setup({ nodes: [concept({ linked_table: null }), holder({ linked_table: null })] });
    await noLinkedTable.service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'Person' });
    expect(noLinkedTable.nodes.get(NODE)?.entity_type).toBe('Person');
  });

  it('looks up no holder for a row that keeps its key — not even one it brings back from forgotten', async () => {
    // The index is not partial on is_active, so unlike an edge, a node coming
    // back to life is on a key it already held.
    const { service, nodes } = setup({ nodes: [storedNode({ is_active: false })] });
    const findOne = jest.spyOn(nodes, 'findOne');

    await service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      entityType: 'Person',
      linkedTable: 'import:google-contacts',
      linkedId: LINKED_ID,
      properties: { occupation: 'dentist' },
    });

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(nodes.get(NODE)).toMatchObject({ is_active: true, properties: { occupation: 'dentist' } });
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

describe('GraphUtilityService.createOrUpdateRelationship — a write by id onto a coordinate another edge holds', () => {
  // A write by id moved, retyped or reactivated its row whatever was already on
  // the (from, to, type) it named. relationships_unique_directed_idx allows one
  // active edge there, so the UPDATE died on it — against Postgres, in
  // GraphUtilityService.createOrUpdateRelationship.integration.test.ts. This
  // table enforces no index: it shows the write stops before it saves anything.
  const holder = (overrides: Partial<RelationshipEntity> = {}) =>
    storedEdge({
      relationship_id: 'edge-2',
      relationship_type: 'FRIENDS_WITH',
      properties: { met: 'school' },
      strength: 0.8,
      ...overrides,
    });

  it.each([
    [
      'retypes it',
      storedEdge(),
      holder(),
      { fromEntityId: 'from-1', toEntityId: 'to-1', relationshipType: 'FRIENDS_WITH' },
    ],
    [
      'moves it to other endpoints',
      storedEdge(),
      holder({ relationship_type: 'KNOWS', to_entity_id: 'to-2' }),
      { fromEntityId: 'from-1', toEntityId: 'to-2', relationshipType: 'KNOWS' },
    ],
    [
      'brings a forgotten row back',
      storedEdge({ is_active: false }),
      holder({ relationship_type: 'KNOWS' }),
      { fromEntityId: 'from-1', toEntityId: 'to-1', relationshipType: 'KNOWS' },
    ],
  ])(
    'refuses a write that %s, names the edge in the way, and saves nothing',
    async (_label, before, held, target) => {
      const { service, edges } = setup({ edges: [before, held] });

      await expect(
        service.createOrUpdateRelationship(OWNER, {
          relationshipId: EDGE,
          ...target,
          properties: { context: 'dentist' },
        }),
      ).rejects.toThrow(
        `Relationship ${EDGE} cannot become ${target.fromEntityId} -[${target.relationshipType}]-> ` +
          `${target.toEntityId}: relationship edge-2 is already the active edge there`,
      );

      expect(edges.get(EDGE)).toEqual(before);
      expect(edges.get('edge-2')).toEqual(held);
    },
  );

  it("refuses the coordinate when another owner's edge holds it, since the index is not scoped to an owner", async () => {
    const held = holder({ owner_user_id: 'owner-2' });
    const { service, edges } = setup({ edges: [storedEdge(), held] });

    await expect(
      service.createOrUpdateRelationship(OWNER, {
        relationshipId: EDGE,
        fromEntityId: 'from-1',
        toEntityId: 'to-1',
        relationshipType: 'FRIENDS_WITH',
      }),
    ).rejects.toThrow(`the active edge there does not belong to owner ${OWNER}`);

    expect(edges.get(EDGE)).toEqual(storedEdge());
    expect(edges.get('edge-2')).toEqual(held);
  });

  it('retypes, moves and reactivates a row whose coordinate only a forgotten edge holds', async () => {
    const forgotten = holder({ is_active: false });
    const retype = setup({ edges: [storedEdge(), forgotten] });
    await retype.service.createOrUpdateRelationship(OWNER, {
      relationshipId: EDGE,
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'FRIENDS_WITH',
    });
    expect(retype.edges.get(EDGE)).toMatchObject({ relationship_type: 'FRIENDS_WITH', is_active: true });
    expect(retype.edges.get('edge-2')).toEqual(forgotten);

    const move = setup({ edges: [storedEdge()] });
    await move.service.createOrUpdateRelationship(OWNER, {
      relationshipId: EDGE,
      fromEntityId: 'from-1',
      toEntityId: 'to-2',
      relationshipType: 'KNOWS',
    });
    expect(move.edges.get(EDGE)).toMatchObject({ to_entity_id: 'to-2', relationship_type: 'KNOWS' });

    const revive = setup({ edges: [storedEdge({ is_active: false })] });
    await revive.service.createOrUpdateRelationship(OWNER, {
      relationshipId: EDGE,
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
    });
    expect(revive.edges.get(EDGE)?.is_active).toBe(true);
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
