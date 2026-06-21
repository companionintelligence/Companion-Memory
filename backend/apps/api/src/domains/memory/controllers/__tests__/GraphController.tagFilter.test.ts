import type { RequestContext } from '@ci/common/context';

import { GraphController } from '../GraphController';

/**
 * Covers the `tags` URL-param contract for the graph data endpoint: an absent
 * param leaves the filter inactive (whole graph), while a present param — even
 * empty or resolving to nothing — is active with a (possibly empty) match set.
 * Also verifies the relay-id/linked-id reconciliation handoff: tagged source
 * ids are forwarded to the graph lookup, with non-uuid ids dropped.
 */
describe('GraphController — tag filter (graph parity)', () => {
  const ctx = { userId: 'user-1' } as RequestContext;

  function setup(
    overrides: {
      getEntitiesForTags?: jest.Mock;
      getEntityIdsByTagSources?: jest.Mock;
    } = {},
  ) {
    const graphQuery = {
      getNodes: jest.fn(async () => []),
      getRelationships: jest.fn(async () => []),
      getEntityIdsByTagSources: overrides.getEntityIdsByTagSources ?? jest.fn(async () => []),
    };

    const tagService = {
      getEntitiesForTags: overrides.getEntitiesForTags ?? jest.fn(async () => []),
    };

    const controller = new GraphController(
      {} as never, // graphEvents
      graphQuery as never,
      {} as never, // graphUtility
      {} as never, // userContext
      tagService as never,
    );

    return { controller, graphQuery, tagService };
  }

  it('leaves the filter inactive when the tags param is absent', async () => {
    const { controller, graphQuery, tagService } = setup();

    const res = await controller.getGraphData(ctx, { tags: undefined });

    expect(res.tagMatch).toEqual({ active: false, entityIds: [] });
    expect(tagService.getEntitiesForTags).not.toHaveBeenCalled();
    expect(graphQuery.getEntityIdsByTagSources).not.toHaveBeenCalled();
  });

  it('treats a present-but-empty param as active with an empty match set', async () => {
    const { controller, tagService } = setup();

    const res = await controller.getGraphData(ctx, { tags: '' });

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

    const res = await controller.getGraphData(ctx, { tags: 'work, urgent ' });

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

    const res = await controller.getGraphData(ctx, { tags: 'phone' });

    expect(res.tagMatch).toEqual({ active: true, entityIds: [] });
    expect(getEntityIdsByTagSources).not.toHaveBeenCalled();
  });
});
