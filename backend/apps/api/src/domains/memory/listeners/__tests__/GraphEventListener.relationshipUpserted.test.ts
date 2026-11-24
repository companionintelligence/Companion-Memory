import type { Acknowledgement, EventPayloads, Events } from '@ci/domains/events';

import { GraphEventListener } from '../GraphEventListener';

type Payload = EventPayloads[Events.GRAPH_RELATIONSHIP_UPSERTED];

function makeAck(): Acknowledgement {
  return { jobId: 'test-job', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

function makeListener() {
  const createOrUpdateRelationship = jest.fn(async () => ({
    relationship: { relationship_id: 'rel-1' },
    created: true,
  }));
  const send = jest.fn(async () => ['job-1']);
  const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };

  const listener = new GraphEventListener(
    { createOrUpdateRelationship } as never,
    { send } as never,
    logger as never,
  );

  return { listener, createOrUpdateRelationship, send, logger };
}

function payload(): Payload {
  return {
    ownerId: 'owner-1',
    relationship: {
      relationshipId: 'rel-1',
      fromEntityId: 'entity-1',
      toEntityId: 'entity-2',
      relationshipType: 'KNOWS',
      properties: {},
    },
  } as Payload;
}

describe('GraphEventListener.handleRelationshipUpserted', () => {
  it('passes an omitted properties bag through as undefined, and forwards removeProperties', async () => {
    const { listener, createOrUpdateRelationship } = makeListener();

    await listener.handleRelationshipUpserted({
      ownerId: 'owner-1',
      relationship: {
        relationshipId: 'rel-1',
        fromEntityId: 'entity-1',
        toEntityId: 'entity-2',
        relationshipType: 'KNOWS',
        mergeProperties: true,
        removeProperties: ['source'],
      },
    } as Payload);

    const [, write] = createOrUpdateRelationship.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(write.properties).toBeUndefined();
    expect(write.strength).toBeUndefined();
    expect(write.isBidirectional).toBeUndefined();
    expect(write).toMatchObject({ mergeProperties: true, removeProperties: ['source'] });
  });

  it('writes the relationship via GraphUtilityService.createOrUpdateRelationship', async () => {
    const { listener, createOrUpdateRelationship } = makeListener();

    await listener.handleRelationshipUpserted(payload());

    expect(createOrUpdateRelationship).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        relationshipId: 'rel-1',
        fromEntityId: 'entity-1',
        toEntityId: 'entity-2',
        relationshipType: 'KNOWS',
      }),
    );
  });

  it('fails the job via ack.fail() instead of swallowing a write failure into ack.done()', async () => {
    const { listener, createOrUpdateRelationship } = makeListener();
    createOrUpdateRelationship.mockRejectedValueOnce(new Error('boom'));
    const ack = makeAck();
    const handle = listener.handleRelationshipUpserted.bind(listener) as unknown as (
      p: Payload,
      a: Acknowledgement,
    ) => Promise<void>;

    await handle(payload(), ack);

    expect(ack.fail).toHaveBeenCalledWith(expect.any(Error));
    expect(ack.done).not.toHaveBeenCalled();
  });
});
