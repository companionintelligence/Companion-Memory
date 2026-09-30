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

/** One `ci.identifier_claims` row, as far as a merge can see it. */
interface ClaimRow {
  owner_user_id: string;
  subject_type: string;
  subject_id: string;
  role: string;
  kind: string;
  value_normalized: string;
  entity_id: string | null;
  disposition: 'confirmed' | 'rejected' | null;
}

interface Harness {
  service: PersonMergeService;
  statements: Array<{ sql: string; params: unknown[] | undefined; inTransaction: boolean }>;
  send: jest.Mock;
}

/**
 * `claims` is an in-memory `ci.identifier_claims`: the claim re-point is
 * applied to it by its bound parameters (owner, sources, target), and answers
 * with the count its CTE selects. The statement's SQL shape is asserted
 * separately, so this only has to model what the parameters mean.
 */
function makeHarness(
  entityRows: EntityRow[],
  selfEntityId: string | null = SELF,
  claims: ClaimRow[] = [],
): Harness {
  const statements: Harness['statements'] = [];
  let inTransaction = false;

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params, inTransaction });

    if (sql.includes('FROM ci.entities') && sql.includes('FOR UPDATE')) {
      const requested = (params?.[1] as string[]) ?? [];

      return entityRows.filter((row) => requested.includes(row.entity_id));
    }

    if (sql.includes('FROM ci.users')) {
      return [{ entity_id: selfEntityId }];
    }

    if (sql.includes('UPDATE ci.identifier_claims')) {
      const [owner, sources, target] = params as [string, string[], string];
      const moved = claims.filter(
        (claim) =>
          claim.owner_user_id === owner && claim.entity_id != null && sources.includes(claim.entity_id),
      );

      for (const claim of moved) {
        claim.entity_id = target;
      }

      return [{ count: moved.length }];
    }

    return [];
  });

  const manager = {
    query,
    transaction: jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => {
      inTransaction = true;

      try {
        return await cb({ query });
      } finally {
        inTransaction = false;
      }
    }),
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
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
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

    // The target's name is preserved — a source's fuller name must never
    // silently overwrite it (a source can be an unreviewed stub, and the
    // target can be the user's own self person).
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

  it("carries the sources' merge blocks to the target inside the transaction, keeping the sources' own rows", async () => {
    // The target now holds the sources' claims, so the detector's next look at
    // it would re-find every pair a human rejected with a source — and fold one
    // evidenced by a shared address with no human asked.
    const harness = makeHarness([personRow(TARGET), personRow(SOURCE_A), personRow(SOURCE_B)]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const carry = statementsMatching(harness, 'INSERT INTO ci.entity_merge_blocks');
    expect(carry).toHaveLength(1);
    expect(carry[0].inTransaction).toBe(true);
    expect(carry[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);

    const sql = carry[0].sql.replace(/\s+/g, ' ');
    // Every block the owner holds naming a source...
    expect(sql).toContain(
      'WHERE b.owner_user_id = $1 AND (b.entity_id_a = ANY($2::uuid[]) OR b.entity_id_b = ANY($2::uuid[]))',
    );
    // ...except one between people this merge folds together, which would
    // pair the target with itself: the merge is the later decision.
    expect(sql).toContain('WHERE blocked.other_id <> $3::uuid AND NOT (blocked.other_id = ANY($2::uuid[]))');
    // Stored as the ordered pair entity_merge_blocks_ordered demands, and a
    // block the target already holds keeps its own reason.
    expect(sql).toContain('LEAST($3::uuid, blocked.other_id), GREATEST($3::uuid, blocked.other_id)');
    expect(sql).toContain('ON CONFLICT (owner_user_id, entity_id_a, entity_id_b) DO NOTHING');

    // The source's rows stay — an unmerge replays from them.
    expect(statementsMatching(harness, 'DELETE FROM ci.entity_merge_blocks')).toHaveLength(0);
    expect(statementsMatching(harness, 'UPDATE ci.entity_merge_blocks')).toHaveLength(0);
  });

  it("moves the sources' identifier claims to the target inside the merge transaction, writing only their resolution", async () => {
    const harness = makeHarness([personRow(TARGET), personRow(SOURCE_A), personRow(SOURCE_B)]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const repoint = statementsMatching(harness, 'UPDATE ci.identifier_claims');
    expect(repoint).toHaveLength(1);
    expect(repoint[0].inTransaction).toBe(true);
    expect(repoint[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], TARGET]);

    const sql = repoint[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])');
    // `entity_id` is the only column written. The unique key is the
    // observation — (owner, subject_type, subject_id, role, kind,
    // value_normalized) — and entity_id is not in it, so this cannot collide;
    // method, confidence and a human's disposition describe the observation
    // too, and stay exactly as they were.
    expect(sql).toMatch(/SET entity_id = \$3 WHERE/);
    // Every disposition moves: no filter on it, and nothing writes it.
    expect(sql).not.toMatch(/disposition/);

    // Before the sources become tombstones and the audit rows are written.
    const order = harness.statements.map(({ sql: text }) => text);
    const repointAt = order.findIndex((text) => text.includes('UPDATE ci.identifier_claims'));
    expect(repointAt).toBeLessThan(order.findIndex((text) => text.includes('is_active = FALSE')));
    expect(repointAt).toBeLessThan(order.findIndex((text) => text.includes('INSERT INTO ci.entity_merges')));
  });

  it("makes the merged-away card's number evidence against the target, so a third copy holding only that number pairs with it", async () => {
    // Three copies of one contact. The target and SOURCE_A share an address,
    // which is how they came to be merged; SOURCE_A's card also carries a
    // number, and THIRD holds only that number.
    const third = '00000000-0000-0000-0000-0000000000e1';
    const message = '00000000-0000-0000-0000-0000000000f1';
    const claim = (overrides: Partial<ClaimRow>): ClaimRow => ({
      owner_user_id: USER,
      subject_type: 'person',
      subject_id: SOURCE_A,
      role: 'self',
      kind: 'email',
      value_normalized: 'wren@example.net',
      entity_id: SOURCE_A,
      disposition: null,
      ...overrides,
    });
    const claims: ClaimRow[] = [
      claim({ subject_id: TARGET, entity_id: TARGET }),
      claim({}),
      claim({ kind: 'phone', value_normalized: '4155550136' }),
      // A message from that number, which enrich.person_link resolved to SOURCE_A.
      claim({
        subject_type: 'communication',
        subject_id: message,
        role: 'from',
        kind: 'phone',
        value_normalized: '4155550136',
      }),
      // A link a human rejected: it moves, and stays rejected.
      claim({
        subject_type: 'communication',
        subject_id: message,
        role: 'to',
        value_normalized: 'desk@example.net',
        disposition: 'rejected',
      }),
      claim({ subject_id: third, kind: 'phone', value_normalized: '4155550136', entity_id: third }),
    ];
    const before = claims.map((row) => ({ ...row }));

    const harness = makeHarness(
      [personRow(TARGET, { name: 'Wren Adair' }), personRow(SOURCE_A, { name: 'Wren A.' })],
      SELF,
      claims,
    );

    await harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET);

    // Every claim that resolved to SOURCE_A now resolves to the target; where
    // it was observed, and the rejection, are untouched.
    claims.forEach((row, index) => {
      const was = before[index];
      expect(row).toEqual({ ...was, entity_id: was.entity_id === SOURCE_A ? TARGET : was.entity_id });
    });

    // DuplicateDetectStage.loadEvidence counts a claim's holder only while it
    // is a live person and the claim is not rejected. SOURCE_A is now a
    // tombstone — the number's holders are the target and THIRD, the pair the
    // detector could not see while the number sat on the tombstone.
    const live = new Set([TARGET, third]);
    const holdersOf = (value: string) =>
      new Set(
        claims
          .filter((row) => row.value_normalized === value && row.disposition !== 'rejected')
          .map((row) => row.entity_id)
          .filter((id): id is string => id != null && live.has(id)),
      );
    expect(holdersOf('4155550136')).toEqual(new Set([TARGET, third]));
    expect(holdersOf('desk@example.net')).toEqual(new Set());

    // And the audit row records how many claims moved.
    const [audit] = statementsMatching(harness, 'INSERT INTO ci.entity_merges');
    const details = JSON.parse(audit.params?.[3] as string) as { counts: { claims: number } };
    expect(details.counts.claims).toBe(4);
  });

  it("keeps the target's name even when a merge source's name is fuller, including when the target is the self person", async () => {
    // MergeCandidateService.autoMergeDeterministicPairs runs exactly this shape
    // unattended: self person as target, a communications stub as source.
    // pickFullerName's token-count comparison used to let the stub's longer
    // name win; the target must always win when it already has a name.
    const harness = makeHarness(
      [personRow(SELF, { name: 'Liam Broza' }), personRow(SOURCE_A, { name: 'Liam Broza via GitHub' })],
      SELF,
    );

    await harness.service.mergePeople(CONTEXT, [SOURCE_A], SELF);

    const propertiesUpdate = statementsMatching(harness, 'SET properties =');
    expect(propertiesUpdate).toHaveLength(1);
    expect(propertiesUpdate[0].params?.[1]).toBe(SELF);
    expect(propertiesUpdate[0].params?.[3]).toBe('Liam Broza');
  });

  it('falls back to a source name only when the target has none', async () => {
    const harness = makeHarness([personRow(TARGET, { name: null }), personRow(SOURCE_A, { name: 'Dana Q' })]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET);

    const propertiesUpdate = statementsMatching(harness, 'SET properties =');
    expect(propertiesUpdate[0].params?.[3]).toBe('Dana Q');
  });

  it("keeps both cards' typed Phones, so a stated country survives the merge", async () => {
    // Target-wins would drop the source's "+44 …" and keep only its ten-digit
    // `phones` key, which the phone adjudicator would then read as a +1 number.
    const harness = makeHarness([
      personRow(TARGET, {
        name: 'Dana',
        properties: { Phones: ['+1 (202) 555-0142'], phones: ['2025550142'] },
      }),
      personRow(SOURCE_A, {
        name: 'Dana Q',
        properties: {
          Phones: ['+44 20 7946 0958', '+1 (202) 555-0142', '12025550142'],
          phones: ['2079460958'],
        },
      }),
    ]);

    await harness.service.mergePeople(CONTEXT, [SOURCE_A], TARGET);

    const propertiesUpdate = statementsMatching(harness, 'SET properties =');
    const folded = JSON.parse(propertiesUpdate[0].params?.[2] as string) as Record<string, unknown>;
    // De-duplicated on the digit string; the first formatting seen is kept.
    expect(folded.Phones).toEqual(['+1 (202) 555-0142', '+44 20 7946 0958']);
    expect(folded.phones).toEqual(['2025550142', '2079460958']);
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
