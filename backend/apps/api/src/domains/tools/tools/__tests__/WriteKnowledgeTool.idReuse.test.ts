import { Events } from '@ci/domains/events';
import {
  GraphEventService,
  GraphNodeEntity,
  GraphUtilityService,
  RelationshipEntity,
} from '@ci/domains/memory';

import { InMemoryRepository } from '../../../__tests__/support/inMemoryRepository';
import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.remember` WRITING ONTO A ROW THAT ALREADY EXISTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `entity.create` with an `entityId` that names an existing row used to send
 * `null` for every field the model left out and `mergeProperties: false`. On an
 * imported Person that cleared `linked_table`/`linked_id` — the coordinate its
 * importer upserts on, so the next import minted a duplicate — and swapped the
 * whole properties bag for whatever the model sent, taking with it the keys
 * other writers own (PersonMergeService's folded identifiers, `is_self`,
 * structured names, planner settings). `relationship.create` had the same shape
 * for edges.
 *
 * Everything below the tool is real — GraphEventService, and
 * GraphUtilityService's read-modify-write over an in-memory table — so the
 * assertions are about the row a write leaves behind, not the arguments a mock
 * received. The queue is a JSON round-trip, as pg-boss carries it, held until
 * `flush()` so a spec can land another writer while a write is still queued.
 * The hand-off from queue to write is the one GraphEventListener makes; that it
 * adds nothing on the way is pinned in GraphEventListener.nodeUpserted.test.ts.
 */

const OWNER = 'user-1';
const CONTEXT = { userId: OWNER };

// Entity/relationship ids are `z.string().uuid()` in the tool's schema.
const PERSON = '0199a1b2-0000-7000-8000-000000000001';
const SELF = '0199a1b2-0000-7000-8000-000000000002';
const OTHER = '0199a1b2-0000-7000-8000-000000000003';
const FRESH = '0199a1b2-0000-7000-8000-000000000004';
const EDGE = '0199a1b2-0000-7000-8000-0000000000e1';
const LINKED_ID = '6c1f7a52-9d1e-5b0a-8f3e-2a4b6c8d0e1f';
const SELF_LINKED_ID = '0b9e4a1c-3d5f-5e7a-9b1c-2d3e4f5a6b7c';

function entityRow(fields: Partial<GraphNodeEntity> & Pick<GraphNodeEntity, 'entity_id' | 'entity_type'>) {
  return Object.assign(new GraphNodeEntity(), {
    owner_user_id: OWNER,
    outgoing_relationships: [],
    name: null,
    description: null,
    properties: {},
    dossier: null,
    search_content: null,
    linked_table: null,
    linked_id: null,
    is_active: true,
    is_archived: false,
    ...fields,
  });
}

/** An imported contact, as an import + a merge + a person edit + the planner leave it. */
function importedPerson(): GraphNodeEntity {
  return entityRow({
    entity_id: PERSON,
    entity_type: 'Person',
    name: 'Alex Rivera',
    description: 'Google Contacts card',
    search_content: 'Alex Rivera alex@example.com',
    linked_table: 'import:google-contacts',
    linked_id: LINKED_ID,
    properties: {
      // PersonMergeService.foldProperties, from a duplicate merged into this card.
      emails: ['alex@example.com', 'a.rivera@work.example'],
      phones: ['+15551230001', '+15551230002'],
      names: ['Alex Rivera', 'A. Rivera'],
      // PersonService.updatePerson, mirrored onto typed columns.
      first_name: 'Alex',
      last_name: 'Rivera',
    },
  });
}

/** The owner's own Person, which ensureSelfEntity keys on `import:self`. */
function selfPerson(): GraphNodeEntity {
  return entityRow({
    entity_id: SELF,
    entity_type: 'Person',
    name: 'Sam Owner',
    linked_table: 'import:self',
    linked_id: SELF_LINKED_ID,
    properties: { is_self: true, planner: { trust_mode: 'ask', image_description_enabled: true } },
  });
}

function knowsEdge(overrides: Partial<RelationshipEntity> = {}): RelationshipEntity {
  return Object.assign(new RelationshipEntity(), {
    relationship_id: EDGE,
    owner_user_id: OWNER,
    from_entity_id: PERSON,
    to_entity_id: OTHER,
    from_entity_type: 'Person',
    to_entity_type: 'Person',
    relationship_type: 'KNOWS',
    properties: { since: '2019', source: 'google-contacts' },
    strength: 0.4,
    is_bidirectional: false,
    start_date: null,
    end_date: null,
    is_active: true,
    ...overrides,
  });
}

/** A graph event as it comes off the queue — JSON, so an unset field is simply absent. */
interface QueuedWrite {
  ownerId: string;
  node?: Parameters<GraphUtilityService['createOrUpdateNode']>[1];
  relationship?: Parameters<GraphUtilityService['createOrUpdateRelationship']>[1];
}

function makePipeline(seed: { nodes?: GraphNodeEntity[]; edges?: RelationshipEntity[] } = {}) {
  const nodes = new InMemoryRepository<GraphNodeEntity>('entity_id');
  const edges = new InMemoryRepository<RelationshipEntity>('relationship_id');
  nodes.seed(...(seed.nodes ?? []));
  edges.seed(...(seed.edges ?? []));

  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const graphUtility = new GraphUtilityService(nodes as never, edges as never, logger as never);

  const queue: Array<{ event: string; body: QueuedWrite }> = [];
  const eventService = {
    send: jest.fn(async (event: string, body: unknown) => {
      queue.push({ event, body: JSON.parse(JSON.stringify(body)) as QueuedWrite });

      return ['job'];
    }),
  };

  const flush = async () => {
    for (const { event, body } of queue.splice(0)) {
      if (event === Events.GRAPH_NODE_UPSERTED && body.node) {
        await graphUtility.createOrUpdateNode(body.ownerId, body.node);
      } else if (event === Events.GRAPH_RELATIONSHIP_UPSERTED && body.relationship) {
        await graphUtility.createOrUpdateRelationship(body.ownerId, body.relationship);
      }
    }
  };

  // The reads the tool makes, over the same table the writes land in.
  const visible = <T extends { owner_user_id: string | null; is_active: boolean }>(
    row: T | undefined,
    includeInactive = false,
  ): row is T => row !== undefined && row.owner_user_id === OWNER && (includeInactive || row.is_active);
  const graphQuery = {
    getNode: jest.fn(async (_owner: string, id: string, options: { includeInactive?: boolean } = {}) => {
      const row = nodes.get(id);

      return visible(row, options.includeInactive) ? row : null;
    }),
    getNodes: jest.fn(async () => []),
    getNodesByIds: jest.fn(async (_owner: string, ids: string[]) =>
      ids.map((id) => nodes.get(id)).filter((row) => visible(row)),
    ),
    searchNodesByPrefix: jest.fn(async () => []),
    getRelationships: jest.fn(
      async (_owner: string, options: { relationshipIds?: string[]; includeInactive?: boolean }) =>
        (options.relationshipIds ?? [])
          .map((id) => edges.get(id))
          .filter((row) => visible(row, options.includeInactive)),
    ),
    // The real coordinate lookup — the same one the write makes when it lands.
    findActiveRelationship: jest.fn(
      (owner: string, edge: Parameters<GraphUtilityService['findActiveRelationship']>[1]) =>
        graphUtility.findActiveRelationship(owner, edge),
    ),
    // Likewise the real linked-key lookup.
    findLinkedKeyHolder: jest.fn(
      (owner: string, key: Parameters<GraphUtilityService['findLinkedKeyHolder']>[1]) =>
        graphUtility.findLinkedKeyHolder(owner, key),
    ),
  };

  const tool = new WriteKnowledgeTool(
    new GraphEventService(eventService as never, logger as never),
    graphQuery as never,
    logger as never,
  );

  /** Execute and let every queued write land. */
  const run = async (input: unknown) => {
    const result = await tool.execute(CONTEXT, input);
    await flush();

    return result;
  };

  return { tool, nodes, edges, queue, flush, run, graphQuery };
}

describe('memory.remember — entity.create with an entityId that already exists', () => {
  it('keeps the linked key, the type and every field the model left out, and merges the properties it sent', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ createdNodes: 0, updatedNodes: 1, failures: 0 });
    expect(result.data?.results[0]).toMatchObject({ status: 'updated', entityId: PERSON });

    const before = importedPerson();
    expect(graph.nodes.get(PERSON)).toMatchObject({
      entity_type: 'Person',
      name: before.name,
      description: before.description,
      search_content: before.search_content,
      linked_table: 'import:google-contacts',
      linked_id: LINKED_ID,
      properties: { ...before.properties, occupation: 'dentist' },
    });
  });

  it('puts nothing on the wire for a field the model left out — no null that would read as "clear it"', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(graph.queue).toHaveLength(1);
    expect(graph.queue[0].body.node).toEqual({
      entityId: PERSON,
      entityType: 'Person',
      properties: { occupation: 'dentist' },
      mergeProperties: true,
    });
  });

  it('still applies what the model does send: a name renames, a sent key wins', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          name: 'Alexander Rivera',
          properties: { first_name: 'Alexander' },
        },
      ],
    });

    const stored = graph.nodes.get(PERSON);
    expect(stored?.name).toBe('Alexander Rivera');
    expect(stored?.properties).toEqual({ ...importedPerson().properties, first_name: 'Alexander' });
    expect(stored).toMatchObject({ linked_table: 'import:google-contacts', linked_id: LINKED_ID });
  });

  it("leaves the owner's self Person on its import:self key with is_self and the planner settings intact", async () => {
    const graph = makePipeline({ nodes: [selfPerson()] });

    await graph.run({
      operations: [
        { kind: 'entity.create', entityId: SELF, entityType: 'Person', properties: { nickname: 'Sammy' } },
      ],
    });

    expect(graph.nodes.get(SELF)).toMatchObject({
      linked_table: 'import:self',
      linked_id: SELF_LINKED_ID,
      properties: {
        is_self: true,
        planner: { trust_mode: 'ask', image_description_enabled: true },
        nickname: 'Sammy',
      },
    });
  });

  it('reads a case-only type difference as the stored type, not a retype', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'person',
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });
    expect(graph.nodes.get(PERSON)?.entity_type).toBe('Person');
  });

  it('refuses a real change of type and writes nothing — the id is more likely wrong than the type', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    const result = await graph.run({
      operations: [
        { kind: 'entity.create', entityId: PERSON, entityType: 'Organization', name: 'Acme Dental' },
      ],
    });

    expect(result.data).toMatchObject({ createdNodes: 0, updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0].status).toBe('failed');
    expect(result.data?.results[0].message).toContain('is a Person');
    expect(result.data?.results[0].message).toContain('Omit entityId');
    expect(graph.queue).toHaveLength(0);
    expect(graph.nodes.get(PERSON)).toEqual(importedPerson());
  });

  it('dry run reports the update and writes nothing', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    const result = await graph.run({
      dryRun: true,
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ dryRun: true, updatedNodes: 1, createdNodes: 0 });
    expect(result.data?.results[0].message).toContain('would update existing entity');
    expect(graph.queue).toHaveLength(0);
    expect(graph.nodes.get(PERSON)).toEqual(importedPerson());
  });

  it('still merges when the row only exists by the time the write lands', async () => {
    // `entityId` can name a row whose own create is still queued, so the tool's
    // read sees nothing and the write lands on a populated row anyway. The
    // merge must not depend on what the read saw.
    const graph = makePipeline({ nodes: [importedPerson()] });
    graph.graphQuery.getNode.mockResolvedValueOnce(null);

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(result.data?.results[0].status).toBe('created');
    expect(graph.nodes.get(PERSON)).toMatchObject({
      linked_table: 'import:google-contacts',
      linked_id: LINKED_ID,
      properties: { ...importedPerson().properties, occupation: 'dentist' },
    });
  });

  it('makes a retried create harmless: the second one adds to the first instead of replacing it', async () => {
    const graph = makePipeline();

    await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: FRESH,
          entityType: 'Concept',
          name: 'Pilates',
          properties: { a: 1 },
        },
      ],
    });
    const retry = await graph.run({
      operations: [{ kind: 'entity.create', entityId: FRESH, entityType: 'Concept', properties: { b: 2 } }],
    });

    expect(retry.data?.results[0].status).toBe('updated');
    expect(graph.nodes.get(FRESH)).toMatchObject({ name: 'Pilates', properties: { a: 1, b: 2 } });
  });

  it('creates a brand-new entity exactly as before', async () => {
    const graph = makePipeline();

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityType: 'Concept',
          name: 'Pilates',
          properties: { category: 'fitness' },
        },
      ],
    });

    expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 0, failures: 0 });
    const [created] = graph.nodes.all();
    expect(created).toMatchObject({
      entity_id: result.data?.results[0].entityId,
      entity_type: 'Concept',
      name: 'Pilates',
      description: 'Pilates',
      search_content: 'Pilates',
      properties: { category: 'fitness' },
      linked_table: null,
      linked_id: null,
      is_active: true,
    });
  });
});

describe('memory.remember — entity.update', () => {
  it('sends only what the caller set, so a change another writer landed while the write was queued survives', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    await graph.tool.execute(CONTEXT, {
      operations: [{ kind: 'entity.update', entityId: PERSON, properties: { occupation: 'dentist' } }],
    });
    // An import refresh / person merge lands between the tool's read and its write.
    const current = graph.nodes.get(PERSON)!;
    graph.nodes.seed({
      ...current,
      name: 'Alex Q. Rivera',
      properties: { ...current.properties, phones: ['+15551230001', '+15551230002', '+15551230003'] },
    });
    await graph.flush();

    expect(graph.nodes.get(PERSON)).toMatchObject({
      name: 'Alex Q. Rivera',
      linked_table: 'import:google-contacts',
      linked_id: LINKED_ID,
      properties: {
        phones: ['+15551230001', '+15551230002', '+15551230003'],
        occupation: 'dentist',
        emails: importedPerson().properties.emails,
      },
    });
  });

  it('applies removeProperties to the row as it is when the write lands', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'entity.update',
          entityId: PERSON,
          properties: { occupation: 'dentist' },
          removeProperties: ['names'],
        },
      ],
    });
    const current = graph.nodes.get(PERSON)!;
    graph.nodes.seed({ ...current, properties: { ...current.properties, avatar_url: 'alex.png' } });
    await graph.flush();

    const expected: Record<string, unknown> = {
      ...importedPerson().properties,
      avatar_url: 'alex.png',
      occupation: 'dentist',
    };
    delete expected.names;
    expect(graph.nodes.get(PERSON)?.properties).toEqual(expected);
  });

  it('replaces the bag on mergeProperties: false with properties, and leaves it alone without them', async () => {
    const replaced = makePipeline({ nodes: [importedPerson()] });
    await replaced.run({
      operations: [
        { kind: 'entity.update', entityId: PERSON, mergeProperties: false, properties: { only: 'this' } },
      ],
    });
    expect(replaced.nodes.get(PERSON)?.properties).toEqual({ only: 'this' });

    // mergeProperties: false alone used to empty the bag: the tool replaced it
    // with the `{}` it defaulted the missing properties to.
    const renamed = makePipeline({ nodes: [importedPerson()] });
    await renamed.run({
      operations: [{ kind: 'entity.update', entityId: PERSON, mergeProperties: false, name: 'Alex R.' }],
    });
    expect(renamed.nodes.get(PERSON)).toMatchObject({
      name: 'Alex R.',
      properties: importedPerson().properties,
    });
  });

  it('keeps the stored spelling for a case-only entityType; an explicit different type is still a retype', async () => {
    const caseOnly = makePipeline({ nodes: [importedPerson()] });
    await caseOnly.run({ operations: [{ kind: 'entity.update', entityId: PERSON, entityType: 'PERSON' }] });
    expect(caseOnly.nodes.get(PERSON)?.entity_type).toBe('Person');

    // entity.update stays the explicit door for a type change.
    const retyped = makePipeline({ nodes: [importedPerson()] });
    await retyped.run({
      operations: [{ kind: 'entity.update', entityId: PERSON, entityType: 'Organization' }],
    });
    expect(retyped.nodes.get(PERSON)).toMatchObject({ entity_type: 'Organization', linked_id: LINKED_ID });
  });
});

describe('memory.remember — relationship.create with a relationshipId that already exists', () => {
  const endpoints = () => [
    importedPerson(),
    entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Sam' }),
  ];

  it('keeps the stored strength, direction and unsent properties, and merges the properties it sent', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: EDGE,
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: 'KNOWS',
          properties: { context: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, updatedRelationships: 1, failures: 0 });
    expect(graph.edges.get(EDGE)).toMatchObject({
      from_entity_id: PERSON,
      to_entity_id: OTHER,
      relationship_type: 'KNOWS',
      strength: 0.4,
      is_bidirectional: false,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
  });

  it('refuses to move the relationship to other endpoints, and writes nothing', async () => {
    const graph = makePipeline({
      nodes: [...endpoints(), entityRow({ entity_id: FRESH, entity_type: 'Person', name: 'Jo' })],
      edges: [knowsEdge()],
    });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: EDGE,
          fromEntityId: PERSON,
          toEntityId: FRESH,
          relationshipType: 'KNOWS',
        },
      ],
    });

    expect(result.data).toMatchObject({ failures: 1, createdRelationships: 0, updatedRelationships: 0 });
    expect(result.data?.results[0].message).toContain('cannot move or retype');
    expect(graph.queue).toHaveLength(0);
    expect(graph.edges.get(EDGE)).toEqual(knowsEdge());
  });

  it('refuses a real retype, but reads a case-only difference as the stored type', async () => {
    const retype = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });
    const refused = await retype.run({
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: EDGE,
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: 'WORKS_WITH',
        },
      ],
    });
    expect(refused.data).toMatchObject({ failures: 1 });
    expect(retype.edges.get(EDGE)?.relationship_type).toBe('KNOWS');

    const caseOnly = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });
    const accepted = await caseOnly.run({
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: EDGE,
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: 'knows',
        },
      ],
    });
    expect(accepted.data).toMatchObject({ failures: 0, updatedRelationships: 1 });
    expect(caseOnly.edges.get(EDGE)?.relationship_type).toBe('KNOWS');
  });

  it('matches a bidirectional relationship in either orientation and keeps the stored one', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge({ is_bidirectional: true })] });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: EDGE,
          fromEntityId: OTHER,
          toEntityId: PERSON,
          relationshipType: 'KNOWS',
        },
      ],
    });

    expect(result.data).toMatchObject({ failures: 0, updatedRelationships: 1 });
    expect(graph.edges.get(EDGE)).toMatchObject({ from_entity_id: PERSON, to_entity_id: OTHER });
  });

  it('queues a brand-new relationship with nothing for the insert defaults to lose', async () => {
    // What the insert then makes of it — strength 1, one-way, `{}` — needs the
    // INSERT … ON CONFLICT this table cannot run; it is pinned against Postgres
    // in WriteKnowledgeTool.importKey.integration.test.ts.
    const graph = makePipeline({ nodes: endpoints() });

    const result = await graph.tool.execute(CONTEXT, {
      operations: [
        { kind: 'relationship.create', fromEntityId: PERSON, toEntityId: OTHER, relationshipType: 'KNOWS' },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 1, updatedRelationships: 0, failures: 0 });
    expect(graph.queue).toHaveLength(1);
    expect(graph.queue[0].body.relationship).toEqual({
      relationshipId: result.data?.results[0].relationshipId,
      fromEntityId: PERSON,
      toEntityId: OTHER,
      relationshipType: 'KNOWS',
      mergeProperties: true,
    });
  });
});

describe('memory.remember — restating a relationship that already exists, without its id', () => {
  // How a model restates a fact: it has no relationshipId, only the two ends and
  // the type. The edge on that coordinate is often an importer's, so each of
  // these used to mint a fresh id, INSERT, and dead-letter on
  // relationships_unique_directed_idx — after the tool had said "Created".
  const endpoints = () => [
    importedPerson(),
    entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Sam' }),
  ];

  it('lands on the stored edge, reports it updated under its own id, and merges what it sent', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: 'KNOWS',
          properties: { context: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, updatedRelationships: 1, failures: 0 });
    expect(result.data?.results[0]).toMatchObject({ status: 'updated', relationshipId: EDGE });
    expect(graph.edges.all()).toHaveLength(1);
    expect(graph.edges.get(EDGE)).toMatchObject({
      strength: 0.4,
      is_bidirectional: false,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
  });

  it('reads a relationship type in any case or spacing as the stored spelling', async () => {
    const graph = makePipeline({
      nodes: endpoints(),
      edges: [knowsEdge({ relationship_type: 'WORKS_WITH' })],
    });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: ' works with ',
          properties: { team: 'billing' },
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 1, failures: 0 });
    expect(graph.edges.all()).toHaveLength(1);
    expect(graph.edges.get(EDGE)).toMatchObject({
      relationship_type: 'WORKS_WITH',
      properties: { team: 'billing' },
    });
  });

  it('matches a bidirectional edge restated the other way round, and keeps the stored orientation', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge({ is_bidirectional: true })] });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          fromEntityId: OTHER,
          toEntityId: PERSON,
          relationshipType: 'KNOWS',
          properties: { met: 'school' },
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 1, failures: 0 });
    expect(graph.edges.get(EDGE)).toMatchObject({
      from_entity_id: PERSON,
      to_entity_id: OTHER,
      is_bidirectional: true,
      properties: { since: '2019', source: 'google-contacts', met: 'school' },
    });
  });

  it('treats the reverse of a one-way edge, or a one-way restatement of a bidirectional one, as a new edge', async () => {
    const oneWay = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });
    const reversed = await oneWay.tool.execute(CONTEXT, {
      operations: [
        { kind: 'relationship.create', fromEntityId: OTHER, toEntityId: PERSON, relationshipType: 'KNOWS' },
      ],
    });
    expect(reversed.data).toMatchObject({ createdRelationships: 1, updatedRelationships: 0 });
    expect(oneWay.queue[0].body.relationship).toMatchObject({ fromEntityId: OTHER, toEntityId: PERSON });
    expect(oneWay.queue[0].body.relationship?.relationshipId).not.toBe(EDGE);

    // Merging `OTHER -> PERSON, one-way` into the stored PERSON <-> OTHER would
    // leave it one-way PERSON -> OTHER: the opposite of what was said.
    const both = makePipeline({ nodes: endpoints(), edges: [knowsEdge({ is_bidirectional: true })] });
    const narrowed = await both.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'relationship.create',
          fromEntityId: OTHER,
          toEntityId: PERSON,
          relationshipType: 'KNOWS',
          isBidirectional: false,
        },
      ],
    });
    expect(narrowed.data).toMatchObject({ createdRelationships: 1, updatedRelationships: 0 });
    expect(both.queue[0].body.relationship?.relationshipId).not.toBe(EDGE);
  });

  it('merges into the stored edge when the relationshipId it sends names no row', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: FRESH,
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: 'KNOWS',
          properties: { context: 'dentist' },
        },
      ],
    });

    expect(result.data?.results[0]).toMatchObject({ status: 'updated', relationshipId: EDGE });
    expect(graph.edges.all().map((edge) => edge.relationship_id)).toEqual([EDGE]);
    expect(graph.edges.get(EDGE)?.properties).toMatchObject({ context: 'dentist' });
  });

  it('still merges when the edge only exists by the time the write lands', async () => {
    // The tool's read can miss an edge whose own write is still queued. The
    // write resolves the coordinate again when it lands, so it merges anyway.
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });
    graph.graphQuery.findActiveRelationship.mockResolvedValueOnce(null);

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: 'KNOWS',
          properties: { context: 'dentist' },
        },
      ],
    });

    expect(result.data?.results[0].status).toBe('created');
    expect(graph.edges.all().map((edge) => edge.relationship_id)).toEqual([EDGE]);
    expect(graph.edges.get(EDGE)).toMatchObject({
      strength: 0.4,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
  });

  it('dry run reports the update of the stored edge and writes nothing', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });

    const result = await graph.run({
      dryRun: true,
      operations: [
        { kind: 'relationship.create', fromEntityId: PERSON, toEntityId: OTHER, relationshipType: 'KNOWS' },
      ],
    });

    expect(result.data).toMatchObject({ dryRun: true, updatedRelationships: 1, createdRelationships: 0 });
    expect(result.data?.results[0]).toMatchObject({ status: 'updated', relationshipId: EDGE });
    expect(graph.queue).toHaveLength(0);
  });

  it("does the same for an entity.create's relationships, keeping the edge's strength, direction and properties", async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge({ is_bidirectional: true })] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          relationships: [
            { toEntityId: OTHER, relationshipType: 'knows', properties: { context: 'dentist' } },
          ],
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 1, createdRelationships: 0, updatedRelationships: 1 });
    expect(graph.edges.all()).toHaveLength(1);
    // The nested write used to send strength 1, one-way and `mergeProperties:
    // false` over the model's bag — every one of these would have been reset.
    expect(graph.edges.get(EDGE)).toMatchObject({
      relationship_type: 'KNOWS',
      strength: 0.4,
      is_bidirectional: true,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
  });
});

