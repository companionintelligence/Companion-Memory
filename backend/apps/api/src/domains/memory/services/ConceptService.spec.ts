import type { UserServiceContext } from '@ci/common/context';

import { ConceptEntity } from '../entities/ConceptEntity';

import { ConceptService } from './ConceptService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeInsertBuilder(record: { values?: unknown[]; conflict?: string; inserted: boolean }) {
  const qb: Record<string, unknown> = {};
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown[]) => {
    record.values = v;

    return qb;
  });
  qb.onConflict = jest.fn((c: string) => {
    record.conflict = c;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    record.inserted = true;

    return { raw: [] };
  });

  return qb;
}

function makeSelectBuilder(rows: ConceptEntity[]) {
  const qb: Record<string, unknown> = {};
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);

  return qb;
}

function makeService(existing: ConceptEntity[] = []) {
  const insertRecord = { inserted: false } as { values?: unknown[]; conflict?: string; inserted: boolean };
  const created: ConceptEntity[] = [];

  const create = jest.fn((partial: Partial<ConceptEntity>) => {
    const entity = Object.assign(new ConceptEntity(), {
      entityType: 'Concept',
      properties: {},
      ...partial,
      userId: USER,
    });

    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: ConceptEntity) => entity);
  const findOne = jest.fn(async () => null);

  const linkedKey = (e: ConceptEntity): string | null =>
    e.linkedTable && e.linkedId ? `${e.linkedTable} ${e.linkedId}` : null;

  const repository = {
    create,
    save,
    findOne,
    // 12 scalar columns + the owner_user_id relation-join column = 13, matching
    // repository.metadata.columns.length; drives computeChunkSize in createMany.
    metadata: { target: ConceptEntity, columns: { length: 13 } },
    createQueryBuilder: jest.fn((alias?: string) => {
      if (alias === undefined) {
        return makeInsertBuilder(insertRecord);
      }

      const existingKeys = new Set(existing.map(linkedKey).filter((k): k is string => k != null));
      const persistedCreated = created.filter((e) => {
        const key = linkedKey(e);

        return key == null || !existingKeys.has(key);
      });

      return makeSelectBuilder([...existing, ...persistedCreated]);
    }),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ConceptService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
  );

  return { service, send, insert: insertRecord };
}

describe('ConceptService bulk createMany', () => {
  it('inserts set-based (one INSERT) and does NOT emit a per-row ConceptCreatedEvent', async () => {
    const { service, send, insert } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'c1', name: 'Chess', linkedTable: 'topics', linkedId: 'chess' },
      { id: 'c2', name: 'Go', linkedTable: 'topics', linkedId: 'go' },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    expect(insert.conflict).toContain('linked_table IS NOT NULL');
    expect(insert.conflict).toContain('DO NOTHING');
    expect(result.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(send).not.toHaveBeenCalled();
  });

  it('dedups on re-send: the same linked key returns the existing row without a duplicate event', async () => {
    const existing = Object.assign(new ConceptEntity(), {
      id: 'existing-1',
      entityType: 'Concept',
      name: 'Chess',
      linkedTable: 'topics',
      linkedId: 'chess',
      userId: USER,
      properties: {},
    });

    const { service, send } = makeService([existing]);

    const result = await service.createMany(CONTEXT, [
      { id: 'new-would-be', name: 'Chess', linkedTable: 'topics', linkedId: 'chess' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('existing-1');
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

describe('ConceptService single create still emits', () => {
  it('emits ConceptCreatedEvent on a single interactive create', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'c1', name: 'Chess', linkedTable: 'topics', linkedId: 'chess' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ conceptId: 'c1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(
      CONTEXT,
      { id: 'c1', name: 'Chess', linkedTable: 'topics', linkedId: 'chess' },
      { emitCreated: false },
    );

    expect(send).not.toHaveBeenCalled();
  });
});
