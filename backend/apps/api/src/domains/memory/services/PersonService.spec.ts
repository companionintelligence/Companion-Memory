import type { UserServiceContext } from '@ci/common/context';

import { PersonEntity } from '../entities/PersonEntity';

import { makeInsertBuilder } from './__tests__/harness/insertBuilder';
import { PersonService } from './PersonService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/**
 * PersonEntity's persisted-column count as reported by
 * repository.metadata.columns.length: the 7 columns inherited from BaseEntity,
 * the `entity_type` STI discriminator, and PersonEntity's own 4. Drives
 * computeChunkSize in the bulk insert.
 */
const PERSON_COLUMN_COUNT = 12;

interface InsertRecord {
  values?: unknown[];
  conflict?: string;
  inserted: boolean;
  /** Per-chunk row counts, in order, so tests can assert chunking. */
  chunkSizes: number[];
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
  insert: InsertRecord;
  save: jest.Mock;
  findOne: jest.Mock;
}

function makeService(existing: PersonEntity[] = []): Harness {
  const insertRecord: InsertRecord = { inserted: false, chunkSizes: [] };

  // create() echoes the built instance so hydration can find it by id.
  const created: PersonEntity[] = [];

  // No `entityType` is seeded: under STI the discriminator is TypeORM's to
  // manage, and PersonEntity no longer carries it as a property.
  const create = jest.fn((partial: Partial<PersonEntity>) => {
    const entity = Object.assign(new PersonEntity(), {
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
    target: PersonEntity,
    metadata: {
      target: PersonEntity,
      columns: { length: PERSON_COLUMN_COUNT },
      primaryColumns: [{ propertyName: 'id' }],
    },
    // create() persists inside a transaction (EntityService.persistCreate); the
    // transactional manager hands back this same mock repository.
    manager: {
      transaction: jest.fn(async (cb: (m: { getRepository: () => unknown }) => unknown) =>
        cb({ getRepository: (): unknown => repository }),
      ),
    },
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

  it('chunk-safe: a 6000-row bulk create succeeds, split into <=1000-row INSERT chunks (no 65535 bind-param crash)', async () => {
    const { service, insert } = makeService();

    const input = Array.from({ length: 6000 }, (_, i) => ({
      id: `p-${i}`,
      name: `Person ${i}`,
      linkedTable: 'gmail',
      linkedId: `p${i}@x.com`,
    }));

    const result = await service.createMany(CONTEXT, input);

    // All 6000 rows resolved, in input order.
    expect(result).toHaveLength(6000);
    expect(result[0].id).toBe('p-0');
    expect(result[5999].id).toBe('p-5999');

    // Split into multiple INSERTs, each within the param-budget row cap. At 13
    // columns the cap is computeChunkSize = 1000, so 6000 rows -> 6 chunks.
    expect(insert.chunkSizes).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
    // Every chunk's row count * columns stays under the 65535 bind-param limit.
    for (const size of insert.chunkSizes) {
      expect(size * PERSON_COLUMN_COUNT).toBeLessThan(65535);
    }
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

describe('PersonService Change History', () => {
  function makeDeltaService(stored: PersonEntity | null) {
    const deltas = {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
    };
    const updateQb: Record<string, jest.Mock> = {};
    for (const step of ['update', 'set', 'where', 'andWhere', 'setParameter']) {
      updateQb[step] = jest.fn(() => updateQb);
    }

    updateQb.execute = jest.fn(async () => ({ affected: 1 }));
    const repository: Record<string, unknown> = {
      create: jest.fn((partial: Partial<PersonEntity>) => Object.assign(new PersonEntity(), partial)),
      save: jest.fn(async (entity: PersonEntity) => entity),
      findOne: jest.fn(async () => stored),
      target: PersonEntity,
      metadata: { target: PersonEntity, primaryColumns: [{ propertyName: 'id' }] },
      createQueryBuilder: jest.fn(() => updateQb),
    };
    repository.manager = {
      transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb({ getRepository: () => repository })),
    };
    const service = new PersonService(
      repository as never,
      { setContext: jest.fn() } as never,
      { send: jest.fn(async () => []) } as never,
      deltas as never,
    );

    return { service, deltas };
  }

  const robin = () =>
    Object.assign(new PersonEntity(), {
      id: 'p1',
      name: 'Robin Hale',
      description: null,
      userId: USER,
      properties: { nickname: 'Rob', job_title: null, website: '' },
    });

  it('records a person added by hand', async () => {
    const { service, deltas } = makeDeltaService(null);

    await service.create(CONTEXT, { id: 'p1', name: 'Robin Hale' });

    expect(deltas.entityCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'p1',
        entityType: 'Person',
        name: 'Robin Hale',
        changeSource: 'PersonService.create',
      }),
    );
  });

  it('records only the fields an edit changed', async () => {
    const { service, deltas } = makeDeltaService(robin());

    await service.patch(CONTEXT, 'p1', {
      name: 'Robin Hale',
      description: '',
      propertiesPatch: { nickname: 'Robbie', job_title: 'Tester', website: null },
    });

    expect(deltas.entityUpdated).toHaveBeenCalledTimes(1);
    expect(deltas.entityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'p1',
        changeSource: 'PersonService.patch',
        changedFields: {
          nickname: { old: 'Rob', new: 'Robbie' },
          job_title: { old: null, new: 'Tester' },
        },
      }),
    );
  });

  it('records nothing when the edit sends every field back unchanged', async () => {
    const { service, deltas } = makeDeltaService(robin());

    await service.patch(CONTEXT, 'p1', {
      name: 'Robin Hale',
      propertiesPatch: { nickname: 'Rob', job_title: null, website: null },
    });

    expect(deltas.entityUpdated).not.toHaveBeenCalled();
  });

  it('leaves an empty list the person never had out of a nickname-only edit', async () => {
    const { service, deltas } = makeDeltaService(robin());

    await service.patch(CONTEXT, 'p1', {
      name: 'Robin Hale',
      propertiesPatch: { nickname: 'Robbie', addresses: [], emails: [], phones: [] },
    });

    expect(deltas.entityUpdated).toHaveBeenCalledTimes(1);
    expect(deltas.entityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ changedFields: { nickname: { old: 'Rob', new: 'Robbie' } } }),
    );
  });

  it('records a description the edit cleared with an explicit null', async () => {
    const { service, deltas } = makeDeltaService(Object.assign(robin(), { description: 'Neighbour' }));

    await service.patch(CONTEXT, 'p1', { name: 'Robin Hale', description: null as unknown as string });

    expect(deltas.entityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ changedFields: { description: { old: 'Neighbour', new: null } } }),
    );
  });

  /** A repository whose UPDATE really changes what the next read returns, for `update` (applyUpdate). */
  function makeUpdateService(stored: PersonEntity) {
    const deltas = { entityUpdated: jest.fn(async () => undefined) };
    let current = stored;
    const repository: Record<string, unknown> = {
      findOne: jest.fn(async () => current),
      update: jest.fn(async (_where: unknown, patch: Partial<PersonEntity>) => {
        current = Object.assign(new PersonEntity(), current, patch);

        return { affected: 1 };
      }),
      target: PersonEntity,
      metadata: { target: PersonEntity, primaryColumns: [{ propertyName: 'id' }] },
    };
    repository.manager = {
      transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb({ getRepository: () => repository })),
    };
    const service = new PersonService(
      repository as never,
      { setContext: jest.fn() } as never,
      { send: jest.fn(async () => []) } as never,
      deltas as never,
    );

    return { service, deltas };
  }

  it('records what a sync changed, naming the sync', async () => {
    const { service, deltas } = makeUpdateService(robin());

    await service.update(
      CONTEXT,
      'p1',
      { name: 'Robin J. Hale', properties: { nickname: 'Rob', job_title: 'Pilot', website: '' } },
      { source: 'TransformFacebookProfile.transform' },
    );

    expect(deltas.entityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'p1',
        changeSource: 'TransformFacebookProfile.transform',
        changedFields: {
          name: { old: 'Robin Hale', new: 'Robin J. Hale' },
          job_title: { old: null, new: 'Pilot' },
        },
      }),
    );
  });

  it('records nothing for a sync that writes the same bag back', async () => {
    const { service, deltas } = makeUpdateService(robin());

    await service.update(CONTEXT, 'p1', { properties: { nickname: 'Rob', job_title: null, website: '' } });

    expect(deltas.entityUpdated).not.toHaveBeenCalled();
  });

  it('records nothing for a re-sync that only moves its sync stamps', async () => {
    const synced = Object.assign(robin(), {
      properties: {
        nickname: 'Rob',
        last_synced_at: '2026-10-01T00:00:00.000Z',
        facebook_data: { name: 'Robin Hale', last_synced: '2026-10-01T00:00:00.000Z' },
      },
    });
    const { service, deltas } = makeUpdateService(synced);

    await service.update(
      CONTEXT,
      'p1',
      {
        properties: {
          nickname: 'Rob',
          last_synced_at: '2026-10-27T00:00:00.000Z',
          facebook_data: { name: 'Robin Hale', last_synced: '2026-10-27T00:00:00.000Z' },
        },
      },
      { source: 'TransformGoogleContacts.processContact' },
    );

    expect(deltas.entityUpdated).not.toHaveBeenCalled();
  });

  it('records what a re-sync changed besides its sync stamps', async () => {
    const synced = Object.assign(robin(), {
      properties: { facebook_data: { name: 'Robin Hale', last_synced: '2026-10-01T00:00:00.000Z' } },
    });
    const { service, deltas } = makeUpdateService(synced);

    await service.update(
      CONTEXT,
      'p1',
      { properties: { facebook_data: { name: 'Robin J. Hale', last_synced: '2026-10-27T00:00:00.000Z' } } },
      { source: 'TransformFacebookFriends.transform' },
    );

    expect(deltas.entityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFields: {
          facebook_data: { old: { name: 'Robin Hale' }, new: { name: 'Robin J. Hale' } },
        },
      }),
    );
  });
});
