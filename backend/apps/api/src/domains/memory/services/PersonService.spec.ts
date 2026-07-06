import type { UserServiceContext } from '@ci/common/context';

import { PersonEntity } from '../entities/PersonEntity';

import { PersonService } from './PersonService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/**
 * A fake InsertQueryBuilder that records the ON CONFLICT clause and the values
 * passed, so tests can assert the bulk path issues ONE set-based insert.
 */
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

/**
 * Fake SelectQueryBuilder for the hydration read: returns the rows the repo was
 * seeded with (echoing what was inserted).
 */
function makeSelectBuilder(rows: PersonEntity[]) {
  const qb: Record<string, unknown> = {};
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);

  return qb;
}

interface Harness {
  service: PersonService;
  send: jest.Mock;
  insert: { values?: unknown[]; conflict?: string; inserted: boolean };
  save: jest.Mock;
  findOne: jest.Mock;
}

function makeService(existing: PersonEntity[] = []): Harness {
  const insertRecord = { inserted: false } as { values?: unknown[]; conflict?: string; inserted: boolean };

  // create() echoes the built instance so hydration can find it by id.
  const created: PersonEntity[] = [];

  const create = jest.fn((partial: Partial<PersonEntity>) => {
    const entity = Object.assign(new PersonEntity(), {
      entityType: 'Person',
      properties: {},
      ...partial,
      userId: USER,
    });

    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: PersonEntity) => entity);

  const findOne = jest.fn(async () => null);

  const linkedKey = (e: PersonEntity): string | null =>
    e.linkedTable && e.linkedId ? `${e.linkedTable} ${e.linkedId}` : null;

  const repository = {
    create,
    save,
    findOne,
    metadata: { target: PersonEntity },
    createQueryBuilder: jest.fn((alias?: string) => {
      // Insert builder has no alias; select (hydration) is aliased.
      if (alias === undefined) {
        return makeInsertBuilder(insertRecord);
      }

      // Simulate INSERT ... ON CONFLICT DO NOTHING: a freshly-created row whose
      // linked key collides with a seeded existing row was a no-op, so the
      // hydration SELECT never sees it — only the pre-existing canonical row.
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

  const service = new PersonService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
  );

  return { service, send, insert: insertRecord, save, findOne };
}

describe('PersonService bulk createMany', () => {
  it('inserts set-based (one INSERT) and does NOT emit a per-row PersonCreatedEvent', async () => {
    const { service, send, insert } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'p1', name: 'Alice', linkedTable: 'gmail', linkedId: 'a@x.com' },
      { id: 'p2', name: 'Bob', linkedTable: 'gmail', linkedId: 'b@x.com' },
    ]);

    // One set-based INSERT covering both rows.
    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    // ON CONFLICT targets the linked provenance index (DO NOTHING).
    expect(insert.conflict).toContain('linked_table IS NOT NULL');
    expect(insert.conflict).toContain('DO NOTHING');
    // Returns both rows in input order.
    expect(result.map((p) => p.id)).toEqual(['p1', 'p2']);
    // No per-row events on the bulk path.
    expect(send).not.toHaveBeenCalled();
  });

  it('dedups on re-send: the same linked key returns the existing row without a duplicate event', async () => {
    // Seed an already-existing person under the same linked key.
    const existing = Object.assign(new PersonEntity(), {
      id: 'existing-1',
      entityType: 'Person',
      name: 'Alice',
      linkedTable: 'gmail',
      linkedId: 'a@x.com',
      userId: USER,
      properties: {},
    });

    const { service, send, insert } = makeService([existing]);

    const result = await service.createMany(CONTEXT, [
      { id: 'new-would-be', name: 'Alice', linkedTable: 'gmail', linkedId: 'a@x.com' },
    ]);

    // INSERT still issued (ON CONFLICT DO NOTHING makes the re-send a no-op).
    expect(insert.inserted).toBe(true);
    // Hydration resolves the input row to the pre-existing canonical row via the
    // linked key, NOT the would-be new id.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('existing-1');
    // No event for a re-synced (deduped) row.
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

describe('PersonService single create still emits', () => {
  it('emits PersonCreatedEvent on a single interactive create', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'p1', name: 'Alice', linkedTable: 'gmail', linkedId: 'a@x.com' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ personId: 'p1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(
      CONTEXT,
      { id: 'p1', name: 'Alice', linkedTable: 'gmail', linkedId: 'a@x.com' },
      { emitCreated: false },
    );

    expect(send).not.toHaveBeenCalled();
  });
});
