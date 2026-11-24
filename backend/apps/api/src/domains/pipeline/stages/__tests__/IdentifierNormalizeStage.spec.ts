import { normalizeIdentifier } from '@ci/domains/graph';

import { PipelineStateService } from '../../services/PipelineStateService';
import {
  CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID,
  E164_RULE_GENERATION,
  IDENTIFIER_NORMALIZE_SOURCE,
  IDENTIFIER_NORMALIZE_VERSION,
  IDENTIFIER_RULE_GENERATION,
  IdentifierNormalizeStage,
  type IdentifierPatch,
  type IdentifierRow,
  identifierNormalizeStageVersion,
  normalizeOne,
  resolveConvergence,
  toE164,
} from '../clean/IdentifierNormalizeStage';

/**
 * `clean.identifier_normalize` — canonicalise what is already stored.
 *
 * The three things that would do real damage if they were wrong:
 *
 *  1. **The join key keeps its meaning.** `value_normalized` is computed at
 *     every lookup by `classifyParticipant`. Normalising by a private rule
 *     here would break people-linking silently — no error, no dead letter,
 *     just matches that stop happening. So the E.164 form goes in its own
 *     column and the key is left alone. (Until CI-Import-Tools' retirement
 *     this key also had to stay byte-identical with that repo's own copy of
 *     the rule; its import functionality is now native here.)
 *  2. **E.164 is derived, never assumed.** A bare ten-digit number needs a
 *     country to become international, and this appliance has no per-user
 *     dialling region. Stamping `+1` on the corpus would fabricate a measured
 *     fact, which is precisely what `StageResult.confidence` forbids.
 *  3. **A collision is reported, never resolved.** `(owner_user_id, kind,
 *     value_normalized)` is UNIQUE, so an identifier that normalises onto a
 *     value another entity holds CANNOT move — and the reason it cannot is that
 *     the two entities are probably the same person. The stage leaves both rows
 *     intact and records the finding.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const ENTITY_TYPE = 'entity';

function entityId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function identifier(overrides: Partial<IdentifierRow> = {}): IdentifierRow {
  return {
    entity_id: entityId(1),
    kind: 'email',
    value_normalized: 'liam@example.com',
    raw_value: 'liam@example.com',
    ...overrides,
  };
}

/* ===================================================================== *
 * The version
 * ===================================================================== */

describe('the version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(IDENTIFIER_NORMALIZE_VERSION)).toBe(true);
    expect(IDENTIFIER_NORMALIZE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('tolerates a STAGE_VERSIONS map with no entry yet', () => {
    expect(identifierNormalizeStageVersion({})).toBe(IDENTIFIER_NORMALIZE_VERSION);
  });

  it('throws when the central declaration disagrees', () => {
    expect(() =>
      identifierNormalizeStageVersion({
        [CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID]: IDENTIFIER_NORMALIZE_VERSION + 1,
      }),
    ).toThrow(/versions\.ts in the same commit/);
  });

  it('moved both generations for the extension refusal, and the sum with them', () => {
    // v2 of the shared rule: `normalizePhone` refuses a value carrying an
    // extension. v2 of the E.164 derivation: `toE164` refuses every form the
    // join key does, not only a trailing `x`/`ext`. A bump here is the lever
    // that re-opens the corpus; pinned so it cannot be quietly reverted.
    expect(IDENTIFIER_RULE_GENERATION).toBe(2);
    expect(E164_RULE_GENERATION).toBe(2);
    expect(IDENTIFIER_NORMALIZE_VERSION).toBe(3);
  });
});

/* ===================================================================== *
 * E.164
 * ===================================================================== */

