import type { UserServiceContext } from '@ci/common/context';

import { NoteEntity } from '../entities/NoteEntity';

import { NoteService } from './NoteService';

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
  const created: NoteEntity[] = [];

  const create = jest.fn((partial: Partial<NoteEntity>) => {
    const entity = Object.assign(new NoteEntity(), { ...partial, userId: USER });

    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: NoteEntity) => entity);
  const find = jest.fn(async () => created);

  const repository = {
    create,
    save,
    find,
    // 6 persisted columns, matching repository.metadata.columns.length; drives
    // computeChunkSize in createMany.
    metadata: { target: NoteEntity, columns: { length: 6 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(insertRecord)),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new NoteService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, send, insert: insertRecord, save };
}

describe('NoteService bulk createMany', () => {
  it('inserts set-based (one INSERT, no per-row save) and does NOT emit a per-row NoteCreatedEvent', async () => {
    const { service, send, insert, save } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'n1', title: 'One', content: 'a' },
      { id: 'n2', title: 'Two', content: 'b' },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(result.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns an empty array (and issues no INSERT) for empty input', async () => {
    const { service, send, insert } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(insert.inserted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('NoteService single create still emits', () => {
  it('emits NoteCreatedEvent on a single interactive create', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'n1', title: 'One', content: 'a' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ noteId: 'n1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'n1', title: 'One', content: 'a' }, { emitCreated: false });

    expect(send).not.toHaveBeenCalled();
  });
});
