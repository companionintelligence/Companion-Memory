import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';

import { PersonEntity } from '../entities/PersonEntity';

import { PersonMergeService } from './PersonMergeService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const TARGET = '00000000-0000-0000-0000-0000000000b1';
const SOURCE_A = '00000000-0000-0000-0000-0000000000c1';
const SOURCE_B = '00000000-0000-0000-0000-0000000000c2';
const SELF = '00000000-0000-0000-0000-0000000000d1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

interface EntityRow {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  merged_into_entity_id: string | null;
}

function personRow(id: string, overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    entity_id: id,
    entity_type: 'Person',
    name: null,
    description: null,
    properties: {},
    merged_into_entity_id: null,
    ...overrides,
  };
}

interface Harness {
  service: PersonMergeService;
  statements: Array<{ sql: string; params: unknown[] | undefined }>;
  send: jest.Mock;
}

function makeHarness(entityRows: EntityRow[], selfEntityId: string | null = SELF): Harness {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });

    if (sql.includes('FROM ci.entities') && sql.includes('FOR UPDATE')) {
      const requested = (params?.[1] as string[]) ?? [];

      return entityRows.filter((row) => requested.includes(row.entity_id));
    }

    if (sql.includes('FROM ci.users')) {
      return [{ entity_id: selfEntityId }];
    }

    return [];
  });

  const manager = {
    query,
    transaction: jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => cb({ query })),
  };

  const findOne = jest.fn(async () =>
    Object.assign(new PersonEntity(), {
      id: TARGET,
      entityType: 'Person',
      properties: {},
      isActive: true,
      mergedIntoEntityId: null,
      userId: USER,
    }),
  );

  const repository = { manager, findOne };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const send = jest.fn(async () => []);

  const service = new PersonMergeService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
  );

  return { service, statements, send };
}

function statementsMatching(harness: Harness, fragment: string) {
  return harness.statements.filter(({ sql }) => sql.includes(fragment));
}

