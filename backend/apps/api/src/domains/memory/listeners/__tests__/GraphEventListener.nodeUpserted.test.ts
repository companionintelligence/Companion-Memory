import type { Acknowledgement, EventPayloads, Events } from '@ci/domains/events';

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
});
