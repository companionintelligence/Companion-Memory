import type { UserServiceContext } from '@ci/common/context';

import { AnswerEntity } from '../entities/AnswerEntity';

import { AnswerService } from './AnswerService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeInsertBuilder(record: { values?: unknown[]; inserted: boolean }) {
  const qb: Record<string, unknown> = {};
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown[]) => {
    record.values = v;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    record.inserted = true;

    return { raw: [] };
  });

  return qb;
}

function makeService() {
  const insertRecord = { inserted: false } as { values?: unknown[]; inserted: boolean };
  const created: AnswerEntity[] = [];

  const create = jest.fn((partial: Partial<AnswerEntity>) => {
    const entity = Object.assign(new AnswerEntity(), partial);
    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: AnswerEntity) => entity);
  const find = jest.fn(async () => created);

  const repository = {
    create,
    save,
    find,
    metadata: { target: AnswerEntity },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(insertRecord)),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);

  const removeFromFeedQueue = jest.fn<Promise<void>, [string, string]>(async () => {});
  const removeManyFromFeedQueue = jest.fn<Promise<void>, [string, string[]]>(async () => {});
  const questionService = { removeFromFeedQueue, removeManyFromFeedQueue };

  const service = new AnswerService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    questionService as any,
  );

  return { service, send, insert: insertRecord, save, removeFromFeedQueue, removeManyFromFeedQueue };
}

describe('AnswerService bulk createMany', () => {
  it('inserts set-based (one INSERT, no per-row save) and does NOT emit a per-row AnswerCreatedEvent', async () => {
    const { service, send, insert, save } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'a1', text: 'yes', question: { id: 'q1' } },
      { id: 'a2', text: 'no', question: { id: 'q2' } },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(result.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(send).not.toHaveBeenCalled();
  });

  it('cleans up the feed queue with ONE batched call (not per-row) on the bulk path', async () => {
    const { service, removeFromFeedQueue, removeManyFromFeedQueue } = makeService();

    await service.createMany(CONTEXT, [
      { id: 'a1', text: 'yes', question: { id: 'q1' } },
      { id: 'a2', text: 'no', question: { id: 'q2' } },
      { id: 'a3', text: 'maybe', question: { id: 'q1' } }, // dup question id
    ]);

    // One batched DELETE, de-duplicated question ids, and NO per-row calls.
    expect(removeFromFeedQueue).not.toHaveBeenCalled();
    expect(removeManyFromFeedQueue).toHaveBeenCalledTimes(1);
    const [userId, ids] = removeManyFromFeedQueue.mock.calls[0];
    expect(userId).toBe(USER);
    expect([...ids].sort()).toEqual(['q1', 'q2']);
  });

  it('returns an empty array (and issues no INSERT) for empty input', async () => {
    const { service, send, insert, removeManyFromFeedQueue } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(insert.inserted).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(removeManyFromFeedQueue).not.toHaveBeenCalled();
  });
});

describe('AnswerService single create still emits', () => {
  it('emits AnswerCreatedEvent and removes the answered question from the feed', async () => {
    const { service, send, removeFromFeedQueue } = makeService();

    await service.create(CONTEXT, { id: 'a1', text: 'yes', question: { id: 'q1' } });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ answerId: 'a1' });
    expect(removeFromFeedQueue).toHaveBeenCalledWith(USER, 'q1');
  });

  it('suppresses the event when emitCreated: false is passed (but still cleans the feed)', async () => {
    const { service, send, removeFromFeedQueue } = makeService();

    await service.create(CONTEXT, { id: 'a1', text: 'yes', question: { id: 'q1' } }, { emitCreated: false });

    expect(send).not.toHaveBeenCalled();
    expect(removeFromFeedQueue).toHaveBeenCalledWith(USER, 'q1');
  });
});