describe('memory.remember — relationship writes the table would refuse', () => {
  const endpoints = () => [
    importedPerson(),
    entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Sam' }),
  ];

  it('fails a type no spelling can store instead of reporting it saved', async () => {
    const graph = makePipeline({ nodes: endpoints() });

    const result = await graph.run({
      operations: [
        { kind: 'relationship.create', fromEntityId: PERSON, toEntityId: OTHER, relationshipType: 'likes!' },
        {
          kind: 'relationship.create',
          fromEntityId: PERSON,
          toEntityId: OTHER,
          relationshipType: '2nd_cousin',
        },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, failures: 2 });
    expect(result.data?.results[0].message).toContain('cannot be stored');
    expect(graph.queue).toHaveLength(0);
  });

  it('fails a relationship whose two ends resolve to the same entity', async () => {
    const graph = makePipeline({ nodes: endpoints() });

    const result = await graph.run({
      operations: [
        { kind: 'relationship.create', fromEntityId: PERSON, toEntityId: PERSON, relationshipType: 'KNOWS' },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 0, failures: 1 });
    expect(result.data?.results[0].message).toContain('two different entities');
    expect(graph.queue).toHaveLength(0);
  });

  it("checks an entity.create's relationships before queueing the entity, so a failure writes nothing", async () => {
    // Checked after, the entity was queued while the result said "failed" —
    // and a retried create without an entityId minted a second one.
    const graph = makePipeline({ nodes: endpoints() });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityType: 'Concept',
          name: 'Pilates',
          relationships: [
            { toEntityId: OTHER, relationshipType: 'INTERESTS' },
            { toEntityId: FRESH, relationshipType: 'INTERESTS' },
          ],
        },
        {
          kind: 'entity.create',
          entityId: PERSON,
          entityType: 'Person',
          relationships: [{ toEntityId: PERSON, relationshipType: 'KNOWS' }],
        },
      ],
    });

    expect(result.data).toMatchObject({
      createdNodes: 0,
      updatedNodes: 0,
      createdRelationships: 0,
      failures: 2,
    });
    expect(result.data?.results[0].message).toContain('target entity is missing');
    expect(result.data?.results[1].message).toContain('to itself');
    expect(graph.queue).toHaveLength(0);
  });
});

