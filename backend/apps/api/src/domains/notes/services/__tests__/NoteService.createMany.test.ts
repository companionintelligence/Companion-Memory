import type { ServiceContext, UserServiceContext } from '@ci/common/context';

import { NoteService } from '../NoteService';

/**
 * Unit tests for the batch `createMany` added to NoteService behind the
 * createNotes mutation. NoteService.create returns `Note | null`, so createMany
 * must drop the nulls (failed creates) and keep input order. `create` is spied so
 * the batch contract is pinned without touching the repository.
 */
const ctx = { userId: 'user-1' } as UserServiceContext;

const logger = () => ({ setContext: jest.fn() }) as never;
const signalling = () => ({ send: jest.fn() }) as never;
const repo = () => ({}) as never;

describe('NoteService.createMany', () => {
  it('creates every note and returns them in input order', async () => {
    const service = new NoteService(repo(), signalling(), logger());
    const spy = jest
      .spyOn(service, 'create')
      .mockImplementation(async (_context: ServiceContext, dto) => ({ id: dto.title }) as never);

    const result = await service.createMany(ctx, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

    expect(result.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('drops nulls (failed creates) but preserves the order of the rest', async () => {
    const service = new NoteService(repo(), signalling(), logger());
    jest
      .spyOn(service, 'create')
      .mockImplementation(async (_context: ServiceContext, dto) =>
        dto.title === 'skip' ? null : ({ id: dto.title } as never),
      );

    const result = await service.createMany(ctx, [{ title: 'a' }, { title: 'skip' }, { title: 'b' }]);

    expect(result.map((n) => n.id)).toEqual(['a', 'b']);
  });
});