describe('toE164', () => {
  it.each([
    ['+1 (415) 555-0100', '+14155550100'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+442079460958', '+442079460958'],
    ['00 44 20 7946 0958', '+442079460958'],
    ['1-415-555-0100', '+14155550100'],
    ['14155550100', '+14155550100'],
  ])('derives %s as %s', (raw, expected) => {
    expect(toE164(raw)).toBe(expected);
  });

  it.each([['4155550100'], ['(415) 555-0100'], ['555-0100'], ['20 7946 0958']])(
    'refuses to guess a country for %s',
    (raw) => {
      // A bare national number is only international against an ASSUMED country.
      // `ci.users` carries `timezone` and `language`, neither of which is a
      // dialling region, so assuming `+1` would stamp a fabricated country code
      // onto the whole corpus and make it look measured. Null is the honest
      // answer, and `ci.users.phone_region` plus one generation bump converts
      // every one of them later.
      expect(toE164(raw)).toBeNull();
    },
  );

  it.each([[null], [undefined], [''], ['   '], ['not a phone'], ['+1'], ['+1234567890123456']])(
    'returns null for %p',
    (raw) => {
      expect(toE164(raw)).toBeNull();
    },
  );

  it('refuses a number carrying an extension rather than truncating it', () => {
    // E.164 has nowhere to put an extension, and dropping it silently produces a
    // number that dials the switchboard and claims to be the person.
    expect(toE164('+1 415 555 0100 ext. 22')).toBeNull();
    expect(toE164('+1 415 555 0100 x22')).toBeNull();
  });

  it.each([
    ['+1 (212) 555-0147;229'],
    ['+1 212 555 0147,229'],
    ['+1 212 555 0147#229'],
    ['+12125550147x229'],
  ])('refuses the dial-string extension %s the join key refuses', (raw) => {
    // The pattern this replaced caught only a trailing `x`/`ext`, so a stated
    // `+1` with a `;`-separated extension derived `+12125550147229`: fourteen
    // digits under +1, a "number" that exists nowhere.
    expect(toE164(raw)).toBeNull();
  });

  it('is idempotent on its own output', () => {
    expect(toE164(toE164('+1 (415) 555-0100'))).toBe('+14155550100');
  });
});

/* ===================================================================== *
 * normalizeOne
 * ===================================================================== */

describe('normalizeOne', () => {
  it('uses the SHARED rule, not a private one', () => {
    // The property that keeps people-linking working. If this ever diverges,
    // every lookup computed by `classifyParticipant` stops finding the rows
    // this stage wrote.
    const row = identifier({ raw_value: '  Liam@Example.COM ', value_normalized: 'wrong' });

    expect(normalizeOne(row)?.target).toBe(normalizeIdentifier('email', '  Liam@Example.COM '));
  });

  it('repairs a value_normalized that was never normalized', () => {
    const patch = normalizeOne(
      identifier({ raw_value: 'Liam@Example.COM', value_normalized: 'Liam@Example.COM' }),
    );

    expect(patch?.currentValue).toBe('Liam@Example.COM');
    expect(patch?.target).toBe('liam@example.com');
  });

  it('extracts an address from an RFC 5322 mailbox', () => {
    // The shared rule's own behaviour: without it the display name is folded
    // into the identifier and one mailbox fragments across many people.
    expect(normalizeOne(identifier({ raw_value: 'Liam Broza <liam@example.com>' }))?.target).toBe(
      'liam@example.com',
    );
  });

  it('leaves an already-correct value as a fixed point', () => {
    const patch = normalizeOne(identifier());

    expect(patch?.target).toBe(patch?.currentValue);
  });

  it('falls back to the stored value when the raw was never retained', () => {
    // Lossy and strictly weaker — a lost country code cannot come back — but it
    // still catches the class this stage is for: a value that is not a fixed
    // point of the CURRENT rule.
    const patch = normalizeOne(identifier({ raw_value: null, value_normalized: 'LIAM@EXAMPLE.COM' }));

    expect(patch?.target).toBe('liam@example.com');
  });

  it('derives e164 from the RAW value only, never from the normalized one', () => {
    // `normalizePhone` keeps the last ten digits, so the country code is already
    // gone from `value_normalized`. Deriving from it would produce a confident
    // international number out of one whose country was destroyed.
    const patch = normalizeOne(
      identifier({ kind: 'phone', raw_value: '+44 20 7946 0958', value_normalized: '2079460958' }),
    );

    expect(patch?.e164).toBe('+442079460958');

    const noRaw = normalizeOne(
      identifier({ kind: 'phone', raw_value: null, value_normalized: '2079460958' }),
    );

    expect(noRaw?.e164).toBeNull();
  });

  it('never puts an e164 on a non-phone', () => {
    expect(normalizeOne(identifier({ kind: 'email' }))?.e164).toBeNull();
    expect(normalizeOne(identifier({ kind: 'name', raw_value: 'Liam Broza' }))?.e164).toBeNull();
  });

  it('folds diacritics on a display-name handle', () => {
    expect(normalizeOne(identifier({ kind: 'name', raw_value: 'José  GARCÍA' }))?.target).toBe('jose garcia');
  });

  it.each([['url'], ['gtin'], ['discord']])('refuses the unsupported kind %s', (kind) => {
    // `ci.entity_identifiers` CHECKs kind IN (email, phone, name). Anything else
    // is somebody else's row and is reported, never rewritten.
    expect(normalizeOne(identifier({ kind }))).toBeNull();
  });

  it('refuses a value the rule rejects rather than deleting the row', () => {
    // A real row somebody wrote. Removing it would be this stage deciding a
    // question it was not asked.
    expect(normalizeOne(identifier({ raw_value: '   ', value_normalized: '   ' }))).toBeNull();
    expect(
      normalizeOne(identifier({ kind: 'phone', raw_value: 'no digits', value_normalized: 'x' })),
    ).toBeNull();
  });

  it('reports a raw value carrying an extension as unnormalizable, and never rewrites it', () => {
    // The row a person-form number with an extension was stored as: its key is
    // the truncation. The v2 rule refuses the raw value, and this stage never
    // deletes, so it is counted and left for the repair migration
    // (20260930020117) — which is the reason that migration exists.
    expect(
      normalizeOne(
        identifier({ kind: 'phone', raw_value: '(212) 555-0147;229', value_normalized: '5550147229' }),
      ),
    ).toBeNull();
  });

  it('cannot see a truncation whose raw value was never kept', () => {
    // The importer's rows: `properties.phones` held the key itself, so the index
    // row has no raw value and its key is a fixed point of every generation of
    // the rule. Pinned because it is the limit of what a rule bump can repair —
    // those rows are found by the migration from the card's typed `Phones`.
    const patch = normalizeOne(
      identifier({ kind: 'phone', raw_value: null, value_normalized: '5550147229' }),
    );

    expect(patch?.target).toBe('5550147229');
    expect(patch?.target).toBe(patch?.currentValue);
  });

  it('is idempotent — the second pass computes the same target', () => {
    const first = normalizeOne(identifier({ raw_value: 'Liam@Example.COM' }));
    const second = normalizeOne(
      identifier({ raw_value: 'Liam@Example.COM', value_normalized: first?.target ?? '' }),
    );

    expect(second?.target).toBe(first?.target);
    expect(second?.target).toBe(second?.currentValue);
  });
});

/* ===================================================================== *
 * Convergence
 * ===================================================================== */

function patch(overrides: Partial<IdentifierPatch> = {}): IdentifierPatch {
  return {
    entityId: entityId(1),
    kind: 'phone',
    currentValue: '4155550100',
    target: '4155550100',
    e164: null,
    ...overrides,
  };
}

describe('resolveConvergence', () => {
  it('lets one of two converging identifiers through', () => {
    // `"+1 (415) 555-0100"` and `"415.555.0100"` both become `4155550100`. A
    // single UPDATE moving both would raise a unique violation and take the
    // whole slice down, charging 200 healthy entities an attempt for one merge.
    const { writable, converged } = resolveConvergence([
      patch({ currentValue: 'a' }),
      patch({ currentValue: 'b' }),
    ]);

    expect(writable).toHaveLength(1);
    expect(converged).toHaveLength(1);
    expect(writable[0].currentValue).toBe('a');
  });

  it('keeps different kinds apart even at the same value', () => {
    const { writable, converged } = resolveConvergence([
      patch({ kind: 'phone', target: 'x' }),
      patch({ kind: 'name', target: 'x' }),
    ]);

    expect(writable).toHaveLength(2);
    expect(converged).toHaveLength(0);
  });

  it('is deterministic in slice order, so a retry keeps the same winner', () => {
    const input = [patch({ currentValue: 'a' }), patch({ currentValue: 'b' })];

    expect(resolveConvergence(input).writable).toEqual(resolveConvergence(input).writable);
  });

  it('never drops a row — every patch is accounted for', () => {
    const input = [patch({ currentValue: 'a' }), patch({ currentValue: 'b' }), patch({ target: 'z' })];
    const { writable, converged } = resolveConvergence(input);

    expect(writable.length + converged.length).toBe(input.length);
  });
});

/* ===================================================================== *
 * run() — the slice
 * ===================================================================== */

interface RunHarness {
  stage: IdentifierNormalizeStage;
  statements: Array<{ sql: string; params: unknown[] }>;
  update(): { sql: string; params: unknown[] } | undefined;
}

function makeStage(
  opts: {
    present?: string[];
    identifiers?: IdentifierRow[];
    /** `(entity|kind|value)` keys the guarded UPDATE refuses to write. */
    blocked?: string[];
    writeError?: Error;
  } = {},
): RunHarness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const present = opts.present ?? [];
  const blocked = new Set(opts.blocked ?? []);

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params: params ?? [] });

    if (/FROM ci\.entities e/i.test(sql)) {
      const [ids] = (params ?? []) as [string[]];

      return ids.filter((id) => present.includes(id)).map((entity_id) => ({ entity_id }));
    }

    if (/FROM ci\.entity_identifiers ei/i.test(sql)) {
      const [ids] = (params ?? []) as [string[]];

      return (opts.identifiers ?? []).filter((row) => ids.includes(row.entity_id));
    }

    if (opts.writeError != null) {
      throw opts.writeError;
    }

    // The guarded UPDATE, modelled: a patch whose target is already held by
    // another entity matches nothing and so is absent from RETURNING.
    const [entityIds, kinds, , targets] = (params ?? []) as [string[], string[], string[], string[]];

    return entityIds
      .map((entity_id, index) => ({
        entity_id,
        kind: kinds[index],
        value_normalized: targets[index],
      }))
      .filter((row) => !blocked.has(`${row.entity_id}|${row.kind}|${row.value_normalized}`));
  });

  const stage = new IdentifierNormalizeStage({ query } as never, makeLogger() as never);

  return {
    stage,
    statements,
    update: () => statements.find((statement) => /^with normalized as/i.test(statement.sql)),
  };
}