describe('memory.remember — relationship.update', () => {
  it('sends only what the caller set, so a change landed while the write was queued survives', async () => {
    const graph = makePipeline({
      nodes: [importedPerson(), entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Sam' })],
      edges: [knowsEdge()],
    });

    await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'relationship.update',
          relationshipId: EDGE,
          properties: { context: 'dentist' },
          removeProperties: ['source'],
        },
      ],
    });
    const current = graph.edges.get(EDGE)!;
    graph.edges.seed({
      ...current,
      strength: 0.9,
      properties: { ...current.properties, last_contact: '2026-09-01' },
    });
    await graph.flush();

    expect(graph.edges.get(EDGE)).toMatchObject({
      strength: 0.9,
      properties: { since: '2019', last_contact: '2026-09-01', context: 'dentist' },
    });
    expect(graph.edges.get(EDGE)?.properties).not.toHaveProperty('source');
  });
});

describe('memory.remember — relationship.update retyping onto a type the two entities already have', () => {
  // A retype moves the edge to another (from, to, type) coordinate. When an
  // active edge already held it, the queued write died on
  // relationships_unique_directed_idx and the job dead-lettered — after the tool
  // had answered "Updated relationship". This table enforces no index; the
  // Postgres half is in WriteKnowledgeTool.importKey.integration.test.ts.
  const FRIENDS = '0199a1b2-0000-7000-8000-0000000000e2';
  const endpoints = () => [
    importedPerson(),
    entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Sam' }),
  ];
  const friendsEdge = (overrides: Partial<RelationshipEntity> = {}) =>
    knowsEdge({
      relationship_id: FRIENDS,
      relationship_type: 'FRIENDS_WITH',
      properties: { met: 'school' },
      strength: 0.8,
      ...overrides,
    });

  it('refuses the retype, names the edge already there and what to do instead, and queues nothing', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge(), friendsEdge()] });

    const result = await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'relationship.update',
          relationshipId: EDGE,
          relationshipType: 'friends with',
          properties: { context: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 0, failures: 1 });
    expect(result.data?.results[0]).toEqual({
      kind: 'relationship.update',
      status: 'failed',
      message:
        `Relationship ${EDGE} cannot become FRIENDS_WITH: relationship ${FRIENDS} already is one between the ` +
        `same entities. Update ${FRIENDS} instead, and forget ${EDGE} (memory.forget) if the KNOWS ` +
        'relationship no longer holds.',
      relationshipId: EDGE,
    });
    expect(graph.queue).toHaveLength(0);
    expect(graph.edges.get(EDGE)).toEqual(knowsEdge());
    expect(graph.edges.get(FRIENDS)).toEqual(friendsEdge());
  });

  it('dry run reports the refusal, not an update', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge(), friendsEdge()] });

    const result = await graph.tool.execute(CONTEXT, {
      dryRun: true,
      operations: [{ kind: 'relationship.update', relationshipId: EDGE, relationshipType: 'FRIENDS_WITH' }],
    });

    expect(result.data).toMatchObject({ dryRun: true, updatedRelationships: 0, failures: 1 });
    expect(result.data?.results[0].message).toContain(`relationship ${FRIENDS} already is one`);
  });

  it('counts a bidirectional edge stored the other way round only when the retyped edge is bidirectional too', async () => {
    // The same match relationship.create makes when it looks for the edge a
    // restatement lands on.
    const reversed = friendsEdge({ from_entity_id: OTHER, to_entity_id: PERSON, is_bidirectional: true });

    const both = makePipeline({
      nodes: endpoints(),
      edges: [knowsEdge({ is_bidirectional: true }), reversed],
    });
    const refused = await both.run({
      operations: [{ kind: 'relationship.update', relationshipId: EDGE, relationshipType: 'FRIENDS_WITH' }],
    });
    expect(refused.data).toMatchObject({ updatedRelationships: 0, failures: 1 });
    expect(both.edges.get(EDGE)?.relationship_type).toBe('KNOWS');

    // One-way PERSON -> OTHER is not the OTHER <-> PERSON stored, and it is on a
    // coordinate of its own, so the index has nothing to refuse either.
    const oneWay = makePipeline({ nodes: endpoints(), edges: [knowsEdge(), reversed] });
    const retyped = await oneWay.run({
      operations: [{ kind: 'relationship.update', relationshipId: EDGE, relationshipType: 'FRIENDS_WITH' }],
    });
    expect(retyped.data).toMatchObject({ updatedRelationships: 1, failures: 0 });
    expect(oneWay.edges.get(EDGE)).toMatchObject({
      relationship_type: 'FRIENDS_WITH',
      is_bidirectional: false,
    });
    expect(oneWay.edges.get(FRIENDS)).toEqual(reversed);
  });

  it('retypes onto a type only a forgotten edge has, and leaves that edge forgotten', async () => {
    const graph = makePipeline({
      nodes: endpoints(),
      edges: [knowsEdge(), friendsEdge({ is_active: false })],
    });

    const result = await graph.run({
      operations: [
        {
          kind: 'relationship.update',
          relationshipId: EDGE,
          relationshipType: 'FRIENDS_WITH',
          properties: { context: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 1, failures: 0 });
    expect(graph.edges.get(EDGE)).toMatchObject({
      relationship_type: 'FRIENDS_WITH',
      strength: 0.4,
      properties: { since: '2019', source: 'google-contacts', context: 'dentist' },
    });
    expect(graph.edges.get(FRIENDS)).toEqual(friendsEdge({ is_active: false }));
  });

  it('only looks for an edge in the way when the type really changes', async () => {
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge(), friendsEdge()] });

    const result = await graph.run({
      operations: [
        { kind: 'relationship.update', relationshipId: EDGE, relationshipType: 'knows', strength: 0.5 },
        { kind: 'relationship.update', relationshipId: EDGE, properties: { context: 'dentist' } },
      ],
    });

    expect(result.data).toMatchObject({ updatedRelationships: 2, failures: 0 });
    expect(graph.graphQuery.findActiveRelationship).not.toHaveBeenCalled();
    expect(graph.edges.get(EDGE)).toMatchObject({ relationship_type: 'KNOWS', strength: 0.5 });
  });

  it('an edge that takes the type after the tool looked stops the write with a legible error, not the index', async () => {
    // The tool's check and the write are on either side of the queue. An edge
    // landing in between is caught by the write's own check, which names it
    // and saves nothing.
    const graph = makePipeline({ nodes: endpoints(), edges: [knowsEdge()] });

    const result = await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'relationship.update',
          relationshipId: EDGE,
          relationshipType: 'FRIENDS_WITH',
          properties: { context: 'dentist' },
        },
      ],
    });
    expect(result.data).toMatchObject({ updatedRelationships: 1, failures: 0 });

    graph.edges.seed(friendsEdge());
    await expect(graph.flush()).rejects.toThrow(
      `Relationship ${EDGE} cannot become ${PERSON} -[FRIENDS_WITH]-> ${OTHER}: ` +
        `relationship ${FRIENDS} is already the active edge there`,
    );
    expect(graph.edges.get(EDGE)).toEqual(knowsEdge());
    expect(graph.edges.get(FRIENDS)).toEqual(friendsEdge());
  });
});

