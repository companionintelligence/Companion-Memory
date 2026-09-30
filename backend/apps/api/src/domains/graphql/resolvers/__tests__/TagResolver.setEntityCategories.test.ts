import { NotFoundException } from '@nestjs/common';

import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { TagResolver } from '../TagResolver';

const userId = '01926b3c-0000-7000-8000-000000000001';
const taskId = '01926b3c-0000-7000-8000-0000000000aa';
const categoryId = '01926b3c-0000-7000-8000-0000000000bb';

function makeResolver(result: unknown) {
  const tagService = { setEntityCategories: jest.fn().mockResolvedValue(result) };

  // Only tagService is reached by this mutation. The other fifteen
  // collaborators back other fields.
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
    unused,
    tagService as never,
    unused,
    unused,
  );

  return { resolver, tagService };
}

describe('TagResolver.setEntityCategories', () => {
  // A fresh object per call: toServiceContext caches by RequestContext identity.
  const context = () => ({ userId }) as RequestContext;
  const input = {
    entityId: GlobalUID.encode('task', taskId),
    categoryIds: [GlobalUID.encode('tag', categoryId)],
  };

  it("answers an entity the service refuses (someone else's, or nothing) with a 404, not an empty write", async () => {
    const { resolver } = makeResolver(null);

    await expect(resolver.setEntityCategories(context(), input)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hands the service the decoded entity and category ids, as the caller', async () => {
    const { resolver, tagService } = makeResolver([]);

    await expect(resolver.setEntityCategories(context(), input)).resolves.toEqual([]);

    expect(tagService.setEntityCategories).toHaveBeenCalledWith({ userId }, { type: 'task', id: taskId }, [
      categoryId,
    ]);
  });

  it('rejects a type that is not taggable before reaching the service', async () => {
    const { resolver, tagService } = makeResolver([]);

    await expect(
      resolver.setEntityCategories(context(), { ...input, entityId: GlobalUID.encode('user', userId) }),
    ).rejects.toThrow('Invalid entity type: user');

    expect(tagService.setEntityCategories).not.toHaveBeenCalled();
  });
});
