import { Events } from '@ci/domains/events';
import {
  GraphEventService,
  GraphNodeEntity,
  GraphUtilityService,
  type RelationshipEntity,
} from '@ci/domains/memory';

import { InMemoryRepository } from '../../../__tests__/support/inMemoryRepository';
import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.remember` SPELLING AN ENTITY TYPE THE WAY ci.entities STORES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tool sent `entityType` exactly as the model wrote it, for `entity.create`
 * and for a real retype in `entity.update`. Qwen writes `person` and `place`.
 * In Postgres `valid_entity_type` refuses a lower-case first letter, so those
 * writes failed after the tool had answered "Created"/"Updated" and the job
 * dead-lettered with the whole update in it. A `PERSON` was stored, and was a
 * type of its own to PersonService, to the person search sweeps and to
 * `entities_linked_uniq`, so it slipped past the linked-key refusal beside the
 * `Person` twin. That half is proven on Postgres in
 * WriteKnowledgeTool.entityTypeSpelling.integration.test.ts; this table
 * enforces neither the CHECK nor the index.
 *
 * Everything below the tool is real — GraphEventService, and
 * GraphUtilityService's read-modify-write over an in-memory table — with the
 * queue as a JSON round-trip held until each `run` ends.
 */

const OWNER = 'user-1';
const CONTEXT = { userId: OWNER };

// Entity ids are `z.string().uuid()` in the tool's schema.
const PERSON = '0199a1b2-0000-7000-8000-000000000001';
const CONCEPT = '0199a1b2-0000-7000-8000-000000000002';
const LOCATION = '0199a1b2-0000-7000-8000-000000000003';
const SAM = '0199a1b2-0000-7000-8000-000000000004';
const LINKED_ID = '6c1f7a52-9d1e-5b0a-8f3e-2a4b6c8d0e1f';
const HELD = `the Person linked to import:google-contacts record ${LINKED_ID}`;

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

/** An imported contact. */
const importedPerson = () =>
  entityRow({
    entity_id: PERSON,
    entity_type: 'Person',
    name: 'Alex Rivera',
    linked_table: 'import:google-contacts',
    linked_id: LINKED_ID,
    properties: { emails: ['alex@example.com'] },
  });

/** The Concept an older parser filed the same card as, on the Person's linked key. */
const conceptTwin = () =>
  entityRow({
    entity_id: CONCEPT,
    entity_type: 'Concept',
    name: 'Alex Rivera',
    linked_table: 'import:google-contacts',
    linked_id: LINKED_ID,
    properties: { source: 'vcard' },
  });

/** An imported place, filed under the legacy Place type the importer still writes. */
const importedLocation = () =>
  entityRow({
    entity_id: LOCATION,
    entity_type: 'Location',
    name: 'Home',
    linked_table: 'import:google-maps',
    linked_id: '1f0e2d3c-4b5a-5968-8776-a5b4c3d2e1f0',
  });

function makePipeline(...seed: GraphNodeEntity[]) {
  const nodes = new InMemoryRepository<GraphNodeEntity>('entity_id');
  const edges = new InMemoryRepository<RelationshipEntity>('relationship_id');
  nodes.seed(...seed);

  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const graphUtility = new GraphUtilityService(nodes as never, edges as never, logger as never);

  type Queued = {
    ownerId: string;
    node?: Parameters<GraphUtilityService['createOrUpdateNode']>[1];
    relationship?: Parameters<GraphUtilityService['createOrUpdateRelationship']>[1];
  };
  const queue: Array<{ event: string; body: Queued }> = [];
  const eventService = {
    send: jest.fn(async (event: string, body: unknown) => {
      queue.push({ event, body: JSON.parse(JSON.stringify(body)) as Queued });

      return ['job'];
    }),
  };

  const active = (row: GraphNodeEntity | undefined, includeInactive = false): row is GraphNodeEntity =>
    row !== undefined && row.owner_user_id === OWNER && (includeInactive || row.is_active);
  const graphQuery = {
    getNode: jest.fn(async (_owner: string, id: string, options: { includeInactive?: boolean } = {}) => {
      const row = nodes.get(id);

      return active(row, options.includeInactive) ? row : null;
    }),
    // GraphUtilityService.queryNodes' filter: entity_type matches exactly, the name by substring.
    getNodes: jest.fn(async (_owner: string, filters: { entityType?: string; nameContains?: string }) =>
      nodes
        .all()
        .filter((row) => active(row))
        .filter((row) => filters.entityType === undefined || row.entity_type === filters.entityType)
        .filter(
          (row) =>
            filters.nameContains === undefined ||
            (row.name ?? '').toLowerCase().includes(filters.nameContains.toLowerCase()),
        ),
    ),
    getNodesByIds: jest.fn(async (_owner: string, ids: string[]) =>
      ids.map((id) => nodes.get(id)).filter((row) => active(row)),
    ),
    searchNodesByPrefix: jest.fn(async () => []),
    getRelationships: jest.fn(async () => []),
    findActiveRelationship: jest.fn(async () => null),
    // The real linked-key lookup — the same one the write makes when it lands.
    findLinkedKeyHolder: jest.fn(
      (owner: string, key: Parameters<GraphUtilityService['findLinkedKeyHolder']>[1]) =>
        graphUtility.findLinkedKeyHolder(owner, key),
    ),
  };

  const tool = new WriteKnowledgeTool(
    new GraphEventService(eventService as never, logger as never),
    graphQuery as never,
    logger as never,
    { getSelfIdentity: async () => null } as never,
  );

  /**
   * Execute, keep what was queued, and let every queued node write land. A
   * relationship write is only read off the queue: inserting an edge takes the
   * QueryBuilder this table does not have.
   */
  const run = async (input: unknown) => {
    const result = await tool.execute(CONTEXT, input);
    const sent = queue.splice(0);

    for (const { event, body } of sent) {
      if (event === Events.GRAPH_NODE_UPSERTED && body.node) {
        await graphUtility.createOrUpdateNode(body.ownerId, body.node);
      }
    }

    const sentTypes = sent.filter(({ body }) => body.node).map(({ body }) => body.node?.entityType);

    return { result, sent, sentTypes };
  };

  return { nodes, run, graphQuery };
}

describe('memory.remember — entity.create spells the type the way ci.entities stores it', () => {
  it.each([
    ['person', 'Person'],
    ['PERSON', 'Person'],
    [' place ', 'Place'],
    ['organization', 'Organization'],
  ])('sends %j as %s, and the new row carries it', async (requested, stored) => {
    const graph = makePipeline();

    const { result, sentTypes } = await graph.run({
      operations: [{ kind: 'entity.create', entityType: requested, name: 'Alex' }],
    });

    expect(result.data).toMatchObject({ createdNodes: 1, failures: 0 });
    expect(sentTypes).toEqual([stored]);
    expect(graph.nodes.get(result.data!.results[0].entityId!)?.entity_type).toBe(stored);
  });

  it('sends a type the graph has never held exactly as the model wrote it', async () => {
    const graph = makePipeline();

    const { result, sentTypes } = await graph.run({
      operations: [{ kind: 'entity.create', entityType: 'Restaurant', name: 'Nopa' }],
    });

    expect(result.data).toMatchObject({ createdNodes: 1, failures: 0 });
    expect(sentTypes).toEqual(['Restaurant']);
  });

  it('fails a type no row can hold instead of reporting it created, and queues nothing', async () => {
    const graph = makePipeline();

    for (const dryRun of [false, true]) {
      const { result, sent } = await graph.run({
        operations: [{ kind: 'entity.create', entityType: 'restaurant', name: 'Nopa' }],
        dryRun,
      });

      expect(result.data).toMatchObject({ createdNodes: 0, failures: 1 });
      expect(result.data?.results[0].message).toBe(
        'Entity type "restaurant" cannot be stored: use letters only, starting with a capital letter (e.g. Restaurant)',
      );
      expect(sent).toEqual([]);
    }

    expect(graph.nodes.all()).toEqual([]);
  });

  it('resolves a relationship end named with the lower-case type against the stored type', async () => {
    // The by-name lookup filters entity_type exactly; `person` matched no Person.
    const graph = makePipeline(
      importedPerson(),
      entityRow({ entity_id: SAM, entity_type: 'Person', name: 'Sam' }),
    );

    const { result, sent } = await graph.run({
      operations: [
        {
          kind: 'relationship.create',
          from: { entityType: 'person', name: 'Rivera' },
          toEntityId: SAM,
          relationshipType: 'KNOWS',
        },
      ],
    });

    expect(result.data).toMatchObject({ createdRelationships: 1, failures: 0 });
    expect(graph.graphQuery.getNodes).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ entityType: 'Person' }),
    );
    expect(sent[0].body.relationship).toMatchObject({ fromEntityId: PERSON, toEntityId: SAM });
  });
});

describe('memory.remember — entity.create reusing an id, naming the stored type another way', () => {
  it('reads another name for the stored type as that type: it updates the row and keeps the type', async () => {
    // It used to refuse this as a change of type — "Entity … is a Location;
    // … cannot make it a place" — though a place is what a Location is.
    const graph = makePipeline(importedLocation());

    const { result, sentTypes } = await graph.run({
      operations: [
        { kind: 'entity.create', entityId: LOCATION, entityType: 'place', properties: { kind: 'home' } },
      ],
    });

    expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });
    expect(sentTypes).toEqual(['Location']);
    expect(graph.nodes.get(LOCATION)).toMatchObject({
      entity_type: 'Location',
      linked_table: 'import:google-maps',
      properties: { kind: 'home' },
    });
  });
});

describe('memory.remember — entity.update spells a retype the way ci.entities stores it', () => {
  it.each(['person', 'PERSON'])('retypes a Concept with %j to Person', async (requested) => {
    const graph = makePipeline(conceptTwin());

    const { result, sentTypes } = await graph.run({
      operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: requested, properties: { a: 1 } }],
    });

    expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });
    expect(sentTypes).toEqual(['Person']);
    expect(graph.nodes.get(CONCEPT)).toMatchObject({
      entity_type: 'Person',
      linked_id: LINKED_ID,
      properties: { source: 'vcard', a: 1 },
    });
  });

  it.each(['person', 'PERSON'])(
    'refuses %j onto the key the Person twin holds, naming it — the spelling no longer hides the twin',
    async (requested) => {
      const graph = makePipeline(importedPerson(), conceptTwin());
      const before = graph.nodes.all();

      const { result, sent } = await graph.run({
        operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: requested }],
      });

      expect(result.data).toMatchObject({ updatedNodes: 0, failures: 1 });
      expect(result.data?.results[0].message).toBe(
        `Entity ${CONCEPT} cannot become ${HELD}: entity ${PERSON} already is. Update ${PERSON} instead, ` +
          `and forget ${CONCEPT} (memory.forget) if it is a duplicate of ${PERSON}.`,
      );
      expect(sent).toEqual([]);
      expect(graph.nodes.all()).toEqual(before);
    },
  );

  it.each([
    ['contact', importedPerson, PERSON, 'Person'],
    ['person', importedPerson, PERSON, 'Person'],
    ['place', importedLocation, LOCATION, 'Location'],
    ['location', importedLocation, LOCATION, 'Location'],
  ] as const)(
    'reads %j as the stored type: the update lands and the row keeps its type and import key',
    async (requested, seed, entityId, stored) => {
      const graph = makePipeline(seed());

      const { result, sentTypes } = await graph.run({
        operations: [{ kind: 'entity.update', entityId, entityType: requested, properties: { note: 'x' } }],
      });

      expect(result.data).toMatchObject({ updatedNodes: 1, failures: 0 });
      expect(sentTypes).toEqual([stored]);
      expect(graph.nodes.get(entityId)).toMatchObject({
        entity_type: stored,
        linked_id: seed().linked_id,
        properties: { ...seed().properties, note: 'x' },
      });
      // Not a move, so nothing to look for on the key.
      expect(graph.graphQuery.findLinkedKeyHolder).not.toHaveBeenCalled();
    },
  );

  it('fails a retype no row can hold instead of reporting it updated, and queues nothing', async () => {
    const graph = makePipeline(conceptTwin());

    const { result, sent } = await graph.run({
      operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: 'restaurant', name: 'Nopa' }],
    });

    expect(result.data).toMatchObject({ updatedNodes: 0, failures: 1 });
    expect(result.data?.results[0]).toMatchObject({
      status: 'failed',
      entityId: CONCEPT,
      message:
        'Entity type "restaurant" cannot be stored: use letters only, starting with a capital letter (e.g. Restaurant)',
    });
    expect(sent).toEqual([]);
    expect(graph.nodes.get(CONCEPT)).toEqual(conceptTwin());
  });

  it('retypes to a type the graph has never held exactly as the model wrote it', async () => {
    const graph = makePipeline(conceptTwin());

    const { sentTypes } = await graph.run({
      operations: [{ kind: 'entity.update', entityId: CONCEPT, entityType: 'Restaurant' }],
    });

    expect(sentTypes).toEqual(['Restaurant']);
    expect(graph.nodes.get(CONCEPT)?.entity_type).toBe('Restaurant');
  });
});