const CTX = { userId: USER } as never;

describe('run', () => {
  it('returns exactly one result per id', async () => {
    const { stage } = makeStage({ present: [entityId(1)] });

    const results = await stage.run(CTX, [entityId(1), entityId(2)]);

    expect([...results.keys()].sort()).toEqual([entityId(1), entityId(2)]);
  });

  it('skips an entity that is gone', async () => {
    const { stage } = makeStage({ present: [] });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('skips an entity with no identifiers, with a reason', async () => {
    // The overwhelming majority on an appliance where `enrich.person_link` has
    // not run — countable precisely so that is visible.
    const { stage } = makeStage({ present: [entityId(1)] });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toEqual({ outcome: 'skipped', reason: 'no_identifiers' });
  });

  it('records a repaired identifier', async () => {
    const { stage } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier({ raw_value: 'Liam@Example.COM', value_normalized: 'Liam@Example.COM' })],
    });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toMatchObject({
      outcome: 'done',
      detail: { examined: 1, repaired: 1, unchanged: 0 },
    });
  });

  it('records an already-correct identifier as unchanged, not as repaired', async () => {
    const { stage } = makeStage({ present: [entityId(1)], identifiers: [identifier()] });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toMatchObject({
      outcome: 'done',
      detail: { repaired: 0, unchanged: 1 },
    });
  });

  it('counts the e164 forms it derived', async () => {
    const { stage } = makeStage({
      present: [entityId(1)],
      identifiers: [
        identifier({ kind: 'phone', raw_value: '+44 20 7946 0958', value_normalized: '2079460958' }),
        identifier({ kind: 'phone', raw_value: '415-555-0100', value_normalized: '4155550100' }),
      ],
    });

    const results = await stage.run(CTX, [entityId(1)]);

    // One country was stated; the other was not, and was not guessed.
    expect(results.get(entityId(1))).toMatchObject({ outcome: 'done', detail: { e164: 1 } });
  });

  it('reports a collision instead of resolving it', async () => {
    // THE interesting outcome. The target value is already held by another
    // entity, so the UPDATE cannot move the row — and the reason it cannot is
    // that the two entities are probably the same person. Both rows stay.
    const { stage } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier({ raw_value: 'Liam@Example.COM', value_normalized: 'Liam@Example.COM' })],
      blocked: [`${entityId(1)}|email|liam@example.com`],
    });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'normalization_collides',
      detail: { collided: 1 },
    });
  });

  it('reports two of one entity’s identifiers converging, and writes only one', async () => {
    const { stage, update } = makeStage({
      present: [entityId(1)],
      identifiers: [
        identifier({ kind: 'phone', raw_value: '+1 (415) 555-0100', value_normalized: 'a' }),
        identifier({ kind: 'phone', raw_value: '415.555.0100', value_normalized: 'b' }),
      ],
    });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'normalization_collides',
      detail: { converged: 1 },
    });
    expect(((update()?.params ?? [])[0] as string[]).length).toBe(1);
  });

  it('skips an entity whose identifiers are all unnormalizable', async () => {
    const { stage } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier({ kind: 'url', raw_value: 'https://example.com' })],
    });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'identifiers_unnormalizable',
    });
  });

  it('gives every non-done outcome a reason', async () => {
    const { stage } = makeStage({
      present: [entityId(1), entityId(2)],
      identifiers: [identifier({ entity_id: entityId(2), kind: 'url' })],
    });

    const results = await stage.run(CTX, [entityId(1), entityId(2), entityId(3)]);

    for (const [id, result] of results) {
      if (result.outcome !== 'done') {
        expect([id, result.reason]).toEqual([id, expect.any(String)]);
      }
    }
  });

  it('issues one guarded UPDATE for the whole slice', async () => {
    const { stage, statements } = makeStage({
      present: [entityId(1), entityId(2)],
      identifiers: [identifier(), identifier({ entity_id: entityId(2), raw_value: 'x@example.com' })],
    });

    await stage.run(CTX, [entityId(1), entityId(2)]);

    expect(statements.filter((statement) => /^with normalized as/i.test(statement.sql))).toHaveLength(1);
  });

  it('fails — not skips — when the write throws', async () => {
    const { stage } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier()],
      writeError: new Error('deadlock detected'),
    });

    const results = await stage.run(CTX, [entityId(1)]);

    expect(results.get(entityId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'identifier_write_failed',
    });
  });

  it('scopes every statement to the user', async () => {
    const { stage, statements } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier()],
    });

    await stage.run(CTX, [entityId(1)]);

    for (const statement of statements) {
      expect(statement.params).toContain(USER);
    }
  });
});

