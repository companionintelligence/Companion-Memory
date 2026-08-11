import type { UserServiceContext } from '@ci/common/context';

import { PlaceEntity } from '../entities/PlaceEntity';

import { PlaceService } from './PlaceService';

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
  const created: PlaceEntity[] = [];

  const create = jest.fn((partial: Partial<PlaceEntity>) => {
    const entity = Object.assign(new PlaceEntity(), {
      entityType: 'Location',
      properties: {},
      ...partial,
    });

    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: PlaceEntity) => entity);

  // Hydration read returns whatever ids we "inserted".
  const find = jest.fn(async () => created);

  const repository = {
    create,
    save,
    find,
    // 7 scalar columns + the owner_user_id relation-join column = 8, matching
    // repository.metadata.columns.length; drives computeChunkSize in createMany.
    metadata: { target: PlaceEntity, columns: { length: 8 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(insertRecord)),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);

  const service = new PlaceService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  return { service, send, insert: insertRecord, save };
}

describe('PlaceService bulk createMany', () => {
  it('inserts set-based (one INSERT, no per-row save) and does NOT emit a per-row PlaceCreatedEvent', async () => {
    const { service, send, insert, save } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'pl1', name: 'Home' },
      { id: 'pl2', name: 'Office' },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    // The per-row save() loop is NOT used on the bulk path.
    expect(save).not.toHaveBeenCalled();
    expect(result.map((p) => p.id)).toEqual(['pl1', 'pl2']);
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

describe('PlaceService single create still emits', () => {
  it('emits one PlaceCreatedEvent per row on the interactive create path', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'pl1', name: 'Home' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ placeId: 'pl1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'pl1', name: 'Home' }, { emitCreated: false });

    expect(send).not.toHaveBeenCalled();
  });
});