describe('memory.remember — entity.update onto a linked key another entity holds', () => {
  // A retype or a re-key moves the entity to another (entity_type, linked_table,
  // linked_id), and entities_linked_uniq allows one of the owner's rows on each,
  // active or not. A contact card filed once as a Concept and once as a Person
  // leaves twins on one linked key, so "this Concept is really a Person" queued a
  // write that died on the index, and the job dead-lettered — after the tool had
  // answered "Updated entity". This table enforces no index; the Postgres half is
  // in WriteKnowledgeTool.importKey.integration.test.ts.
  const CONCEPT = '0199a1b2-0000-7000-8000-000000000005';
  const HELD = `the Person linked to import:google-contacts record ${LINKED_ID}`;

  /** The Concept an older parser filed Alex's card as, on the imported Person's linked key. */
  const conceptTwin = (overrides: Partial<GraphNodeEntity> = {}) =>
    entityRow({
      entity_id: CONCEPT,
      entity_type: 'Concept',
      name: 'Alex Rivera',
      linked_table: 'import:google-contacts',
      linked_id: LINKED_ID,
      properties: { source: 'vcard' },
      ...overrides,
    });

  it('refuses the retype, names the entity already there and what to do instead, and queues nothing', async () => {
    const graph = makePipeline({ nodes: [importedPerson(), conceptTwin()] });

    const result = await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'entity.update',
          entityId: CONCEPT,
          entityType: 'Person',
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0]).toEqual({
      kind: 'entity.update',
      status: 'failed',
      message:
        `Entity ${CONCEPT} cannot become ${HELD}: entity ${PERSON} already is. Update ${PERSON} instead, and ` +
        `forget ${CONCEPT} (memory.forget) if it is a duplicate of ${PERSON}.`,
      entityId: CONCEPT,
    });
    expect(graph.queue).toHaveLength(0);
    expect(graph.nodes.get(CONCEPT)).toEqual(conceptTwin());
    expect(graph.nodes.get(PERSON)).toEqual(importedPerson());
  });

  it('dry run reports the refusal, not an update', async () => {
    const graph = makePipeline({ nodes: [importedPerson(), conceptTwin()] });

    const result = await graph.tool.execute(CONTEXT, {
      dryRun: true,
      operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: 'Person' }],
    });

    expect(result.data).toMatchObject({ dryRun: true, updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0].message).toContain(`entity ${PERSON} already is`);
  });

  it("refuses a re-key onto another entity's linked key the same way", async () => {
    const unlinked = entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Alex R.' });
    const graph = makePipeline({ nodes: [importedPerson(), unlinked] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.update',
          entityId: OTHER,
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0].message).toBe(
      `Entity ${OTHER} cannot become ${HELD}: entity ${PERSON} already is. Update ${PERSON} instead, and ` +
        `forget ${OTHER} (memory.forget) if it is a duplicate of ${PERSON}.`,
    );
    expect(graph.nodes.get(OTHER)).toEqual(unlinked);
  });

  it('refuses the key while a forgotten or merged-away entity holds it, and says so', async () => {
    const forgotten = { ...importedPerson(), is_active: false };
    const graph = makePipeline({ nodes: [forgotten, conceptTwin()] });

    const result = await graph.run({
      operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: 'Person' }],
    });

    expect(result.data).toMatchObject({ updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0].message).toBe(
      `Entity ${CONCEPT} cannot become ${HELD}: entity ${PERSON} still is, although it has been forgotten or ` +
        'merged into another entity.',
    );
    expect(graph.nodes.get(CONCEPT)).toEqual(conceptTwin());
  });

  it('retypes the entity when no other entity holds that key, and keeps the key', async () => {
    const graph = makePipeline({ nodes: [conceptTwin()] });

    const result = await graph.run({
      operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: 'Person', properties: { a: 1 } }],
    });

    expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });
    expect(graph.nodes.get(CONCEPT)).toMatchObject({
      entity_type: 'Person',
      linked_table: 'import:google-contacts',
      linked_id: LINKED_ID,
      properties: { source: 'vcard', a: 1 },
    });
  });

  it('only looks for an entity in the way when the type or the linked key really changes', async () => {
    const graph = makePipeline({ nodes: [importedPerson(), conceptTwin()] });

    const result = await graph.run({
      operations: [
        { kind: 'entity.update', entityId: CONCEPT, entityType: 'concept', properties: { a: 1 } },
        {
          kind: 'entity.update',
          entityId: CONCEPT,
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
        },
        { kind: 'entity.update', entityId: CONCEPT, name: 'Alex' },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 3, failures: 0 });
    expect(graph.graphQuery.findLinkedKeyHolder).not.toHaveBeenCalled();
    expect(graph.nodes.get(CONCEPT)).toMatchObject({
      entity_type: 'Concept',
      name: 'Alex',
      linked_id: LINKED_ID,
      properties: { source: 'vcard', a: 1 },
    });
  });

  it('an entity that takes the key after the tool looked stops the write with a legible error, not the index', async () => {
    // The tool's check and the write are on either side of the queue. An
    // entity landing on the key in between is caught by the write's own check,
    // which names it and saves nothing.
    const graph = makePipeline({ nodes: [conceptTwin()] });

    const result = await graph.tool.execute(CONTEXT, {
      operations: [
        {
          kind: 'entity.update',
          entityId: CONCEPT,
          entityType: 'Person',
          properties: { occupation: 'dentist' },
        },
      ],
    });
    expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });

    graph.nodes.seed(importedPerson());
    await expect(graph.flush()).rejects.toThrow(
      `Entity ${CONCEPT} cannot become ${HELD}: entity ${PERSON} already is`,
    );
    expect(graph.nodes.get(CONCEPT)).toEqual(conceptTwin());
    expect(graph.nodes.get(PERSON)).toEqual(importedPerson());
  });
});

