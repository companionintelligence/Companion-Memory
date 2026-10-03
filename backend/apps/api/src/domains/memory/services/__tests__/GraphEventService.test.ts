import { Events } from '@ci/domains/events';

import { GraphEventService } from '../GraphEventService';

/**
 * What `GraphEventService` puts on the queue. pg-boss carries the payload as
 * JSON, so every assertion here reads it back through a JSON round-trip, the
 * way `GraphEventListener` will: an `undefined` field is simply absent on the
 * far side and means "leave the stored value alone", while a `null` survives
 * and means "clear it". This service used to write `?? null` for every
 * optional field, which is how an id-reuse `memory.remember` cleared an
 * imported row's linked key.
 */

function setup() {
  const send = jest.fn(async (_event: string, _payload: unknown) => ['job-1']);
  const service = new GraphEventService({ send } as never, { setContext: jest.fn() } as never);

  /** The payload of the n-th send, as the consumer will receive it. */
  const wire = (call = 0) =>
    JSON.parse(JSON.stringify(send.mock.calls[call][1])) as { ownerId: string } & Record<string, unknown>;

  return { service, send, wire };
}

describe('GraphEventService.upsertNode', () => {
  it('leaves a field the caller did not set out of the event, instead of sending null', async () => {
    const { service, send, wire } = setup();

    await service.upsertNode('owner-1', {
      entityId: 'node-1',
      entityType: 'Person',
      properties: { occupation: 'dentist' },
      mergeProperties: true,
    });

    expect(send).toHaveBeenCalledWith(Events.GRAPH_NODE_UPSERTED, expect.anything());
    // Exact: no name / description / searchContent / linkedTable / linkedId key at all.
    expect(wire().node).toEqual({
      entityId: 'node-1',
      entityType: 'Person',
      properties: { occupation: 'dentist' },
      mergeProperties: true,
    });
  });

  it('carries an explicit null, which is how a caller asks for a field to be cleared', async () => {
    const { service, wire } = setup();

    await service.upsertNode('owner-1', {
      entityId: 'node-1',
      entityType: 'Person',
      description: null,
      linkedTable: null,
      linkedId: null,
    });

    expect(wire().node).toMatchObject({ description: null, linkedTable: null, linkedId: null });
  });

  it('forwards the property-write instructions for the listener to apply at write time', async () => {
    const { service, wire } = setup();

    await service.upsertNode('owner-1', {
      entityId: 'node-1',
      entityType: 'Person',
      properties: { level: 'x' },
      mergeProperties: false,
      removeProperties: ['stale'],
    });

    expect(wire().node).toMatchObject({ mergeProperties: false, removeProperties: ['stale'] });
  });

  it('mints an id for a new node and returns the one it sent', async () => {
    const { service, wire } = setup();

    const { entityId } = await service.upsertNode('owner-1', { entityType: 'Concept', name: 'Pilates' });

    expect(entityId).toEqual(expect.any(String));
    expect(wire().node).toMatchObject({ entityId, name: 'Pilates' });
  });
});

describe('GraphEventService.upsertRelationship', () => {
  it('leaves unset properties, strength and direction out of the event', async () => {
    const { service, wire } = setup();

    await service.upsertRelationship('owner-1', {
      relationshipId: 'edge-1',
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      mergeProperties: true,
    });

    expect(wire().relationship).toEqual({
      relationshipId: 'edge-1',
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      mergeProperties: true,
    });
  });

  it('forwards removeProperties', async () => {
    const { service, wire } = setup();

    await service.upsertRelationship('owner-1', {
      relationshipId: 'edge-1',
      fromEntityId: 'from-1',
      toEntityId: 'to-1',
      relationshipType: 'KNOWS',
      removeProperties: ['source'],
    });

    expect(wire().relationship).toMatchObject({ removeProperties: ['source'] });
  });
});
