import type { RequestContext } from '@ci/common/context';

import { GraphController } from '../GraphController';

/**
 * Covers the explorer filter contracts the graph `data` endpoint honors so the
 * graph reflects the same subset as List/Gallery/Map:
 *
 *  - `tags`: an absent param leaves the filter inactive (whole graph), while a
 *    present param — even empty or resolving to nothing — is active with a
 *    (possibly empty) match set. Also verifies the relay-id/linked-id
 *    reconciliation: tagged source ids are forwarded to the graph lookup, with
 *    non-uuid ids dropped.
 *  - event-scoped dimensions (connectors / who / where / how / date range):
 *    when set, the matching events are resolved to graph nodes and expanded one
 *    hop, so the graph keeps the people/places the events connect to.
 */
describe('GraphController — explorer filters (graph parity)', () => {
  const ctx = { userId: 'user-1' } as RequestContext;

  // A full, valid GraphDataDto with every dimension off; tests turn on the
  // dimension under test via overrides.
  function dataDto(overrides: Record<string, unknown> = {}) {
    return {
      includeTypes: undefined,
      tags: undefined,
      connectors: undefined,
      people: undefined,
      places: undefined,
      eventTypes: undefined,
      hasLocation: false,
      from: undefined,
      to: undefined,
      ...overrides,
    } as Parameters<GraphController['getGraphData']>[1];
  }

  function setup(
    overrides: {
      getNodes?: jest.Mock;
      getNodesByIds?: jest.Mock;
      getUserEntity?: jest.Mock;
      getEntitiesForTags?: jest.Mock;
      getEntityIdsByTagSources?: jest.Mock;
      getEntityIdsBySourceRecordIds?: jest.Mock;
      getRelationships?: jest.Mock;
      getEntitiesForEvents?: jest.Mock;
    } = {},
  ) {
    const graphQuery = {
      getNodes: overrides.getNodes ?? jest.fn(async () => []),
      getNodesByIds: overrides.getNodesByIds ?? jest.fn(async () => []),
      getUserEntity: overrides.getUserEntity ?? jest.fn(async () => null),
      getRelationships: overrides.getRelationships ?? jest.fn(async () => []),
      getEntityIdsByTagSources: overrides.getEntityIdsByTagSources ?? jest.fn(async () => []),
      getEntityIdsBySourceRecordIds: overrides.getEntityIdsBySourceRecordIds ?? jest.fn(async () => []),
    };

    const tagService = {
      getEntitiesForTags: overrides.getEntitiesForTags ?? jest.fn(async () => []),
    };

    const eventService = {
      getEntitiesForEvents: overrides.getEntitiesForEvents ?? jest.fn(async () => []),
    };

    const controller = new GraphController(
      {} as never, // graphEvents
      graphQuery as never,
      {} as never, // graphUtility
      {} as never, // userContext
      tagService as never,
      eventService as never,
    );

    return { controller, graphQuery, tagService, eventService };
  }

  describe('tags', () => {
    it('leaves the filter inactive when the tags param is absent', async () => {
      const { controller, graphQuery, tagService } = setup();

      const res = await controller.getGraphData(ctx, dataDto({ tags: undefined }));

      expect(res.tagMatch).toEqual({ active: false, entityIds: [] });
      expect(tagService.getEntitiesForTags).not.toHaveBeenCalled();
      expect(graphQuery.getEntityIdsByTagSources).not.toHaveBeenCalled();
    });

    it('treats a present-but-empty param as active with an empty match set', async () => {
      const { controller, tagService } = setup();

      const res = await controller.getGraphData(ctx, dataDto({ tags: '' }));

      expect(res.tagMatch).toEqual({ active: true, entityIds: [] });
      expect(tagService.getEntitiesForTags).not.toHaveBeenCalled();
    });

    it('resolves labels to graph entity_ids and drops non-uuid source ids', async () => {
      const personId = '00000000-0000-0000-0000-000000000001';
      const contentId = '00000000-0000-0000-0000-000000000002';

      const getEntitiesForTags = jest.fn(async () => [
        { type: 'person', id: personId }, // tag id == graph entity_id
        { type: 'content', id: contentId }, // tag id == graph linked_id
        { type: 'communication', id: 'composite:not-a-uuid' }, // never a graph node
      ]);
      const getEntityIdsByTagSources = jest.fn(async () => ['node-a', 'node-b']);

      const { controller } = setup({ getEntitiesForTags, getEntityIdsByTagSources });

      const res = await controller.getGraphData(ctx, dataDto({ tags: 'work, urgent ' }));

      expect(getEntitiesForTags).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), [
        'work',
        'urgent',
      ]);
      expect(getEntityIdsByTagSources).toHaveBeenCalledWith('user-1', [personId, contentId]);
      expect(res.tagMatch).toEqual({ active: true, entityIds: ['node-a', 'node-b'] });
    });

    it('stays active-but-empty (no node lookup) when no tagged id is a uuid', async () => {
      const getEntitiesForTags = jest.fn(async () => [{ type: 'communication', id: 'composite-id' }]);
      const getEntityIdsByTagSources = jest.fn(async () => ['unexpected']);

      const { controller } = setup({ getEntitiesForTags, getEntityIdsByTagSources });

      const res = await controller.getGraphData(ctx, dataDto({ tags: 'phone' }));

      expect(res.tagMatch).toEqual({ active: true, entityIds: [] });
      expect(getEntityIdsByTagSources).not.toHaveBeenCalled();
    });
  });

  describe('event-scoped dimensions', () => {
    it('leaves the event match inactive when no event dimension is set', async () => {
      const { controller, eventService } = setup();

      const res = await controller.getGraphData(ctx, dataDto());

      expect(res.eventMatch).toEqual({ active: false, entityIds: [] });
      expect(eventService.getEntitiesForEvents).not.toHaveBeenCalled();
    });

    it('resolves matching events to graph nodes and expands one hop', async () => {
      const eventId = '00000000-0000-0000-0000-0000000000aa';

      const getEntitiesForEvents = jest.fn(async () => [{ id: eventId, type: 'event' }]);
      const getEntityIdsBySourceRecordIds = jest.fn(async () => ['evt-node']);
      // The matching event connects to a person and a place — both should be
      // pulled into the scope by the one-hop expansion.
      const getRelationships = jest.fn(async () => [
        { from_entity_id: 'evt-node', to_entity_id: 'person-node', relationship_id: 'r1' },
        { from_entity_id: 'place-node', to_entity_id: 'evt-node', relationship_id: 'r2' },
        { from_entity_id: 'unrelated-a', to_entity_id: 'unrelated-b', relationship_id: 'r3' },
      ]);

      const { controller, eventService } = setup({
        getEntitiesForEvents,
        getEntityIdsBySourceRecordIds,
        getRelationships,
      });

      const res = await controller.getGraphData(ctx, dataDto({ connectors: ['gmail'] }));

      expect(eventService.getEntitiesForEvents).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({ connectors: ['gmail'] }),
      );
      expect(getEntityIdsBySourceRecordIds).toHaveBeenCalledWith('user-1', [eventId]);
      expect(res.eventMatch.active).toBe(true);
      expect(new Set(res.eventMatch.entityIds)).toEqual(new Set(['evt-node', 'person-node', 'place-node']));
    });

    it('is active with an empty match set when the filters match no events', async () => {
      const getEntitiesForEvents = jest.fn(async () => []);
      const getEntityIdsBySourceRecordIds = jest.fn(async () => ['unexpected']);

      const { controller } = setup({ getEntitiesForEvents, getEntityIdsBySourceRecordIds });

      const res = await controller.getGraphData(ctx, dataDto({ people: ['Ada'] }));

      expect(res.eventMatch).toEqual({ active: true, entityIds: [] });
      expect(getEntityIdsBySourceRecordIds).not.toHaveBeenCalled();
    });
  });

  // The unfiltered overview is capped at 200 nodes with no inherent ordering, so
  // a tag/event match beyond the cap would be absent from the node payload even
  // though the client scopes to its id. The controller recovers those by id.
  describe('filter-match node payload', () => {
    it('unions filter-matched nodes the capped overview missed, fetched by id', async () => {
      const getEntitiesForTags = jest.fn(async () => [
        { type: 'person', id: '00000000-0000-0000-0000-000000000001' },
      ]);
      const getEntityIdsByTagSources = jest.fn(async () => ['node-a', 'node-b']);
      // The cap returned node-a but dropped node-b; node-b must be recovered.
      const getNodes = jest.fn(async () => [
        { entity_id: 'node-a', entity_type: 'Person', name: 'A', description: null, properties: {} },
      ]);
      const getNodesByIds = jest.fn(async () => [
        { entity_id: 'node-b', entity_type: 'Person', name: 'B', description: null, properties: {} },
      ]);

      const { controller } = setup({
        getEntitiesForTags,
        getEntityIdsByTagSources,
        getNodes,
        getNodesByIds,
      });

      const res = await controller.getGraphData(ctx, dataDto({ tags: 'work' }));

      expect(getNodesByIds).toHaveBeenCalledWith('user-1', ['node-b']);
      expect(res.data.nodes.map((node) => node.id).sort()).toEqual(['node-a', 'node-b']);
    });

    it('does not reintroduce a type-excluded node via the by-id fetch', async () => {
      const getEntitiesForTags = jest.fn(async () => [
        { type: 'person', id: '00000000-0000-0000-0000-000000000001' },
      ]);
      const getEntityIdsByTagSources = jest.fn(async () => ['person-node', 'place-node']);
      const getNodes = jest.fn(async () => []); // cap missed both matches
      const getNodesByIds = jest.fn(async () => [
        { entity_id: 'person-node', entity_type: 'Person', name: 'P', description: null, properties: {} },
        { entity_id: 'place-node', entity_type: 'Place', name: 'Q', description: null, properties: {} },
      ]);

      const { controller } = setup({ getEntitiesForTags, getEntityIdsByTagSources, getNodes, getNodesByIds });

      // Selecting only `person` excludes Place from the graph; the tag-matched
      // place node must stay dropped even though it matches the tag filter.
      const res = await controller.getGraphData(ctx, dataDto({ includeTypes: ['person'], tags: 'work' }));

      expect(res.data.nodes.map((node) => node.id)).toEqual(['person-node']);
    });

    it('flags truncated only when the overview hits the node cap', async () => {
      const cappedNodes = Array.from({ length: 200 }, (_, index) => ({
        entity_id: `n-${index}`,
        entity_type: 'Person',
        name: null,
        description: null,
        properties: {},
      }));

      const { controller: capped } = setup({ getNodes: jest.fn(async () => cappedNodes) });
      const cappedRes = await capped.getGraphData(ctx, dataDto());
      expect(cappedRes.truncated).toBe(true);

      const { controller: small } = setup();
      const smallRes = await small.getGraphData(ctx, dataDto());
      expect(smallRes.truncated).toBe(false);
    });
  });
});
