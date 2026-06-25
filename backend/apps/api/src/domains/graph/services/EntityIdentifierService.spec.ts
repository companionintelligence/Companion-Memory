import { EntityIdentifierService } from './EntityIdentifierService';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
const ENTITY = '00000000-0000-0000-0000-0000000000bb';

/** A minimal fake of the insert query-builder chain used by upsertForEntity. */
function makeInsertBuilder() {
  const calls = { values: [] as unknown[], orIgnore: 0 };
  const builder: Record<string, unknown> = {};
  builder.insert = () => builder;
  builder.into = () => builder;
  builder.values = (rows: unknown[]) => {
    calls.values = rows;

    return builder;
  };

  builder.orIgnore = () => {
    calls.orIgnore += 1;

    return builder;
  };

  // Simulate ON CONFLICT DO NOTHING: only return identifiers for the inserted
  // rows. Default to "all inserted"; tests can override.
  builder.execute = async () => ({ identifiers: (calls.values as unknown[]).map(() => ({})) });

  return { builder, calls };
}

function makeService(overrides: {
  insertBuilder?: ReturnType<typeof makeInsertBuilder>;
  managerQuery?: jest.Mock;
  findOne?: jest.Mock;
}) {
  const insert = overrides.insertBuilder ?? makeInsertBuilder();

  const repository = {
    create: (row: Record<string, unknown>) => row,
    createQueryBuilder: () => insert.builder,
    findOne: overrides.findOne ?? jest.fn(),
    manager: { query: overrides.managerQuery ?? jest.fn() },
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new EntityIdentifierService(repository as any, logger as any);

  return { service, repository, insert };
}

describe('EntityIdentifierService.upsertForEntity', () => {
  it('normalizes defensively and inserts ON CONFLICT DO NOTHING', async () => {
    const { service, insert } = makeService({});

    const inserted = await service.upsertForEntity(OWNER, ENTITY, {
      emails: ['  John@Example.COM '],
      phones: ['+1 (415) 555-0100'],
    });

    expect(insert.calls.orIgnore).toBe(1);
    expect(insert.calls.values).toEqual([
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'email', valueNormalized: 'john@example.com' },
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'phone', valueNormalized: '4155550100' },
    ]);
    expect(inserted).toBe(2);
  });

  it('de-dups identical normalized values within one entity (no self-conflict)', async () => {
    const { service, insert } = makeService({});

    await service.upsertForEntity(OWNER, ENTITY, {
      // Three spellings of the same number + a duplicate email casing.
      emails: ['a@b.com', 'A@B.COM'],
      phones: ['+1 415 555 0100', '(415) 555-0100', '4155550100'],
    });

    expect(insert.calls.values).toEqual([
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'email', valueNormalized: 'a@b.com' },
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'phone', valueNormalized: '4155550100' },
    ]);
  });

  it('is a no-op (no query) when there are no usable identifiers', async () => {
    const insertBuilder = makeInsertBuilder();
    const executeSpy = jest.spyOn(insertBuilder.builder as { execute: () => unknown }, 'execute');
    const { service } = makeService({ insertBuilder });

    const inserted = await service.upsertForEntity(OWNER, ENTITY, {
      emails: ['   ', null as unknown as string],
      phones: ['not-a-number'],
    });

    expect(inserted).toBe(0);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('reports only the rows actually inserted (idempotent re-run)', async () => {
    const insertBuilder = makeInsertBuilder();
    // Simulate a re-run where both rows already existed -> conflict -> 0 inserted.
    insertBuilder.builder.execute = async () => ({ identifiers: [] });
    const { service } = makeService({ insertBuilder });

    const inserted = await service.upsertForEntity(OWNER, ENTITY, {
      emails: ['a@b.com'],
      phones: ['4155550100'],
    });

    expect(inserted).toBe(0);
  });

  it('accepts a single string as well as an array', async () => {
    const { service, insert } = makeService({});

    await service.upsertForEntity(OWNER, ENTITY, { emails: 'solo@example.com' });

    expect(insert.calls.values).toEqual([
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'email', valueNormalized: 'solo@example.com' },
    ]);
  });
});

describe('EntityIdentifierService.findEntityIdsByIdentifiers', () => {
  it('short-circuits without a query for empty input', async () => {
    const managerQuery = jest.fn();
    const { service } = makeService({ managerQuery });

    const result = await service.findEntityIdsByIdentifiers(OWNER, []);

    expect(result.size).toBe(0);
    expect(managerQuery).not.toHaveBeenCalled();
  });

  it('issues a single scoped row-values IN query and maps matches by key', async () => {
    const managerQuery = jest.fn().mockResolvedValue([
      { kind: 'email', value_normalized: 'a@b.com', entity_id: ENTITY },
    ]);
    const { service } = makeService({ managerQuery });

    const result = await service.findEntityIdsByIdentifiers(OWNER, [
      { kind: 'email', valueNormalized: 'a@b.com' },
      { kind: 'phone', valueNormalized: '4155550100' },
      // duplicate is collapsed into the same IN tuple
      { kind: 'email', valueNormalized: 'a@b.com' },
    ]);

    expect(managerQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = managerQuery.mock.calls[0];
    expect(sql).toContain('(kind, value_normalized) IN');
    expect(sql).toContain('owner_user_id = $1');
    // owner + 2 distinct tuples * 2 params each = 5 params
    expect(params).toEqual([OWNER, 'email', 'a@b.com', 'phone', '4155550100']);

    expect(result.get('email:a@b.com')).toBe(ENTITY);
    expect(result.has('phone:4155550100')).toBe(false);
  });
});

describe('EntityIdentifierService.findEntityIdByIdentifier', () => {
  it('returns the matched entity id', async () => {
    const findOne = jest.fn().mockResolvedValue({ entityId: ENTITY });
    const { service } = makeService({ findOne });

    await expect(service.findEntityIdByIdentifier(OWNER, 'email', 'a@b.com')).resolves.toBe(ENTITY);
    expect(findOne).toHaveBeenCalledWith({
      where: { ownerUserId: OWNER, kind: 'email', valueNormalized: 'a@b.com' },
      select: ['entityId'],
    });
  });

  it('returns null when nothing matches', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const { service } = makeService({ findOne });

    await expect(service.findEntityIdByIdentifier(OWNER, 'phone', '4155550100')).resolves.toBeNull();
  });
});