describe('PersonMergeService', () => {
  it('rejects a merge with no sources distinct from the target', async () => {
    const harness = makeHarness([personRow(TARGET)]);

    await expect(harness.service.mergePeople(CONTEXT, [TARGET], TARGET)).rejects.toThrow(BadRequestException);
  });

  it('rejects a missing target', async () => {
    const harness = makeHarness([personRow(SOURCE_A)]);

    await expect(harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(NotFoundException);
  });

  it('rejects a non-Person source', async () => {
    const harness = makeHarness([personRow(TARGET), personRow(SOURCE_A, { entity_type: 'Location' })]);

    await expect(harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an already-merged source (tombstone)', async () => {
    const harness = makeHarness([
      personRow(TARGET),
      personRow(SOURCE_A, { merged_into_entity_id: SOURCE_B }),
    ]);

    await expect(harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses to merge the self person away', async () => {
    const harness = makeHarness([personRow(TARGET), personRow(SELF)], SELF);

    await expect(harness.service.mergePeople(CONTEXT, [SELF], TARGET)).rejects.toThrow(/self person/i);
  });

  it('re-points every dependent table, tombstones the sources, and logs the merge', async () => {
    const harness = makeHarness([
      personRow(TARGET, { name: 'Dana', properties: { emails: ['dana@x.com'] } }),
      personRow(SOURCE_A, {
        name: 'Dana Q',
        properties: { emails: ['danaq@y.com'], first_name: 'Dana' },
      }),
      personRow(SOURCE_B),
    ]);

    const result = await harness.service.mergePeople(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    expect(result.id).toBe(TARGET);

    // Decompression cap lifted inside the txn before hypertable updates.
    expect(statementsMatching(harness, 'max_tuples_decompressed_per_dml_transaction')).toHaveLength(1);

    // One re-point per dependent surface, each owner-scoped with the sources.
    for (const fragment of [
      'UPDATE ci.entity_identifiers SET entity_id',
      'UPDATE ci.communications SET from_entity_id',
      'SET to_entity_ids = sub.new_ids',
      'UPDATE ci.events SET organizer_entity_id',
      'SET participant_entity_ids = sub.new_ids',
    ]) {
      const matches = statementsMatching(harness, fragment);
      expect(matches).toHaveLength(1);
      expect(matches[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);
    }

    // Relationships: self-ref cleanup, guarded from/to re-points, dupe deletes.
    expect(statementsMatching(harness, 'DELETE FROM ci.relationships')).toHaveLength(3);
    expect(statementsMatching(harness, 'UPDATE ci.relationships r SET from_entity_id')).toHaveLength(1);
    expect(statementsMatching(harness, 'UPDATE ci.relationships r SET to_entity_id')).toHaveLength(1);

    // Properties folded onto the target: union of emails, scalars target-wins.
    const propertiesUpdate = statementsMatching(harness, 'SET properties =');
    expect(propertiesUpdate).toHaveLength(1);
    const folded = JSON.parse(propertiesUpdate[0].params?.[2] as string) as Record<string, unknown>;
    expect(folded.emails).toEqual(expect.arrayContaining(['dana@x.com', 'danaq@y.com']));
    expect(folded.first_name).toBe('Dana');

    // Target keeps its own name.
    expect(propertiesUpdate[0].params?.[3]).toBe('Dana');

    // Sources tombstoned and their search rows dropped from BOTH stores
    // (embedding = semantic, vectors = keyword), with tags re-pointed.
    // `is_active = FALSE` is what distinguishes the tombstone UPDATE from the
    // path-compression one, which also sets merged_into_entity_id.
    const tombstone = statementsMatching(harness, 'SET merged_into_entity_id = $3, is_active = FALSE');
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.embeddings')).toHaveLength(1);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.vectors')).toHaveLength(1);
    expect(statementsMatching(harness, 'UPDATE ci_search.entity_tag')).toHaveLength(1);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.entity_tag')).toHaveLength(1);

    // One audit row per source.
    expect(statementsMatching(harness, 'INSERT INTO ci.entity_merges')).toHaveLength(2);

    // Target re-indexes after commit.
    expect(harness.send).toHaveBeenCalledWith(expect.anything(), { personId: TARGET });
  });

  it('drops duplicate source ids and self-merges from the source list', async () => {
    const harness = makeHarness([personRow(TARGET), personRow(SOURCE_A)]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A, SOURCE_A, TARGET], TARGET);

    const identifierUpdate = statementsMatching(harness, 'UPDATE ci.entity_identifiers')[0];
    expect(identifierUpdate.params?.[1]).toEqual([SOURCE_A]);
  });

  it('re-points tombstones that already aimed at a source, keeping the chain one hop deep', async () => {
    // Merging B into C must also drag along whatever was previously merged INTO
    // B. Every resolver in the codebase follows exactly ONE hop
    // (PersonService.resolveTombstone, GraphIngestService.canonicalIdOf), so a
    // two-step chain would silently re-strand the first merge's sources.
    const harness = makeHarness([personRow(TARGET), personRow(SOURCE_A)]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET);

    const compression = statementsMatching(harness, 'WHERE owner_user_id = $1 AND merged_into_entity_id');
    expect(compression).toHaveLength(1);
    expect(compression[0].params).toEqual([USER, [SOURCE_A], TARGET]);
  });

  it("never lets a source's is_self flag leak onto a non-self target", async () => {
    // SOURCE_A is a floating self-flagged stub (NOT the row users.entity_id
    // points at, so the self-source guard does not reject it).
    const harness = makeHarness([
      personRow(TARGET, { name: 'Dana' }),
      personRow(SOURCE_A, { properties: { is_self: true, first_name: 'Dana' } }),
    ]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET);

    const propertiesUpdate = statementsMatching(harness, 'SET properties =');
    const folded = JSON.parse(propertiesUpdate[0].params?.[2] as string) as Record<string, unknown>;
    expect(folded.is_self).toBeUndefined();
    expect(folded.first_name).toBe('Dana');
  });
});
