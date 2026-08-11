import type { RequestContext } from '@ci/common/context';

import { GraphController } from '../GraphController';

/**
 * Covers the focus endpoint's communication augmentation.
 *
 * Participant linking writes `ci.communications.from_entity_id`/`to_entity_ids`
 * and never inserts `ci.relationships` rows, so the relationship traversal
 * alone can never surface a person's emails/messages. `getNodeDetails`
 * synthesizes those edges from the communication ties — this pins down that
 * they land in the subgraph (and the relationships list) with the right
 * direction and type, without duplicating nodes the traversal already found.
 */
describe('GraphController — focus-mode communication ties', () => {
  const ctx = { userId: 'user-1' } as RequestContext;

  // Real uuids: resolveNode drops non-uuid ids before ever hitting the store.
  const PERSON_ID = '00000000-0000-0000-0000-0000000000a1';
  const COMM_ID = '00000000-0000-0000-0000-0000000000b1';

  function node(id: string, type: string, name: string) {
    return { entity_id: id, entity_type: type, name, description: null, properties: {} };
  }

  function setup(
    overrides: {
      getNode?: jest.Mock;
      traverseGraph?: jest.Mock;
      getCommunicationTiesForPerson?: jest.Mock;
      getPersonTiesForCommunication?: jest.Mock;
    } = {},
  ) {
    const graphQuery = {
      getNode: overrides.getNode ?? jest.fn(async () => null),
      traverseGraph: overrides.traverseGraph ?? jest.fn(async () => ({ nodes: new Map(), edges: [] })),
      getEntityIdsByTagSources: jest.fn(async () => []),
      getCommunicationTiesForPerson: overrides.getCommunicationTiesForPerson ?? jest.fn(async () => []),
      getPersonTiesForCommunication: overrides.getPersonTiesForCommunication ?? jest.fn(async () => []),
    };

    const controller = new GraphController(
      {} as never, // graphEvents
      graphQuery as never,
      {} as never, // graphUtility
      {} as never, // userContext
      {} as never, // tagService
      {} as never, // eventService
    );

    return { controller, graphQuery };
  }

  const query = { entityId: PERSON_ID, maxDepth: 1, maxNodes: 100, maxEdges: 250 };

  it('merges a person’s communications into the focus subgraph as SENT/RECEIVED edges', async () => {
    const person = node(PERSON_ID, 'Person', 'Liam');
    const sent = node(COMM_ID, 'Communication', 'Re: the plan');
    const received = node('00000000-0000-0000-0000-0000000000b2', 'Communication', 'Fwd: notes');

    const { controller, graphQuery } = setup({
      getNode: jest.fn(async () => person),
      traverseGraph: jest.fn(async () => ({ nodes: new Map([[PERSON_ID, person]]), edges: [] })),
      getCommunicationTiesForPerson: jest.fn(async () => [
        { node: sent, isSender: true },
        { node: received, isSender: false },
      ]),
    });

    const res = await controller.getNodeDetails(ctx, query);

    expect(graphQuery.getCommunicationTiesForPerson).toHaveBeenCalledWith(
      'user-1',
      PERSON_ID,
      expect.any(Number),
    );

    expect(res.subgraph.nodes.map((n) => n.id).sort()).toEqual(
      [PERSON_ID, sent.entity_id, received.entity_id].sort(),
    );

    const types = new Map(res.subgraph.links.map((link) => [link.target, link.relationship_type]));
    expect(types.get(sent.entity_id)).toBe('SENT');
    expect(types.get(received.entity_id)).toBe('RECEIVED');
    // Both edges run person → communication.
    expect(res.subgraph.links.every((link) => link.source === PERSON_ID)).toBe(true);

    // The relationships list carries them too, with the communication as the other entity.
    const others = res.relationships.map((rel) => rel.otherEntity?.entityId).sort();
    expect(others).toEqual([sent.entity_id, received.entity_id].sort());
  });

  it('does not duplicate a communication node the traversal already returned', async () => {
    const person = node(PERSON_ID, 'Person', 'Liam');
    const comm = node(COMM_ID, 'Communication', 'Re: the plan');

    const { controller } = setup({
      getNode: jest.fn(async () => person),
      traverseGraph: jest.fn(async () => ({
        nodes: new Map([
          [PERSON_ID, person],
          [COMM_ID, comm],
        ]),
        edges: [],
      })),
      getCommunicationTiesForPerson: jest.fn(async () => [{ node: comm, isSender: true }]),
    });

    const res = await controller.getNodeDetails(ctx, query);

    expect(res.subgraph.nodes.filter((n) => n.id === COMM_ID)).toHaveLength(1);
    expect(res.subgraph.links).toHaveLength(1);
  });

  it('pulls the linked persons when the focused node is a communication', async () => {
    const comm = node(COMM_ID, 'Communication', 'Re: the plan');
    const sender = node(PERSON_ID, 'Person', 'Liam');

    const { controller, graphQuery } = setup({
      getNode: jest.fn(async () => comm),
      traverseGraph: jest.fn(async () => ({ nodes: new Map([[COMM_ID, comm]]), edges: [] })),
      getPersonTiesForCommunication: jest.fn(async () => [{ node: sender, isSender: true }]),
    });

    const res = await controller.getNodeDetails(ctx, { ...query, entityId: COMM_ID });

    expect(graphQuery.getPersonTiesForCommunication).toHaveBeenCalledWith('user-1', COMM_ID);
    expect(res.subgraph.nodes.map((n) => n.id).sort()).toEqual([COMM_ID, PERSON_ID].sort());
    // The synthesized edge still runs person → communication.
    expect(res.subgraph.links).toEqual([
      expect.objectContaining({
        source: PERSON_ID,
        target: COMM_ID,
        relationship_type: 'SENT',
      }),
    ]);
  });

  it('queries no communication ties for other entity types', async () => {
    const concept = node(PERSON_ID, 'Concept', 'Sailing');

    const { controller, graphQuery } = setup({
      getNode: jest.fn(async () => concept),
      traverseGraph: jest.fn(async () => ({ nodes: new Map([[PERSON_ID, concept]]), edges: [] })),
    });

    await controller.getNodeDetails(ctx, query);

    expect(graphQuery.getCommunicationTiesForPerson).not.toHaveBeenCalled();
    expect(graphQuery.getPersonTiesForCommunication).not.toHaveBeenCalled();
  });
});
