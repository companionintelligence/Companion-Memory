import { EntityIdentifierService } from './EntityIdentifierService';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
const ENTITY = '00000000-0000-0000-0000-0000000000bb';

/**
 * A minimal fake of the insert query-builder chain used by the identifier
 * upserts. `calls.values` holds the LAST chunk's rows (kept for the
 * single-statement assertions); `calls.valuesCalls` records every chunk so the
 * batch specs can assert the chunked-INSERT shape.
 */
function makeInsertBuilder() {
  const calls = { values: [] as unknown[], valuesCalls: [] as unknown[][], orIgnore: 0 };
  const builder: Record<string, unknown> = {};
  builder.insert = () => builder;
  builder.into = () => builder;
  builder.values = (rows: unknown[]) => {
    calls.values = rows;
    calls.valuesCalls.push(rows);

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
    // EntityIdentifierEntity has 5 persisted columns; drives computeChunkSize
    // in the chunked batch INSERT (columns.length) -> 1000 rows per chunk.
    metadata: { columns: { length: 5 } },
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

describe('EntityIdentifierService.upsertForEntities', () => {
  const ENTITY_2 = '00000000-0000-0000-0000-0000000000cc';

  it('writes N entities x M identifiers with ONE set-based INSERT ... ON CONFLICT DO NOTHING', async () => {
    const { service, insert } = makeService({});

    const inserted = await service.upsertForEntities(OWNER, [
      { entityId: ENTITY, raw: { emails: ['  John@Example.COM '], phones: ['+1 (415) 555-0100'] } },
      { entityId: ENTITY_2, raw: { emails: ['jane@example.com'], names: ['José  GARCÍA'] } },
    ]);

    // One statement for the whole batch, guarded by the unique-index arbiter.
    expect(insert.calls.valuesCalls).toHaveLength(1);
    expect(insert.calls.orIgnore).toBe(1);
    expect(insert.calls.values).toEqual([
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'email', valueNormalized: 'john@example.com' },
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'phone', valueNormalized: '4155550100' },
      { ownerUserId: OWNER, entityId: ENTITY_2, kind: 'email', valueNormalized: 'jane@example.com' },
      { ownerUserId: OWNER, entityId: ENTITY_2, kind: 'name', valueNormalized: 'jose garcia' },
    ]);
    expect(inserted).toBe(4);
  });

  it('collapses a (kind, value) shared across entities to the FIRST entity carrying it', async () => {
    const { service, insert } = makeService({});

    await service.upsertForEntities(OWNER, [
      { entityId: ENTITY, raw: { emails: ['shared@example.com'] } },
      { entityId: ENTITY_2, raw: { emails: ['SHARED@example.com'], phones: ['4155550100'] } },
    ]);

    // Matches the sequential per-entity statements this replaces: the first
    // INSERT claimed the tuple, the second was ignored by ON CONFLICT.
    expect(insert.calls.values).toEqual([
      { ownerUserId: OWNER, entityId: ENTITY, kind: 'email', valueNormalized: 'shared@example.com' },
      { ownerUserId: OWNER, entityId: ENTITY_2, kind: 'phone', valueNormalized: '4155550100' },
    ]);
  });

  it('skips malformed identifiers without failing the batch', async () => {
    const { service, insert } = makeService({});

    const inserted = await service.upsertForEntities(OWNER, [
      { entityId: ENTITY, raw: { emails: ['   ', null as unknown as string], phones: ['not-a-number'] } },
      { entityId: ENTITY_2, raw: { emails: ['good@example.com'], phones: [42 as unknown as string] } },
    ]);

    expect(insert.calls.values).toEqual([
      { ownerUserId: OWNER, entityId: ENTITY_2, kind: 'email', valueNormalized: 'good@example.com' },
    ]);
    expect(inserted).toBe(1);
  });

  it('is a no-op (no query) when the batch has no usable identifiers', async () => {
    const insertBuilder = makeInsertBuilder();
    const executeSpy = jest.spyOn(insertBuilder.builder as { execute: () => unknown }, 'execute');
    const { service } = makeService({ insertBuilder });

    const inserted = await service.upsertForEntities(OWNER, [
      { entityId: ENTITY, raw: { emails: ['   '] } },
      { entityId: ENTITY_2, raw: {} },
    ]);

    expect(inserted).toBe(0);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('reports 0 inserted on an idempotent re-send (every row conflicts)', async () => {
    const insertBuilder = makeInsertBuilder();
    insertBuilder.builder.execute = async () => ({ identifiers: [] });
    const { service } = makeService({ insertBuilder });

    const inserted = await service.upsertForEntities(OWNER, [
      { entityId: ENTITY, raw: { emails: ['a@b.com'], phones: ['4155550100'] } },
    ]);

    expect(inserted).toBe(0);
  });

  it('chunks a batch larger than the param budget into bounded INSERTs', async () => {
    const { service, insert } = makeService({});

    // 2500 distinct 10-digit phones across 2500 entities; computeChunkSize(5
    // columns) = 1000 rows/chunk -> 3 statements of 1000/1000/500.
    const entries = Array.from({ length: 2500 }, (_, i) => ({
      entityId: ENTITY,
      raw: { phones: [String(4_000_000_000 + i)] },
    }));

    const inserted = await service.upsertForEntities(OWNER, entries);

    expect(insert.calls.valuesCalls.map((rows) => rows.length)).toEqual([1000, 1000, 500]);
    expect(insert.calls.orIgnore).toBe(3);
    expect(inserted).toBe(2500);
  });

  it('still runs the remaining chunks when one fails, then rethrows (non-fatal at the caller)', async () => {
    const insertBuilder = makeInsertBuilder();
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockImplementation(async () => ({ identifiers: [{}] }));
    insertBuilder.builder.execute = execute;
    const { service } = makeService({ insertBuilder });

    // 1500 rows -> 2 chunks; chunk 1 fails, chunk 2 must still be attempted.
    const entries = Array.from({ length: 1500 }, (_, i) => ({
      entityId: ENTITY,
      raw: { phones: [String(4_000_000_000 + i)] },
    }));

    await expect(service.upsertForEntities(OWNER, entries)).rejects.toThrow(
      /1 identifier insert chunk\(s\) failed .*deadlock detected/,
    );
    expect(execute).toHaveBeenCalledTimes(2);
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
    const managerQuery = jest
      .fn()
      .mockResolvedValue([{ kind: 'email', value_normalized: 'a@b.com', entity_id: ENTITY }]);
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
