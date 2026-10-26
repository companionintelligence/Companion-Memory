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
 * "Remember that Jordan Lee likes jazz" made a second Person "Jordan Lee" beside
 * the one the user already had, plus a Concept "jazz", and the fact went with
 * the duplicate: an `entity.create` without an id never looked for an existing
 * entity of that name. It now lands on the one person, place or concept that
 * already carries the name, and leaves everything else as it was.
 *
 * Same harness as WriteKnowledgeTool.idReuse.test.ts: the real GraphEventService
 * and GraphUtilityService over in-memory tables, so the assertions are about the
 * rows a write leaves behind.
 */

const OWNER = 'user-1';
const CONTEXT = { userId: OWNER };
const JORDAN = '0199a1b2-0000-7000-8000-000000000001';
const SELF = '0199a1b2-0000-7000-8000-000000000002';
const OTHER_JORDAN = '0199a1b2-0000-7000-8000-000000000003';
const MEETUP = '0199a1b2-0000-7000-8000-000000000004';

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

const jordan = () =>
  entityRow({
    entity_id: JORDAN,
    entity_type: 'Person',
    name: 'Jordan Lee',
    description: 'A friend from the climbing gym',
    properties: { city: 'Oakland' },
  });

function makePipeline(seed: GraphNodeEntity[], selfId: string | null = null) {
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
  const queue: Array<{ event: string; body: Record<string, never> }> = [];
  const eventService = {
    send: jest.fn(async (event: string, body: unknown) => {
      queue.push({ event, body: JSON.parse(JSON.stringify(body)) });

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

  const active = () => nodes.all().filter((row) => row.owner_user_id === OWNER && row.is_active);
  const graphQuery = {
    getNode: jest.fn(
      async (_owner: string, id: string) => active().find((row) => row.entity_id === id) ?? null,
    ),
    // GraphUtilityService.queryNodes: the owner's active rows of that type whose name contains the text.
    getNodes: jest.fn(async (_owner: string, options: { entityType?: string; nameContains?: string }) =>
      active().filter(
        (row) =>
          (!options.entityType || row.entity_type === options.entityType) &&
          (!options.nameContains ||
            (row.name ?? '').toLowerCase().includes(options.nameContains.toLowerCase())),
      ),
    ),
    getNodesByIds: jest.fn(async (_owner: string, ids: string[]) =>
      active().filter((row) => ids.includes(row.entity_id)),
    ),
    searchNodesByPrefix: jest.fn(async () => []),
    getRelationships: jest.fn(async () => []),
    findActiveRelationship: jest.fn(
      (owner: string, edge: Parameters<GraphUtilityService['findActiveRelationship']>[1]) =>
        graphUtility.findActiveRelationship(owner, edge),
    ),
    findLinkedKeyHolder: jest.fn(
      (owner: string, key: Parameters<GraphUtilityService['findLinkedKeyHolder']>[1]) =>
        graphUtility.findLinkedKeyHolder(owner, key),
    ),
  };

  const tool = new WriteKnowledgeTool(
    new GraphEventService(eventService as never, logger as never),
    graphQuery as never,
    logger as never,
    { getSelfIdentity: async () => (selfId ? { entityId: selfId } : null) } as never,
  );

  const run = async (input: unknown) => {
    const result = await tool.execute(CONTEXT, input);
    await flush();

    return result;
  };

  return { run, nodes, edges, active };
}

const LIKES_JAZZ = {
  operations: [
    { kind: 'entity.create', entityType: 'Person', name: 'Jordan Lee', properties: { likes: 'jazz' } },
    { kind: 'entity.create', entityType: 'Concept', name: 'jazz' },
    {
      kind: 'relationship.create',
      relationshipType: 'LIKES',
      from: { name: 'Jordan Lee' },
      to: { name: 'jazz' },
    },
  ],
};

describe('memory.remember — entity.create for a name the user already has', () => {
  it('lands on the existing person: no second Jordan Lee, and the fact merged onto that one', async () => {
    const graph = makePipeline([jordan()]);

    const result = await graph.run({ operations: LIKES_JAZZ.operations.slice(0, 2) });

    expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 1, failures: 0 });
    expect(result.data?.results[0]).toMatchObject({ status: 'updated', entityId: JORDAN });
    expect(result.data?.results[0].message).toContain('matched by name');

    const people = graph.active().filter((row) => row.entity_type === 'Person');
    expect(people).toHaveLength(1);
    expect(graph.nodes.get(JORDAN)).toMatchObject({
      name: 'Jordan Lee',
      description: 'A friend from the climbing gym',
      properties: { city: 'Oakland', likes: 'jazz' },
    });
  });

  it('links a relationship.create in the same call to the existing entities it named', async () => {
    const JAZZ = '0199a1b2-0000-7000-8000-000000000005';
    const graph = makePipeline([
      jordan(),
      entityRow({ entity_id: JAZZ, entity_type: 'Concept', name: 'jazz' }),
    ]);

    const result = await graph.run(LIKES_JAZZ);

    expect(result.data).toMatchObject({
      createdNodes: 0,
      updatedNodes: 2,
      createdRelationships: 1,
      failures: 0,
    });
    expect(graph.active()).toHaveLength(2);
    expect(graph.edges.all()).toEqual([
      expect.objectContaining({ from_entity_id: JORDAN, to_entity_id: JAZZ, relationship_type: 'LIKES' }),
    ]);
  });

  it('matches whatever the case and surrounding space, and keeps the stored spelling', async () => {
    const graph = makePipeline([jordan()]);

    await graph.run({
      operations: [
        { kind: 'entity.create', entityType: 'person', name: '  jordan lee ', properties: { likes: 'jazz' } },
      ],
    });

    expect(graph.active()).toHaveLength(1);
    expect(graph.nodes.get(JORDAN)).toMatchObject({ name: 'Jordan Lee', properties: { likes: 'jazz' } });
  });

  it('keeps the stored description and says how to change it', async () => {
    const graph = makePipeline([jordan()]);

    const result = await graph.run({
      operations: [
        { kind: 'entity.create', entityType: 'Person', name: 'Jordan Lee', description: 'Likes jazz' },
      ],
    });

    expect(graph.nodes.get(JORDAN)?.description).toBe('A friend from the climbing gym');
    expect(result.data?.results[0].message).toMatch(
      /description was kept, so use entity\.update with this entityId/,
    );
  });

  it('fills in a description the existing entity did not have', async () => {
    const graph = makePipeline([entityRow({ entity_id: JORDAN, entity_type: 'Person', name: 'Jordan Lee' })]);

    await graph.run({
      operations: [
        { kind: 'entity.create', entityType: 'Person', name: 'Jordan Lee', description: 'Likes jazz' },
      ],
    });

    expect(graph.nodes.get(JORDAN)?.description).toBe('Likes jazz');
  });

  it('says so on a dry run, and writes nothing', async () => {
    const graph = makePipeline([jordan()]);

    const result = await graph.run({ ...LIKES_JAZZ, dryRun: true });

    expect(result.data?.results[0]).toMatchObject({
      status: 'updated',
      message: `Dry run: would update existing entity ${JORDAN} (matched by name)`,
      entityId: JORDAN,
    });
    expect(graph.nodes.get(JORDAN)?.properties).toEqual({ city: 'Oakland' });
  });

  describe('still creates a new entity', () => {
    it('when two entities already carry the name, rather than guess which one is meant', async () => {
      const graph = makePipeline([
        jordan(),
        entityRow({
          entity_id: OTHER_JORDAN,
          entity_type: 'Person',
          name: 'Jordan Lee',
          description: 'A colleague',
        }),
      ]);

      const result = await graph.run({
        operations: [
          { kind: 'entity.create', entityType: 'Person', name: 'Jordan Lee', properties: { likes: 'jazz' } },
        ],
      });

      expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 0 });
      expect(graph.active().filter((row) => row.name === 'Jordan Lee')).toHaveLength(3);
    });

    it('for a different type of the same name', async () => {
      const graph = makePipeline([jordan()]);

      const result = await graph.run({
        operations: [{ kind: 'entity.create', entityType: 'Concept', name: 'Jordan Lee' }],
      });

      expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 0 });
    });

    it('for types where two entries may share a name, such as events', async () => {
      const graph = makePipeline([
        entityRow({ entity_id: MEETUP, entity_type: 'Event', name: 'Jazz night' }),
      ]);

      const result = await graph.run({
        operations: [{ kind: 'entity.create', entityType: 'Event', name: 'Jazz night' }],
      });

      expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 0 });
    });

    it("for the account holder's own name, whose Person is left to its own writers", async () => {
      const graph = makePipeline(
        [entityRow({ entity_id: SELF, entity_type: 'Person', name: 'Sam Owner' })],
        SELF,
      );

      const result = await graph.run({
        operations: [
          { kind: 'entity.create', entityType: 'Person', name: 'Sam Owner', properties: { likes: 'jazz' } },
        ],
      });

      expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 0 });
      expect(graph.nodes.get(SELF)?.properties).toEqual({});
    });

    it('when the create carries a linked key, which says which row it is', async () => {
      const graph = makePipeline([jordan()]);

      const result = await graph.run({
        operations: [
          {
            kind: 'entity.create',
            entityType: 'Person',
            name: 'Jordan Lee',
            linkedTable: 'import:google-contacts',
            linkedId: '6c1f7a52-9d1e-5b0a-8f3e-2a4b6c8d0e1f',
          },
        ],
      });

      expect(result.data).toMatchObject({ createdNodes: 1, updatedNodes: 0 });
    });
  });
});