describe('memory.remember — entity.create onto a linked key another entity holds', () => {
  // The same index, reached by the other node write: an insert on a key already
  // held, or an id-reuse create that re-keys its row.
  const HELD = `the Person linked to import:google-contacts record ${LINKED_ID}`;

  it('refuses a new entity on the key, names the entity holding it, and queues nothing', async () => {
    const graph = makePipeline({ nodes: [importedPerson()] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityType: 'Person',
          name: 'Alex R.',
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
        },
      ],
    });

    expect(result.data).toMatchObject({ createdNodes: 0, updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0]).toEqual({
      kind: 'entity.create',
      status: 'failed',
      message:
        `Cannot create ${HELD}: entity ${PERSON} already is. Update ${PERSON} instead, or leave out linkedTable ` +
        'and linkedId to create a separate entity.',
    });
    expect(graph.queue).toHaveLength(0);
    expect(graph.nodes.all()).toEqual([importedPerson()]);
  });

  it('says so when the entity holding the key is forgotten or merged away', async () => {
    const graph = makePipeline({ nodes: [{ ...importedPerson(), is_active: false }] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityType: 'Person',
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
        },
      ],
    });

    expect(result.data).toMatchObject({ createdNodes: 0, failures: 1 });
    expect(result.data?.results[0].message).toBe(
      `Cannot create ${HELD}: entity ${PERSON} still is, although it has been forgotten or merged into another ` +
        'entity. Leave out linkedTable and linkedId to create a separate entity.',
    );
    expect(graph.nodes.all()).toHaveLength(1);
  });

  it('refuses an id-reuse create that would move its entity onto the key', async () => {
    const unlinked = entityRow({ entity_id: OTHER, entity_type: 'Person', name: 'Alex R.' });
    const graph = makePipeline({ nodes: [importedPerson(), unlinked] });

    const result = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: OTHER,
          entityType: 'Person',
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
          relationships: [{ toEntityId: PERSON, relationshipType: 'KNOWS' }],
        },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 0, createdRelationships: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining(`Entity ${OTHER} cannot become ${HELD}: entity ${PERSON} already is.`),
      entityId: OTHER,
    });
    expect(graph.queue).toHaveLength(0);
    expect(graph.nodes.get(OTHER)).toEqual(unlinked);
  });

  it('creates an entity on a key nobody holds, and restating a key the entity already holds is not a move', async () => {
    const graph = makePipeline();

    const created = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: FRESH,
          entityType: 'Person',
          name: 'Alex Rivera',
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
        },
      ],
    });
    const restated = await graph.run({
      operations: [
        {
          kind: 'entity.create',
          entityId: FRESH,
          entityType: 'Person',
          linkedTable: 'import:google-contacts',
          linkedId: LINKED_ID,
          properties: { occupation: 'dentist' },
        },
      ],
    });

    expect(created.data).toMatchObject({ createdNodes: 1, failures: 0 });
    expect(restated.data).toMatchObject({ updatedNodes: 1, failures: 0 });
    expect(graph.nodes.all()).toEqual([
      expect.objectContaining({
        entity_id: FRESH,
        linked_id: LINKED_ID,
        properties: { occupation: 'dentist' },
      }),
    ]);
  });
});
