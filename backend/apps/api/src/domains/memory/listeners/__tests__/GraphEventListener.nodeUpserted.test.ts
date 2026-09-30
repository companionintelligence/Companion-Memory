import { type Acknowledgement, type EventPayloads, Events } from '@ci/domains/events';

import { InMemoryRepository } from '../../../__tests__/support/inMemoryRepository';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import type { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphEventService } from '../../services/GraphEventService';
import { GraphUtilityService } from '../../services/GraphUtilityService';
import { GraphEventListener } from '../GraphEventListener';

function makeAck(): Acknowledgement {
  return { jobId: 'test-job', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

type Payload = EventPayloads[Events.GRAPH_NODE_UPSERTED];

function makeListener(created: boolean, entityType: string | undefined = 'Concept') {
  const createOrUpdateNode = jest.fn(async () => ({
    node: { entity_id: 'entity-1', entity_type: entityType },
    created,
  }));
  const send = jest.fn(async () => ['job-1']);
  const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };

  const listener = new GraphEventListener(
    { createOrUpdateNode } as never,
    { send } as never,
    logger as never,
  );

  return { listener, createOrUpdateNode, send, logger };
}

function payload(entityType?: string): Payload {
  return {
    ownerId: 'owner-1',
    node: {
      entityId: 'entity-1',
      entityType,
      name: 'Sourdough starter',
      description: 'Fed weekly',
      properties: {},
    },
  } as Payload;
}

describe('GraphEventListener.handleNodeUpserted', () => {
  it('emits ConceptCreatedEvent so the concept reaches the search index', async () => {
    const { listener, send } = makeListener(true, 'Concept');

    await listener.handleNodeUpserted(payload('Concept'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('concept.created', { conceptId: 'entity-1' });
  });

  it('emits the UPDATED event when the node already existed, so a renamed node is re-indexed', async () => {
    const { listener, send } = makeListener(false, 'Concept');

    await listener.handleNodeUpserted(payload('Concept'));

    expect(send).toHaveBeenCalledWith('concept.updated', { conceptId: 'entity-1' });
  });

  it('maps the graph vocabulary onto the owning domain (Contact -> person, Location -> place)', async () => {
    const contact = makeListener(true, 'Contact');
    await contact.listener.handleNodeUpserted(payload('Contact'));
    expect(contact.send).toHaveBeenCalledWith('person.created', { personId: 'entity-1' });

    const location = makeListener(true, 'Location');
    await location.listener.handleNodeUpserted(payload('Location'));
    expect(location.send).toHaveBeenCalledWith('place.created', { placeId: 'entity-1' });
  });

  it('emits nothing for types with no resolvable domain row (left to GraphNodeSearchIndexListener)', async () => {
    for (const type of ['Event', 'Item', 'Content', 'Organization']) {
      const { listener, send } = makeListener(true, type);

      await listener.handleNodeUpserted(payload(type));

      expect(send).not.toHaveBeenCalled();
    }
  });

  it('emits exactly ONE search event per node — never a second, generic embed job', async () => {
    // A graph node reaches the search index through the per-type
    // `*Created`/`*UpdatedEvent` alone, because the matching
    // `*SearchIndexListener` re-reads the row and builds a weighted document
    // (name@10 + description@5), manages the `ci_search.index_skips` marker the
    // backfill sweep reads, and REMOVES a stale vector when the text goes away.
    //
    // The deleted `search.embed.entity` path did none of that: it embedded the
    // payload's `searchContent` through the message-tuned `embedSkipReason`
    // bar, which classifies a legitimate concept name ('AI', 'Node.js') as
    // `too-short` — the exact misclassification `ConceptSearchIndexListener`
    // documents as a bug it must not inherit. So a second embed job here is not
    // extra coverage, it is a worse duplicate. Pinned by count, not by name, so
    // ANY additional emission fails this.
    for (const [type, event] of [
      ['Person', 'person.created'],
      ['Location', 'place.created'],
      ['Concept', 'concept.created'],
    ] as const) {
      const { listener, send } = makeListener(true, type);

      await listener.handleNodeUpserted(payload(type));

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(event, expect.anything());
    }
  });

  it('uses the persisted entity_type, not the payload type, when resolving the event', async () => {
    // createOrUpdateNode is the authority on the stored discriminator: an
    // entity.update may omit entityType entirely.
    const { listener, send } = makeListener(false, 'Person');

    await listener.handleNodeUpserted(payload(undefined));

    expect(send).toHaveBeenCalledWith('person.updated', { personId: 'entity-1' });
  });

  it('fails the job via ack.fail() instead of swallowing a write failure into ack.done()', async () => {
    const { listener, send, createOrUpdateNode } = makeListener(true);
    createOrUpdateNode.mockRejectedValueOnce(new Error('boom'));
    const ack = makeAck();
    const handle = listener.handleNodeUpserted.bind(listener) as unknown as (
      p: Payload,
      a: Acknowledgement,
    ) => Promise<void>;

    await handle(payload('Concept'), ack);

    expect(ack.fail).toHaveBeenCalledWith(expect.any(Error));
    expect(ack.done).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('hands a field the payload omits to createOrUpdateNode as undefined, never null', async () => {
    // createOrUpdateNode reads `undefined` as "leave it" and `null` as "clear
    // it". This handler used to `?? null` every optional field, so an id-reuse
    // write cleared the row's linked key even when nothing upstream asked it to.
    const { listener, createOrUpdateNode } = makeListener(false, 'Person');

    await listener.handleNodeUpserted({
      ownerId: 'owner-1',
      node: { entityId: 'entity-1', entityType: 'Person', properties: { occupation: 'dentist' } },
    } as Payload);

    expect(createOrUpdateNode).toHaveBeenCalledTimes(1);
    const [, write] = createOrUpdateNode.mock.calls[0] as unknown as [string, Record<string, unknown>];
    for (const field of ['name', 'description', 'searchContent', 'linkedTable', 'linkedId']) {
      expect(write[field]).toBeUndefined();
    }

    expect(write).toMatchObject({ entityId: 'entity-1', properties: { occupation: 'dentist' } });
  });
});

describe('GraphEventService → queue → GraphEventListener → GraphUtilityService', () => {
  const OWNER = 'owner-1';
  const PERSON = 'person-1';
  const LINKED_ID = '6c1f7a52-9d1e-5b0a-8f3e-2a4b6c8d0e1f';

  /**
   * The real producer, the real handler and the real write, with only the
   * queue (a JSON round-trip, as pg-boss does) and the table (a Map) standing
   * in. Seeded with an imported Person carrying keys from writers the agent
   * never sees.
   */
  function pipeline() {
    const nodes = new InMemoryRepository<GraphNodeEntity>('entity_id');
    nodes.seed(
      Object.assign(new GraphNodeEntity(), {
        entity_id: PERSON,
        owner_user_id: OWNER,
        entity_type: 'Person',
        outgoing_relationships: [],
        name: 'Alex Rivera',
        description: 'Google Contacts card',
        properties: { phones: ['+15551230001', '+15551230002'], planner: { trust_mode: 'ask' } },
        dossier: null,
        search_content: 'Alex Rivera',
        linked_table: 'import:google-contacts',
        linked_id: LINKED_ID,
        is_active: true,
        is_archived: false,
      }),
    );
    const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const graphUtility = new GraphUtilityService(
      nodes as never,
      new InMemoryRepository<RelationshipEntity>('relationship_id') as never,
      logger as never,
    );
    const listener = new GraphEventListener(
      graphUtility,
      { send: jest.fn(async () => ['job']) } as never,
      logger as never,
    );

    const queued: unknown[] = [];
    const producer = new GraphEventService(
      {
        send: jest.fn(async (event: string, body: unknown) => {
          if (event === Events.GRAPH_NODE_UPSERTED) {
            queued.push(JSON.parse(JSON.stringify(body)));
          }

          return ['job'];
        }),
      } as never,
      logger as never,
    );

    const drain = async () => {
      for (const body of queued.splice(0)) {
        await listener.handleNodeUpserted(body as Payload);
      }
    };

    return { nodes, producer, drain };
  }

  it('a partial write leaves the linked key, the name and the unsent properties where they were', async () => {
    const { nodes, producer, drain } = pipeline();

    await producer.upsertNode(OWNER, {
      entityId: PERSON,
      entityType: 'Person',
      properties: { occupation: 'dentist' },
      mergeProperties: true,
    });
    await drain();

    expect(nodes.get(PERSON)).toMatchObject({
      entity_type: 'Person',
      name: 'Alex Rivera',
      description: 'Google Contacts card',
      search_content: 'Alex Rivera',
      linked_table: 'import:google-contacts',
      linked_id: LINKED_ID,
      properties: {
        phones: ['+15551230001', '+15551230002'],
        planner: { trust_mode: 'ask' },
        occupation: 'dentist',
      },
    });
  });

  it('removeProperties reaches the write and is applied to the row as it then is', async () => {
    const { nodes, producer, drain } = pipeline();

    await producer.upsertNode(OWNER, {
      entityId: PERSON,
      entityType: 'Person',
      removeProperties: ['planner'],
    });
    // Another writer lands while the event is still queued.
    nodes.seed({
      ...nodes.get(PERSON)!,
      properties: { ...nodes.get(PERSON)!.properties, avatar_url: 'a.png' },
    });
    await drain();

    expect(nodes.get(PERSON)?.properties).toEqual({
      phones: ['+15551230001', '+15551230002'],
      avatar_url: 'a.png',
    });
  });
});
