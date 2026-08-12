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
      traverseGraph?: jest.Mock;
      getEntityTypeCounts?: jest.Mock;
    } = {},
  ) {
    const graphQuery = {
      getNodes: overrides.getNodes ?? jest.fn(async () => []),
      getNodesByIds: overrides.getNodesByIds ?? jest.fn(async () => []),
      getUserEntity: overrides.getUserEntity ?? jest.fn(async () => null),
      getRelationships: overrides.getRelationships ?? jest.fn(async () => []),
      getEntityIdsByTagSources: overrides.getEntityIdsByTagSources ?? jest.fn(async () => []),
      getEntityIdsBySourceRecordIds: overrides.getEntityIdsBySourceRecordIds ?? jest.fn(async () => []),
      traverseGraph: overrides.traverseGraph ?? jest.fn(async () => ({ nodes: new Map(), edges: [] })),
      getEntityTypeCounts: overrides.getEntityTypeCounts ?? jest.fn(async () => []),
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

  // The frontend BFS-expands the graph from the owner's anchor entity, so the
  // capped node payload is filled from the anchor's traversed neighborhood
  // first and only topped up with recently created entities. A recency-only
  // page drops the (old) anchor once the account outgrows the cap, collapsing
  // the client's graph to empty.
  describe('anchor-neighborhood seeding', () => {
    const anchor = {
      entity_id: 'anchor',
      entity_type: 'Person',
      name: 'Me',
      description: null,
      properties: {},
    };

    function node(id: string, type = 'Concept') {
      return { entity_id: id, entity_type: type, name: id, description: null, properties: {} };
    }

    it('includes the anchor and its neighborhood ahead of recent entities', async () => {
      const getUserEntity = jest.fn(async () => anchor);
      const traverseGraph = jest.fn(async () => ({
        nodes: new Map([
          ['anchor', anchor],
          ['friend', node('friend', 'Person')],
        ]),
        edges: [],
      }));
      // The recency page misses the anchor and its neighbor entirely — the
      // shape of the original bug.
      const getNodes = jest.fn(async () => [node('recent-1'), node('recent-2')]);

      const { controller } = setup({ getUserEntity, traverseGraph, getNodes });

      const res = await controller.getGraphData(ctx, dataDto());

      expect(traverseGraph).toHaveBeenCalledWith(
        'user-1',
        ['anchor'],
        expect.objectContaining({ maxNodes: 200 }),
      );
      expect(res.data.nodes.map((n) => n.id)).toEqual(['anchor', 'friend', 'recent-1', 'recent-2']);
    });

    it('keeps the anchor under a type filter that excludes it, but drops excluded neighbors', async () => {
      const getUserEntity = jest.fn(async () => anchor);
      const traverseGraph = jest.fn(async () => ({
        nodes: new Map([
          ['anchor', anchor],
          ['friend', node('friend', 'Person')],
          ['cafe', node('cafe', 'Place')],
        ]),
        edges: [],
      }));
      const getNodes = jest.fn(async () => []);

      const { controller } = setup({ getUserEntity, traverseGraph, getNodes });

      // Selecting only `place` excludes Person — the anchor must survive
      // anyway, while the Person neighbor is dropped.
      const res = await controller.getGraphData(ctx, dataDto({ includeTypes: ['place'] }));

      expect(res.data.nodes.map((n) => n.id).sort()).toEqual(['anchor', 'cafe']);
    });

    it('skips the traversal and serves the recency page when the user has no anchor entity', async () => {
      const traverseGraph = jest.fn(async () => ({ nodes: new Map(), edges: [] }));
      const getNodes = jest.fn(async () => [node('recent-1')]);

      const { controller, graphQuery } = setup({ traverseGraph, getNodes });

      const res = await controller.getGraphData(ctx, dataDto());

      expect(graphQuery.traverseGraph).not.toHaveBeenCalled();
      expect(res.data.nodes.map((n) => n.id)).toEqual(['recent-1']);
    });
  });

  // The anchor neighborhood BFS is first-come-first-served over whatever edges
  // the anchor has — on a real account one dominant type (Persons) filled all
  // 200 slots while 183k Communications, 108k Events and 37k Content rows never
  // appeared. The overview must cap the neighborhood's share and give every
  // entity type in the account a slice of the remaining budget.
  describe('per-type representation', () => {
    const anchor = {
      entity_id: 'anchor',
      entity_type: 'Person',
      name: 'Me',
      description: null,
      properties: {},
    };

    function nodesOf(type: string, count: number) {
      return Array.from({ length: count }, (_, index) => ({
        entity_id: `${type.toLowerCase()}-${index}`,
        entity_type: type,
        name: `${type} ${index}`,
        description: null,
        properties: {},
      }));
    }

    it('caps the anchor neighborhood at half the budget and represents every type', async () => {
      // A neighborhood big enough to consume the whole 200-node budget on its own.
      const neighborhood = new Map([anchor, ...nodesOf('Person', 250)].map((node) => [node.entity_id, node]));
      const getUserEntity = jest.fn(async () => anchor);
      const traverseGraph = jest.fn(async () => ({ nodes: neighborhood, edges: [] }));
      const getEntityTypeCounts = jest.fn(async () => [
        { entityType: 'Communication', count: 183353 },
        { entityType: 'Event', count: 108792 },
        { entityType: 'Content', count: 37237 },
        { entityType: 'Person', count: 5943 },
        { entityType: 'Location', count: 102 },
        { entityType: 'Concept', count: 13 },
      ]);
      const getNodes = jest.fn(async (_owner: string, options: { entityType?: string; limit?: number }) =>
        options.entityType ? nodesOf(options.entityType, options.limit ?? 0) : [],
      );

      const { controller } = setup({ getUserEntity, traverseGraph, getEntityTypeCounts, getNodes });

      const res = await controller.getGraphData(ctx, dataDto());

      const byType = new Map<string, number>();
      for (const node of res.data.nodes) {
        byType.set(node.entity_type, (byType.get(node.entity_type) ?? 0) + 1);
      }

      // Every account type is present, and the neighborhood's Persons hold at
      // most half the budget (plus the per-type Person slice).
      for (const type of ['Communication', 'Event', 'Content', 'Person', 'Location', 'Concept']) {
        expect(byType.get(type) ?? 0).toBeGreaterThan(0);
      }

      expect(res.data.nodes.length).toBeLessThanOrEqual(200);
      expect(byType.get('Communication')).toBeGreaterThanOrEqual(15);
    });

    it('lets a scarce type donate its unused share to the plentiful ones', async () => {
      const getEntityTypeCounts = jest.fn(async () => [
        { entityType: 'Communication', count: 100000 },
        { entityType: 'Concept', count: 2 },
      ]);
      const getNodes = jest.fn(async (_owner: string, options: { entityType?: string; limit?: number }) => {
        if (options.entityType === 'Concept') {
          return nodesOf('Concept', 2);
        }

        if (options.entityType === 'Communication') {
          return nodesOf('Communication', options.limit ?? 0);
        }

        return [];
      });

      const { controller } = setup({ getEntityTypeCounts, getNodes });

      const res = await controller.getGraphData(ctx, dataDto());

      const conceptCount = res.data.nodes.filter((n) => n.entity_type === 'Concept').length;
      const commCount = res.data.nodes.filter((n) => n.entity_type === 'Communication').length;

      expect(conceptCount).toBe(2);
      // Concept could not use its ~half share; Communication absorbs the rest
      // of the 200-node budget.
      expect(commCount).toBe(198);
    });

    it('excludes deselected types from the per-type fill', async () => {
      const getEntityTypeCounts = jest.fn(async () => [
        { entityType: 'Communication', count: 1000 },
        { entityType: 'Person', count: 50 },
      ]);
      const getNodes = jest.fn(async (_owner: string, options: { entityType?: string; limit?: number }) =>
        options.entityType ? nodesOf(options.entityType, Math.min(options.limit ?? 0, 50)) : [],
      );

      const { controller } = setup({ getEntityTypeCounts, getNodes });

      // Selecting only `person` excludes Communication.
      const res = await controller.getGraphData(ctx, dataDto({ includeTypes: ['person'] }));

      expect(res.data.nodes.some((n) => n.entity_type === 'Communication')).toBe(false);
      expect(res.data.nodes.some((n) => n.entity_type === 'Person')).toBe(true);
    });
  });

  // The overview is capped at 200 nodes (anchor neighborhood + recency top-up),
  // so a tag/event match beyond the cap would be absent from the node payload
  // even though the client scopes to its id. The controller recovers those by id.
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
        {
          entity_id: 'place-node',
          entity_type: 'Location',
          name: 'Q',
          description: null,
          properties: {},
        },
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

  // The node payload is capped, so the relationship payload must be too: an
  // unscoped fetch shipped the account's entire relationship table (100k+ rows
  // with real imports), whose dangling links the client can never render but
  // still pays to index — freezing the graph view and blocking navigation
  // away from it (#1598).
  describe('relationship payload', () => {
    it('scopes the relationship fetch to the node payload and drops dangling links', async () => {
      const getNodes = jest.fn(async () => [
        { entity_id: 'node-a', entity_type: 'Person', name: 'A', description: null, properties: {} },
        { entity_id: 'node-b', entity_type: 'Place', name: 'B', description: null, properties: {} },
      ]);
      const getRelationships = jest.fn(async () => [
        // Both endpoints in the payload — kept.
        {
          relationship_id: 'r-in',
          from_entity_id: 'node-a',
          to_entity_id: 'node-b',
          relationship_type: 'VISITED',
          strength: 0.7,
          properties: {},
        },
        // One endpoint outside the capped payload — dangling, dropped.
        {
          relationship_id: 'r-dangling',
          from_entity_id: 'node-a',
          to_entity_id: 'outside-the-cap',
          relationship_type: 'RELATED_TO',
          strength: 0.5,
          properties: {},
        },
      ]);

      const { controller } = setup({ getNodes, getRelationships });

      const res = await controller.getGraphData(ctx, dataDto());

      expect(getRelationships).toHaveBeenCalledWith('user-1', {
        entityIds: expect.arrayContaining(['node-a', 'node-b']),
        direction: 'both',
      });
      expect(res.data.links.map((link) => link.id)).toEqual(['r-in']);
    });

    it('skips the relationship fetch entirely when the node payload is empty', async () => {
      const { controller, graphQuery } = setup();

      const res = await controller.getGraphData(ctx, dataDto());

      expect(graphQuery.getRelationships).not.toHaveBeenCalled();
      expect(res.data.links).toEqual([]);
    });
  });
});
