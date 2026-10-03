import { ThreadEntity } from '../../entities/ThreadEntity';
import { ThreadUpdatedEvent } from '../../events';
import { ThreadService } from '../ThreadService';

/** A chainable stand-in for TypeORM's UpdateQueryBuilder that records what it was asked to run. */
function build(affected: number) {
  const calls = {
    update: undefined as unknown,
    set: undefined as unknown,
    where: [] as string[],
    params: {} as Record<string, unknown>,
  };
  // Annotated: each method returns the object itself, which an inferred type cannot describe.
  const query: Record<'update' | 'set' | 'where' | 'andWhere' | 'execute', jest.Mock> = {
    update: jest.fn((entity: unknown) => {
      calls.update = entity;

      return query;
    }),
    set: jest.fn((values: unknown) => {
      calls.set = values;

      return query;
    }),
    where: jest.fn((sql: string, params?: Record<string, unknown>) => {
      calls.where.push(sql);
      Object.assign(calls.params, params);

      return query;
    }),
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      calls.where.push(sql);
      Object.assign(calls.params, params);

      return query;
    }),
    execute: jest.fn(async () => ({ affected })),
  };
  const repository = { createQueryBuilder: jest.fn(() => query) };
  const eventService = { send: jest.fn(async () => []) };
  const service = new ThreadService(
    repository as never,
    {} as never,
    eventService as never,
    { emit: jest.fn() } as never,
  );

  return { service, calls, eventService };
}

/**
 * The stand-in title for a thread the model could not name must never replace a real one. A read followed by a write
 * leaves a gap — the title job takes seconds, and a later turn's job or a rename can land inside it — so the write is
 * ONE conditional UPDATE: it only matches while the thread is still unnamed.
 */
describe('ThreadService.nameIfUnnamed', () => {
  it('updates the title in one statement that only matches an unnamed, live thread of this owner', async () => {
    const { service, calls, eventService } = build(1);

    await expect(
      service.nameIfUnnamed({ userId: 'user-1' } as never, 'thread-1', 'Plan dinner'),
    ).resolves.toBe(true);

    expect(calls.update).toBe(ThreadEntity);
    expect(calls.set).toEqual({ name: 'Plan dinner' });
    expect(calls.where.join(' AND ')).toContain("(title IS NULL OR btrim(title) = '')");
    expect(calls.where.join(' AND ')).toContain('thread_id = :id');
    expect(calls.where.join(' AND ')).toContain('is_archived = false');
    expect(calls.where.join(' AND ')).toContain('user_id = :userId');
    expect(calls.params).toEqual({ id: 'thread-1', userId: 'user-1' });
    expect(eventService.send).toHaveBeenCalledWith(ThreadUpdatedEvent, { threadId: 'thread-1' });
  });

  it('writes nothing, and announces nothing, when a title is already there', async () => {
    const { service, eventService } = build(0);

    await expect(
      service.nameIfUnnamed({ userId: 'user-1' } as never, 'thread-1', 'Plan dinner'),
    ).resolves.toBe(false);
    expect(eventService.send).not.toHaveBeenCalled();
  });
});
