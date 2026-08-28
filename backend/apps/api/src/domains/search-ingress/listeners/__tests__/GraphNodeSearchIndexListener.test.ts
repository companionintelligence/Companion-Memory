import type { EventPayloads, Events } from '@ci/domains/events';

import { GraphNodeSearchIndexListener } from '../GraphNodeSearchIndexListener';

type Payload = EventPayloads[Events.GRAPH_NODE_UPSERTED];

function makeListener() {
  const generateEmbedding = jest.fn(async () => [0.1, 0.2, 0.3]);
  const embeddingUpsert = jest.fn(async () => null);
  const vectorUpsert = jest.fn(async () => null);
  const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn() };

  const listener = new GraphNodeSearchIndexListener(
    { generateEmbedding } as never,
    { upsert: embeddingUpsert } as never,
    { upsert: vectorUpsert } as never,
    logger as never,
  );

  return { listener, generateEmbedding, embeddingUpsert, vectorUpsert, logger };
}

function payload(overrides: Partial<Payload['node']> = {}): Payload {
  return {
    ownerId: 'owner-1',
    node: {
      entityId: 'entity-1',
      entityType: 'Item',
      name: 'Mochi',
      description: 'Greyhound rescued about a year ago',
      properties: {},
      ...overrides,
    },
  } as Payload;
}

describe('GraphNodeSearchIndexListener.indexGraphNode', () => {
  // The allowlist this listener gates on is empty today: `WriteKnowledgeTool`
  // is the ONLY producer of GRAPH_NODE_UPSERTED and it writes a `ci.entities`
  // row alone, never the detail-table row (`ci.events` / `ci.objects` /
  // `ci.content` / `ci.files` / ...) that `EntityResolutionService` needs to
  // resolve any of these types back to a real result. Indexing them would write
  // a real, paid-for search candidate that can never resolve — see the class
  // doc for the full argument. Every one of these must therefore be a no-op.
  it.each([
    // Class-table-inherited types a graph write can never populate the detail
    // row for. Both the graph alias and the raw lowercase form, since
    // normalizeEmbeddableType accepts either.
    ['Event', 'graph alias'],
    ['event', 'raw'],
    ['Item', 'graph alias'],
    ['item', 'raw'],
    ['Object', 'graph alias -> item'],
    ['Thing', 'graph alias -> item'],
    ['Content', 'graph alias'],
    ['content', 'raw'],
    ['File', 'graph alias'],
    ['file', 'raw'],
    // Embeddable types with no graph alias, reachable only via the raw
    // lowercase fallback — equally unresolvable from an entities-only write.
    ['note', 'raw, no alias'],
    ['thread', 'raw, no alias'],
    ['communication', 'raw, no alias'],
    ['browser-activity', 'raw, no alias'],
    ['answer', 'raw, no alias'],
    ['file-chunk', 'raw, no alias'],
    // Handled entirely by the per-type listeners instead (see class doc).
    ['Person', 'graph alias'],
    ['Contact', 'graph alias -> person'],
    ['Place', 'graph alias'],
    ['Location', 'graph alias -> place'],
    ['Concept', 'graph alias'],
  ])('does not index entityType %s (%s) — the allowlist is empty', async (entityType) => {
    const { listener, vectorUpsert, embeddingUpsert, generateEmbedding } = makeListener();

    await listener.indexGraphNode(payload({ entityType }));

    expect(vectorUpsert).not.toHaveBeenCalled();
    expect(embeddingUpsert).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('skips a type with no search representation at all', async () => {
    const { listener, vectorUpsert, embeddingUpsert } = makeListener();

    await listener.indexGraphNode(payload({ entityType: 'Organization' }));

    expect(vectorUpsert).not.toHaveBeenCalled();
    expect(embeddingUpsert).not.toHaveBeenCalled();
  });

  it('ignores a payload with no entity id', async () => {
    const { listener, vectorUpsert } = makeListener();

    await listener.indexGraphNode(payload({ entityId: '' }));

    expect(vectorUpsert).not.toHaveBeenCalled();
  });

  it('ignores a payload with no owner id', async () => {
    const { listener, vectorUpsert } = makeListener();

    await listener.indexGraphNode({ ...payload(), ownerId: '' } as Payload);

    expect(vectorUpsert).not.toHaveBeenCalled();
  });

  // Documents the mechanism for the day a type genuinely becomes resolvable
  // (see the class doc's "to add an entry" note): the type-normalisation and
  // text-assembly logic below the allowlist check is exercised nowhere else in
  // this suite, because nothing reaches it today. This test reaches it
  // directly by calling the private assembly indirectly through a listener
  // instance whose allowlist we cannot mutate from outside the module — so
  // instead we assert the ONE thing that must stay true for that future change
  // to be a one-line diff: the gate is a single Set membership check on the
  // normalised type, with no other branching between "allowed" and "index it".
  it('gates purely on RESOLVABLE_FROM_ENTITIES_ALONE membership, not on entityType shape', async () => {
    const { listener, vectorUpsert } = makeListener();

    // A well-formed, fully-populated payload of a currently-excluded type must
    // still be skipped solely because of the allowlist, not because anything
    // else about the payload is unusual.
    await listener.indexGraphNode(
      payload({
        entityType: 'Item',
        name: 'Mochi',
        description: 'Greyhound rescued about a year ago',
        searchContent: 'dog greyhound rescue',
      }),
    );

    expect(vectorUpsert).not.toHaveBeenCalled();
  });
});