/* ===================================================================== *
 * Nothing is destroyed
 * ===================================================================== */

describe('the write cannot destroy a row', () => {
  it('never issues a DELETE', async () => {
    // Two identifiers collapsing into one is a DUPLICATE FINDING, not a licence
    // to remove one. Findings go to `clean.duplicate_detect`.
    const { stage, statements } = makeStage({
      present: [entityId(1)],
      identifiers: [
        identifier({ kind: 'phone', raw_value: '+1 (415) 555-0100', value_normalized: 'a' }),
        identifier({ kind: 'phone', raw_value: '415.555.0100', value_normalized: 'b' }),
      ],
    });

    await stage.run(CTX, [entityId(1)]);

    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/\bDELETE\b/i);
    }
  });

  it('never writes raw_value — the original the derived column is computed from', async () => {
    const { stage, update } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier({ raw_value: 'Liam@Example.COM', value_normalized: 'Liam@Example.COM' })],
    });

    await stage.run(CTX, [entityId(1)]);

    // This is the entire justification for updating in place rather than writing
    // a correction row: `value_normalized` is DERIVED from `raw_value`, and
    // `raw_value` is never touched, so the repair is recomputable and reversible.
    expect(update()?.sql).not.toMatch(/SET[\s\S]*raw_value\s*=/i);
    expect(update()?.sql).toMatch(/SET value_normalized = u\.target/);
  });

  it('guards the move with NOT EXISTS rather than ON CONFLICT DO NOTHING', async () => {
    // An unguarded UPDATE raises a unique violation and fails the whole slice; a
    // DO NOTHING upsert silently drops the row. The guard makes the collision a
    // non-event at the database and a REPORTED one in the ledger.
    const { stage, update } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier({ raw_value: 'Liam@Example.COM', value_normalized: 'Liam@Example.COM' })],
    });

    await stage.run(CTX, [entityId(1)]);

    expect(update()?.sql).toMatch(/NOT EXISTS \( SELECT 1 FROM ci\.entity_identifiers other/i);
    expect(update()?.sql).toMatch(/u\.target = u\.current_value OR NOT EXISTS/i);
    expect(update()?.sql).not.toMatch(/ON CONFLICT/i);
  });

  it('reads back what the database actually did, not what it predicted', async () => {
    // The guard's subquery races every other writer of this table, so the
    // collision report has to come from RETURNING.
    const { stage, update } = makeStage({
      present: [entityId(1)],
      identifiers: [identifier()],
    });

    await stage.run(CTX, [entityId(1)]);

    // `WITH … SELECT`, not a bare `UPDATE … RETURNING`: TypeORM hands back the
    // pair `[rows, rowCount]` for the latter.
    expect(update()?.sql).toMatch(/^WITH normalized AS \( UPDATE/i);
    expect(update()?.sql).toMatch(/SELECT \* FROM normalized$/i);
  });
});

