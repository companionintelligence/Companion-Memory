import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { TagResolver } from '../TagResolver';

/**
 * `Tag.entities` pages through the service now, not through the tag's whole
 * assignment list in memory. What the resolver still owns is pinned here: the
 * cursor translation, the count taken only when selected, and the cursors
 * coming from the assignments read rather than the edges that resolved.
 */
const TAG_ID = '00000000-0000-7000-8000-00000000aaaa';
// A fresh object per call: toServiceContext caches by RequestContext identity.
const ctx = () => ({ userId: 'user-1' }) as RequestContext;
const parent = { __source: { id: TAG_ID } } as never;

function makeResolver(page: unknown) {
  const tagService = { findEntityRefsPage: jest.fn().mockResolvedValue(page) };
  const countLoader = { load: jest.fn().mockResolvedValue(42) };
  const unused = {} as never;
  const resolver = new TagResolver(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    countLoader as never,
    tagService as never,
    unused,
    unused,
  );
  const resolveEntities = jest
    .spyOn(resolver as unknown as { resolveEntities: () => Promise<unknown[]> }, 'resolveEntities')
    .mockImplementation(async (...args: unknown[]) =>
      (args[1] as Array<{ type: string; id: string }>).map((ref) => ({
        id: GlobalUID.encode(ref.type as never, ref.id),
      })),
    );

  return { resolver, tagService, countLoader, resolveEntities };
}

const assignment = (type: string, id: string) => ({ entityType: type, entityId: id, taggedAt: new Date(0) });

describe('TagResolver.entities', () => {
  it('decodes after/before cursors to the tagged entity and passes first/last through', async () => {
    const { resolver, tagService } = makeResolver({
      entities: [],
      hasNextPage: false,
      hasPreviousPage: true,
    });

    await resolver.entities(ctx(), parent, {
      first: 2,
      after: GlobalUID.encode('event', 'e1'),
      before: GlobalUID.encode('person', 'p1'),
    });

    expect(tagService.findEntityRefsPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      TAG_ID,
      {
        first: 2,
        last: undefined,
        after: { type: 'event', id: 'e1' },
        before: { type: 'person', id: 'p1' },
      },
    );
  });

  it('builds edges from what resolved, cursors from what was read, and counts when nothing says otherwise', async () => {
    const { resolver, countLoader, resolveEntities } = makeResolver({
      entities: [assignment('event', 'e1'), assignment('content', 'c1')],
      hasNextPage: true,
      hasPreviousPage: false,
    });
    // The content row no longer resolves: dropped from the edges, still the end cursor.
    resolveEntities.mockResolvedValueOnce([{ id: GlobalUID.encode('event', 'e1') }]);

    const result = await resolver.entities(ctx(), parent, { first: 2 });

    expect(result.edges.map((edge) => edge.cursor)).toEqual([GlobalUID.encode('event', 'e1')]);
    expect(result.pageInfo).toEqual({
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: GlobalUID.encode('event', 'e1'),
      endCursor: GlobalUID.encode('content', 'c1'),
    });
    expect(result.totalCount).toBe(42);
    expect(countLoader.load).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), TAG_ID);
  });

  it('skips the count when the operation did not select totalCount', async () => {
    const { resolver, countLoader } = makeResolver({
      entities: [],
      hasNextPage: false,
      hasPreviousPage: false,
    });
    const info = {
      fieldNodes: [{ selectionSet: { selections: [{ kind: 'Field', name: { value: 'edges' } }] } }],
      fragments: {},
    };

    const result = await resolver.entities(ctx(), parent, { first: 2 }, info as never);

    expect(countLoader.load).not.toHaveBeenCalled();
    expect('totalCount' in result).toBe(false);
  });

  it("answers an empty connection for a tag that is not the caller's", async () => {
    const { resolver } = makeResolver(null);

    await expect(resolver.entities(ctx(), parent, { first: 2 })).resolves.toEqual({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });
  });
});