/* ===================================================================== *
 * Selection
 * ===================================================================== */

interface SourceRow {
  id: string;
  user_id: string;
  is_active: boolean | null;
  merged_into_entity_id: string | null;
}

interface LedgerRow {
  stageVersion: number;
  status: 'done' | 'skipped' | 'failed' | 'quarantined' | 'running' | 'pending';
  nextAttemptAt: Date | null;
}

function makeLedgerHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      const [entityType, stageId, userId, version, cursor, limit] = (params ?? []) as [
        string,
        string,
        string,
        number,
        string | null,
        number,
      ];

      return rows
        .filter((row) => row.user_id === userId)
        .filter((row) => (row.is_active ?? true) === true && row.merged_into_entity_id == null)
        .filter((row) => {
          const entry = ledger.get(`${entityType}|${row.id}|${stageId}`);

          return entry === undefined || entry.stageVersion < version;
        })
        .filter((row) => cursor == null || row.id > cursor)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((row) => ({ id: row.id }));
    }

    return [];
  });

  return {
    service: new PipelineStateService({ query } as never, makeLogger() as never),
    seed: (id: string, entry: LedgerRow) =>
      ledger.set(`${ENTITY_TYPE}|${id}|${CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID}`, entry),
  };
}

describe('candidate selection', () => {
  const stage = new IdentifierNormalizeStage({ query: jest.fn() } as never, makeLogger() as never);

  it('does not predicate on a spec_version column', () => {
    // The plan's §12 checklist asks for `ci.entity_identifiers.spec_version` and
    // `WHERE spec_version < $current`. That is the ratchet with a version bolted
    // on: a column per stage per table, no way to express "tried and correctly
    // changed nothing", and nowhere to put a reason. `ci.pipeline_state` answers
    // all three, so no such column is proposed.
    expect(IDENTIFIER_NORMALIZE_SOURCE.predicate).not.toMatch(/spec_version|value_normalized|value_e164/);
  });

  it('does not reach into the ledger from the predicate', () => {
    expect(IDENTIFIER_NORMALIZE_SOURCE.predicate).not.toMatch(/pipeline_state|\bp\./);
  });

  it('sweeps entities, because entity_identifiers has no single-column identity', () => {
    // Its natural key is (owner_user_id, kind, value_normalized) and its only
    // uuid column is not unique in it, so paging over it directly would key
    // several rows' outcomes onto one ledger cell and lose all but the last.
    expect(IDENTIFIER_NORMALIZE_SOURCE.table).toBe('entities');
    expect(IDENTIFIER_NORMALIZE_SOURCE.idColumn).toBe('entity_id');
  });

  it('re-normalizes a converged entity when the rule generation rises', async () => {
    // The whole point: improving `normalizeIdentifier` re-runs history, which
    // `WHERE value_normalized <> normalize(raw_value)` could never express
    // because it cannot see a rule that has not been applied yet.
    const harness = makeLedgerHarness([
      { id: entityId(1), user_id: USER, is_active: true, merged_into_entity_id: null },
    ]);

    harness.seed(entityId(1), {
      stageVersion: IDENTIFIER_NORMALIZE_VERSION,
      status: 'done',
      nextAttemptAt: null,
    });

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([]);

    const bumped = { ...stage, version: IDENTIFIER_NORMALIZE_VERSION + 1 } as typeof stage;

    await expect(harness.service.selectStale(bumped, USER, null, 10)).resolves.toEqual([entityId(1)]);
  });

  it('re-opens a collision skip on a bump', async () => {
    // A `normalization_collides` row is the one most worth revisiting: the
    // collision may have been resolved by a merge in the meantime.
    const harness = makeLedgerHarness([
      { id: entityId(1), user_id: USER, is_active: true, merged_into_entity_id: null },
    ]);

    harness.seed(entityId(1), {
      stageVersion: IDENTIFIER_NORMALIZE_VERSION,
      status: 'skipped',
      nextAttemptAt: null,
    });

    const bumped = { ...stage, version: IDENTIFIER_NORMALIZE_VERSION + 1 } as typeof stage;

    await expect(harness.service.selectStale(bumped, USER, null, 10)).resolves.toEqual([entityId(1)]);
  });

  it('excludes tombstones', async () => {
    const harness = makeLedgerHarness([
      { id: entityId(1), user_id: USER, is_active: true, merged_into_entity_id: entityId(9) },
      { id: entityId(2), user_id: USER, is_active: true, merged_into_entity_id: null },
    ]);

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([entityId(2)]);
  });
});
