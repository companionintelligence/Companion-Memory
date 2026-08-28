import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  CLEAN_DUPLICATE_DETECT_STAGE_ID,
  DUPLICATE_DETECT_SOURCE,
  DUPLICATE_DETECT_VERSION,
  DuplicateDetectStage,
  IDENTIFIER_KIND_SCORES,
  MAX_GROUP_MEMBERS,
  MAX_NAME_CLUSTER,
  MIN_CANDIDATE_SCORE,
  PHONE_MATCH_SCORES,
  type SharedClaim,
  buildCandidates,
  buildNameOverlapCandidates,
  claimScore,
  duplicateDetectStageVersion,
  mergeCandidateLists,
  scorePair,
} from '../clean/DuplicateDetectStage';

/**
 * `clean.duplicate_detect` — proposes, never merges.
 *
 * The tests are ordered by what would hurt most if it were wrong:
 *
 *  1. **There is no merge path.** Asserted structurally, against the SQL the
 *     stage actually issues, because the cost is asymmetric to the point of
 *     absurdity: a wrong proposal costs one click, and a wrong merge repoints
 *     every communication, event and relationship of two people and deletes
 *     their embeddings. `PersonMergeService` writes an audit row; unpicking it
 *     is a migration, not an undo.
 *  2. **A human's decision is not overwritten.** The upsert refreshes only
 *     `status = 'pending'` rows. A rejected pair that came back every sweep
 *     would train the user to stop reading the queue, which is how a proposal
 *     system dies quietly.
 *  3. **Evidence travels with the score.** "Are these the same person? 0.95" is
 *     unanswerable; "they share liam@example.com" is answerable.
 *  4. The usual ledger discipline: one result per id, every non-`done` outcome
 *     carries a reason, and selection never anti-joins the output table.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const ENTITY_TYPE = 'entity';

function personId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function claim(overrides: Partial<SharedClaim> = {}): SharedClaim {
  return {
    subject_id: personId(1),
    other_id: personId(2),
    kind: 'email',
    value_normalized: 'liam@example.com',
    subject_e164: null,
    other_e164: null,
    group_size: 2,
    ...overrides,
  };
}

/* ===================================================================== *
 * The version
 * ===================================================================== */

describe('the version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(DUPLICATE_DETECT_VERSION)).toBe(true);
    expect(DUPLICATE_DETECT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('tolerates a STAGE_VERSIONS map with no entry yet', () => {
    expect(duplicateDetectStageVersion({})).toBe(DUPLICATE_DETECT_VERSION);
  });

  it('throws when the central declaration disagrees', () => {
    expect(() =>
      duplicateDetectStageVersion({ [CLEAN_DUPLICATE_DETECT_STAGE_ID]: DUPLICATE_DETECT_VERSION + 2 }),
    ).toThrow(/versions\.ts in the same commit/);
  });

  it('is monotone in each generation, so a bump can only go up', () => {
    // A hash would be uniformly distributed and would move the version DOWN half
    // the time, which pins the corpus to the abandoned high-water mark forever.
    // A sum cannot. 4 = DUPLICATE_SCORING_GENERATION (3, name token-subset
    // overlap) + DUPLICATE_CANDIDATE_GENERATION (2, since enrich.person_self_claim
    // widened the evidence set) - 1.
    expect(DUPLICATE_DETECT_VERSION).toBe(4);
  });
});

/* ===================================================================== *
 * Scoring
 * ===================================================================== */

describe('scorePair', () => {
  it('scores an email match highest', () => {
    expect(scorePair([claim()])?.score).toBe(IDENTIFIER_KIND_SCORES.email);
  });

  it('takes the strongest kind, never the sum', () => {
    // Two shared emails are ONE fact observed twice. A rule that added them
    // would let a pair clear any floor by finding more copies of the same thing.
    const candidate = scorePair([
      claim({ kind: 'name', value_normalized: 'liam broza' }),
      claim({ kind: 'email', value_normalized: 'a@example.com' }),
      claim({ kind: 'email', value_normalized: 'b@example.com' }),
      claim({ kind: 'phone', value_normalized: '4155550100' }),
    ]);

    expect(candidate?.score).toBe(IDENTIFIER_KIND_SCORES.email);
    expect(candidate?.score).toBeLessThanOrEqual(1);
  });

  it('keeps every piece of evidence, strongest first', () => {
    // The evidence is the load-bearing half of the proposal.
    const candidate = scorePair([
      claim({ kind: 'name', value_normalized: 'liam broza' }),
      claim({ kind: 'phone', value_normalized: '4155550100' }),
      claim({ kind: 'email', value_normalized: 'a@example.com' }),
    ]);

    expect(candidate?.evidence.map((piece) => piece.kind)).toEqual(['email', 'phone', 'name']);
    expect(candidate?.evidence[0]).toEqual({
      kind: 'email',
      value: 'a@example.com',
      score: IDENTIFIER_KIND_SCORES.email,
    });
  });

  it('de-duplicates identical evidence', () => {
    const candidate = scorePair([claim(), claim(), claim()]);

    expect(candidate?.evidence).toHaveLength(1);
  });

  it('orders the pair so (a, b) and (b, a) are one candidate', () => {
    // `ci.merge_candidates` carries `CHECK (entity_id_a < entity_id_b)` and a
    // UNIQUE on the ordered pair, so the ordering happens before SQL sees it.
    const forwards = scorePair([claim({ subject_id: personId(1), other_id: personId(2) })]);
    const backwards = scorePair([claim({ subject_id: personId(2), other_id: personId(1) })]);

    expect(forwards?.entityIdA).toBe(personId(1));
    expect(forwards?.entityIdB).toBe(personId(2));
    expect(backwards).toEqual(forwards);
  });

  it('ignores a claim kind nobody has calibrated', () => {
    // Defaulting a weight for an unknown kind is the fabricated confidence
    // `types.ts` forbids.
    expect(scorePair([claim({ kind: 'discord_handle' })])).toBeNull();
  });

  it('returns nothing for no claims', () => {
    expect(scorePair([])).toBeNull();
  });

  it('keeps every calibrated score inside (0, 1]', () => {
    for (const score of Object.values(IDENTIFIER_KIND_SCORES)) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }

    // A name match is the weakest thing that still surfaces, and it sits well
    // below any plausible auto-merge floor. Two people called "John Smith" are a
    // question, not an answer.
    expect(IDENTIFIER_KIND_SCORES.name).toBe(MIN_CANDIDATE_SCORE);
    expect(IDENTIFIER_KIND_SCORES.phone).toBeLessThan(IDENTIFIER_KIND_SCORES.email);
  });
});

describe('phone evidence is adjudicated against value_e164', () => {
  // The discount this replaces was explicitly provisional: 0.85 for EVERY phone
  // match, "until clean.identifier_normalize gives every claim an E.164 form".
  // That form exists now — the column is on ci.identifier_claims, both claim
  // producers write it, and on the dev corpus 9,421 of 9,421 phone claims carry
  // one — so the tiers below are what the evidence can actually distinguish.

  function phone(overrides: Partial<SharedClaim> = {}): SharedClaim {
    return claim({ kind: 'phone', value_normalized: '2079460958', ...overrides });
  }

  it('ranks the three tiers strictly: exact E.164 > one side stated > neither stated', () => {
    const exact = claimScore(phone({ subject_e164: '+442079460958', other_e164: '+442079460958' }));
    const partial = claimScore(phone({ subject_e164: '+442079460958', other_e164: null }));
    const last10 = claimScore(phone());

    expect(exact).toBeGreaterThan(partial as number);
    expect(partial).toBeGreaterThan(last10 as number);

    // The middle tier IS the old behaviour, unchanged, for the case the
    // widening does not reach.
    expect(partial).toBe(IDENTIFIER_KIND_SCORES.phone);
  });

  it('scores an exact E.164 match above the flat discount it replaces', () => {
    expect(claimScore(phone({ subject_e164: '+442079460958', other_e164: '+442079460958' }))).toBe(
      PHONE_MATCH_SCORES.e164Exact,
    );
    expect(PHONE_MATCH_SCORES.e164Exact).toBeGreaterThan(0.85);
  });

  it('scores a country-less last-ten match below it, and below a handle', () => {
    expect(claimScore(phone())).toBe(PHONE_MATCH_SCORES.last10Only);
    expect(PHONE_MATCH_SCORES.last10Only).toBeLessThan(0.85);

    // A handle is unique in its namespace at any instant; ten digits with no
    // country stated anywhere are not unique across namespaces at all.
    expect(PHONE_MATCH_SCORES.last10Only).toBeLessThan(IDENTIFIER_KIND_SCORES.handle);
    expect(PHONE_MATCH_SCORES.last10Only).toBeGreaterThan(IDENTIFIER_KIND_SCORES.name);
  });

  it('refuses a pair whose two sides state DIFFERENT countries', () => {
    // UK +44 20 7946 0958 and US (207) 946-0958 share the last ten digits and
    // are provably not the same number. `enrich.person_link` refuses the same
    // match outright (phone_country_conflict); this is that rule, one table over.
    const conflicted = phone({ subject_e164: '+442079460958', other_e164: '+12079460958' });

    expect(claimScore(conflicted)).toBeNull();
    expect(scorePair([conflicted])).toBeNull();
  });

  it('keeps a conflicted phone from carrying a pair that has nothing else', () => {
    const { candidates } = buildCandidates([
      phone({
        subject_id: personId(1),
        other_id: personId(2),
        subject_e164: '+442079460958',
        other_e164: '+12079460958',
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it('leaves the rest of a conflicted pair’s evidence alone', () => {
    // Refusing the phone is not refusing the pair: an email they genuinely
    // share still proposes them, and the phone simply is not evidence.
    const candidate = scorePair([
      phone({ subject_e164: '+442079460958', other_e164: '+12079460958' }),
      claim({ kind: 'email', value_normalized: 'liam@example.com' }),
    ]);

    expect(candidate?.evidence.map((piece) => piece.kind)).toEqual(['email']);
    expect(candidate?.score).toBe(IDENTIFIER_KIND_SCORES.email);
  });

  it('keeps every phone tier inside the score CHECK the table enforces', () => {
    // `merge_candidates_score_check CHECK (score > 0 AND score <= 1)`.
    for (const score of Object.values(PHONE_MATCH_SCORES)) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('does not touch a non-phone kind', () => {
    expect(claimScore(claim({ subject_e164: '+442079460958', other_e164: '+12079460958' }))).toBe(
      IDENTIFIER_KIND_SCORES.email,
    );
  });
});

describe('buildCandidates', () => {
  it('collapses the two directions of one pair into one candidate', () => {
    // Both people are usually in the same corpus, so both directions arrive.
    const { candidates } = buildCandidates([
      claim({ subject_id: personId(1), other_id: personId(2) }),
      claim({ subject_id: personId(2), other_id: personId(1) }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence).toHaveLength(1);
  });

  it('keeps distinct pairs apart', () => {
    const { candidates } = buildCandidates([
      claim({ subject_id: personId(1), other_id: personId(2) }),
      claim({ subject_id: personId(1), other_id: personId(3), value_normalized: 'x@example.com' }),
    ]);

    expect(candidates).toHaveLength(2);
  });

  it('drops a value shared by more subjects than the cap', () => {
    // `info@`, `noreply@`, a family landline. A 6-way group is 15 pairs and a
    // 100-way group is 4,950 — enough to bury every real duplicate in a queue
    // nobody can finish.
    const { candidates, suppressed } = buildCandidates([
      claim({ value_normalized: 'info@example.com', group_size: MAX_GROUP_MEMBERS + 1 }),
    ]);

    expect(candidates).toEqual([]);
    expect(suppressed.has(personId(1))).toBe(true);
  });

  it('keeps a group exactly at the cap', () => {
    const { candidates } = buildCandidates([claim({ group_size: MAX_GROUP_MEMBERS })]);

    expect(candidates).toHaveLength(1);
  });

  it('suppresses only the over-common value, not the whole person', () => {
    // A person with a role address AND a personal one keeps the personal match.
    const { candidates } = buildCandidates([
      claim({ value_normalized: 'info@example.com', group_size: 40 }),
      claim({ value_normalized: 'liam@example.com', group_size: 2 }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence[0].value).toBe('liam@example.com');
  });
});

describe('buildNameOverlapCandidates', () => {
  function names(...pairs: Array<[number, string]>) {
    return pairs.map(([n, name]) => ({ entity_id: personId(n), name }));
  }

  it('proposes mr broza against william d broza', () => {
    const { candidates } = buildNameOverlapCandidates(
      names([1, 'Mr Broza'], [2, 'William D Broza']),
      new Set([personId(1)]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence[0]).toEqual(
      expect.objectContaining({ kind: 'name_overlap', value: 'broza' }),
    );
  });

  it('refuses john smith against john jones', () => {
    const { candidates } = buildNameOverlapCandidates(
      names([1, 'John Smith'], [2, 'John Jones']),
      new Set([personId(1)]),
    );

    expect(candidates).toEqual([]);
  });

  it('clusters a bare given name against several fuller matches', () => {
    const { candidates } = buildNameOverlapCandidates(
      names([1, 'william'], [2, 'William Broza'], [3, 'William Smith']),
      new Set([personId(1)]),
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.evidence.some((item) => item.kind === 'name_cluster'))).toBe(
      true,
    );
  });

  it('drops a given name that fits more people than the cluster cap', () => {
    const rows = names(
      [1, 'william'],
      ...Array.from({ length: MAX_NAME_CLUSTER + 1 }, (_, index) => [index + 2, `William Extra${index}`] as [
        number,
        string,
      ]),
    );

    const { candidates } = buildNameOverlapCandidates(rows, new Set([personId(1)]));

    expect(candidates).toEqual([]);
  });

  it('does not propose a pair that touches nobody in the slice', () => {
    const { candidates } = buildNameOverlapCandidates(
      names([1, 'Mr Broza'], [2, 'William D Broza']),
      new Set([personId(9)]),
    );

    expect(candidates).toEqual([]);
  });
});

describe('mergeCandidateLists', () => {
  it('keeps email evidence and adds the name overlap on the same pair', () => {
    const exact = scorePair([claim()])!;
    const { candidates: nameCandidates } = buildNameOverlapCandidates(
      [
        { entity_id: personId(1), name: 'Mr Broza' },
        { entity_id: personId(2), name: 'William D Broza' },
      ],
      new Set([personId(1)]),
    );

    const merged = mergeCandidateLists([exact], nameCandidates);

    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(IDENTIFIER_KIND_SCORES.email);
    expect(merged[0].evidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['email', 'name_overlap']),
    );
  });
});

/* ===================================================================== *
 * run() — the slice
 * ===================================================================== */

interface RunHarness {
  stage: DuplicateDetectStage;
  statements: Array<{ sql: string; params: unknown[] }>;
  insert(): { sql: string; params: unknown[] } | undefined;
}

function makeStage(
  opts: {
    present?: string[];
    /** Claims per person. Defaults to 1 — i.e. identity HAS reached them. */
    claimCounts?: Record<string, number>;
    claims?: SharedClaim[];
    writeError?: Error;
  } = {},
): RunHarness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const present = opts.present ?? [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params: params ?? [] });

    if (/claim_count/i.test(sql) && /FROM ci\.entities e/i.test(sql)) {
      const [ids] = (params ?? []) as [string[]];

      return ids
        .filter((id) => present.includes(id))
        .map((entity_id) => ({ entity_id, claim_count: opts.claimCounts?.[entity_id] ?? 1 }));
    }

    if (/e\.name/i.test(sql) && /FROM ci\.entities e/i.test(sql)) {
      return [];
    }

    if (/identifier_claims/i.test(sql) && /^with/i.test(sql)) {
      const [ids] = (params ?? []) as [string[]];

      return (opts.claims ?? []).filter((candidate) => ids.includes(candidate.subject_id));
    }

    if (opts.writeError != null) {
      throw opts.writeError;
    }

    return [];
  });

  const stage = new DuplicateDetectStage({ query } as never, makeLogger() as never);

  return {
    stage,
    statements,
    insert: () => statements.find((statement) => /^insert/i.test(statement.sql)),
  };
}

const CTX = { userId: USER } as never;

describe('run', () => {
  it('returns exactly one result per id', async () => {
    const { stage } = makeStage({ present: [personId(1), personId(2)] });

    const results = await stage.run(CTX, [personId(1), personId(2), personId(3)]);

    expect([...results.keys()].sort()).toEqual([personId(1), personId(2), personId(3)]);
  });

  it('records a person with NO claims at all as skipped, with a reason', async () => {
    // The number that says how much of the corpus `enrich.person_link` has not
    // reached yet — a silence today, a count here.
    const { stage } = makeStage({ present: [personId(1)], claimCounts: { [personId(1)]: 0 } });

    const results = await stage.run(CTX, [personId(1)]);

    expect(results.get(personId(1))).toEqual({ outcome: 'skipped', reason: 'no_identifier_claims' });
  });

  it('records a person with claims but no duplicate as DONE, not as missing claims', async () => {
    // The healthy majority of any corpus, and the distinction that decides
    // whether coverage reads as a gap in identity or as a clean result. The
    // evidence query returns only SHARED claims, so both cases look like silence
    // from inside it — which is why the claim count is asked for separately.
    const { stage } = makeStage({ present: [personId(1)], claimCounts: { [personId(1)]: 3 } });

    const results = await stage.run(CTX, [personId(1)]);

    expect(results.get(personId(1))).toMatchObject({ outcome: 'done', detail: { candidates: 0 } });
  });

  it('records a person whose every shared value is over-common as skipped', async () => {
    const { stage } = makeStage({
      present: [personId(1)],
      claims: [claim({ value_normalized: 'info@example.com', group_size: 99 })],
    });

    const results = await stage.run(CTX, [personId(1)]);

    expect(results.get(personId(1))).toEqual({
      outcome: 'skipped',
      reason: 'identifiers_too_common',
      detail: { maxGroupMembers: MAX_GROUP_MEMBERS },
    });
  });

  it('reports how many pairs it proposed for a person', async () => {
    const { stage } = makeStage({
      present: [personId(1), personId(2)],
      claims: [
        claim({ subject_id: personId(1), other_id: personId(2) }),
        claim({ subject_id: personId(2), other_id: personId(1) }),
      ],
    });

    const results = await stage.run(CTX, [personId(1), personId(2)]);

    expect(results.get(personId(1))).toMatchObject({ outcome: 'done', detail: { candidates: 1 } });
    expect(results.get(personId(2))).toMatchObject({ outcome: 'done', detail: { candidates: 1 } });
  });

  it('skips an id that is no longer a live person', async () => {
    // Deleted, deactivated, or already tombstoned by a merge between the sweep
    // and the slice. Proposing a merge for a tombstone puts an unactionable pair
    // in the review queue.
    const { stage } = makeStage({ present: [] });

    const results = await stage.run(CTX, [personId(1)]);

    expect(results.get(personId(1))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('gives every non-done outcome a reason', async () => {
    const { stage } = makeStage({
      present: [personId(1)],
      claims: [claim({ subject_id: personId(1), group_size: 99 })],
    });

    const results = await stage.run(CTX, [personId(1), personId(2)]);

    for (const [id, result] of results) {
      if (result.outcome !== 'done') {
        expect([id, result.reason]).toEqual([id, expect.any(String)]);
      }
    }
  });

  it('fails — not skips — when the candidate write throws', async () => {
    const { stage } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
      writeError: new Error('unique violation'),
    });

    const results = await stage.run(CTX, [personId(1), personId(2)]);

    expect(results.get(personId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'candidate_write_failed',
    });
  });

  it('does not query for evidence when nothing in the slice is live', async () => {
    const { stage, statements } = makeStage({ present: [] });

    await stage.run(CTX, [personId(1)]);

    expect(statements.filter((statement) => /^WITH mine AS/i.test(statement.sql))).toHaveLength(0);
  });

  it('scopes every statement to the user', async () => {
    const { stage, statements } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    for (const statement of statements) {
      expect(statement.params).toContain(USER);
    }
  });
});

/* ===================================================================== *
 * Propose, never merge
 * ===================================================================== */

describe('the stage cannot merge', () => {
  it('issues no statement that touches a merge target', async () => {
    // Structural, not a promise in a comment. `PersonMergeService` repoints
    // `entity_identifiers`, `communications.from_entity_id` / `to_entity_ids[]`,
    // `events.organizer_entity_id` / `participant_entity_ids[]` and every
    // relationship, then deletes embeddings — none of which may ever appear here.
    const { stage, statements } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/merged_into_entity_id\s*=/i);
      expect(statement.sql).not.toMatch(/^delete/i);
      expect(statement.sql).not.toMatch(/ci\.entity_merges\b/i);
      expect(statement.sql).not.toMatch(/UPDATE ci\.entities/i);
      expect(statement.sql).not.toMatch(/ci_search\.embeddings/i);
    }
  });

  it('writes candidates and nothing else', async () => {
    const { stage, statements } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    const writes = statements.filter((statement) => !/^(select|with)/i.test(statement.sql));

    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/^INSERT INTO ci\.merge_candidates/i);
  });

  it('never withdraws a proposal it previously made', async () => {
    // A rescoring bump that no longer finds a pair leaves the PENDING row alone.
    // A review queue whose contents change under the reviewer is worse than a
    // stale row; `detector_version` makes a stale one identifiable and a
    // deliberate reap possible.
    const { stage, statements } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/DELETE FROM ci\.merge_candidates/i);
    }
  });
});

describe('a human decision is final', () => {
  it('refreshes only rows still awaiting review', async () => {
    // A rejected pair returning on every sweep asks the same question forever,
    // which is how a review queue stops being read. The permanent "never ask
    // again" is `ci.entity_merge_blocks`, which the evidence query honours.
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    expect(insert()?.sql).toMatch(/ON CONFLICT \(owner_user_id, entity_type, entity_id_a, entity_id_b\)/i);
    expect(insert()?.sql).toMatch(/DO UPDATE SET[\s\S]*WHERE ci\.merge_candidates\.status = 'pending'/i);
  });

  it('honours the ordered-pair merge blocks BEFORE scoring', async () => {
    const { stage, statements } = makeStage({ present: [personId(1)] });

    await stage.run(CTX, [personId(1)]);

    const evidence = statements.find((statement) => /^WITH mine AS/i.test(statement.sql));

    // The block is the user's permanent "these are NOT the same person", so it
    // is applied in the evidence query rather than after: a blocked pair never
    // reaches the review queue and never costs a row.
    expect(evidence?.sql).toMatch(/ci\.entity_merge_blocks/i);

    // ONE probe, in the canonical order. `ci.entity_merge_blocks` carries
    // `CHECK (entity_id_a < entity_id_b)` (`entity_merge_blocks_ordered`,
    // verified against the live schema), so LEAST/GREATEST cannot miss a block
    // written the other way round — the database refuses to store one.
    expect(evidence?.sql).toMatch(/b\.entity_id_a = LEAST\(s\.subject_id, o\.entity_id\)/);
    expect(evidence?.sql).toMatch(/b\.entity_id_b = GREATEST\(s\.subject_id, o\.entity_id\)/);
  });

  it('excludes rejected claims and unresolved ones from the evidence', async () => {
    // A `disposition = 'rejected'` claim is a human's verdict that this
    // identifier does NOT belong to this entity, and the table keeps the row so
    // the rejection is not re-derived. Building a merge proposal out of one
    // would re-derive it by the back door.
    //
    // An `entity_id IS NULL` claim is the triage queue — an identifier that
    // resolved to nobody. That is evidence a PERSON is missing, which is
    // `enrich.person_link`'s problem, not evidence two people are the same.
    const { stage, statements } = makeStage({ present: [personId(1)] });

    await stage.run(CTX, [personId(1)]);

    const evidence = statements.find((statement) => /^WITH mine AS/i.test(statement.sql));

    // Four legs now: the swept subjects, the group-size count, the other side of
    // the join, and the other side's E.164 aggregate.
    expect(evidence?.sql.match(/disposition IS DISTINCT FROM 'rejected'/g)?.length).toBe(4);
    expect(evidence?.sql).toMatch(/o\.entity_id IS NOT NULL/);
  });

  it('groups on entity_id, not on the plan’s subject_id', async () => {
    // `subject_id` is WHERE the identifier was observed — a communication or an
    // event, for nearly every claim. `entity_id` is WHO it resolved to. Grouping
    // on the former would find duplicates only among contact-importer claims and
    // miss every duplicate evidenced by mail and calendar traffic.
    const { stage, statements } = makeStage({ present: [personId(1)] });

    await stage.run(CTX, [personId(1)]);

    const evidence = statements.find((statement) => /^WITH mine AS/i.test(statement.sql));

    expect(evidence?.sql).toMatch(/SELECT c\.entity_id AS subject_id/);
    expect(evidence?.sql).toMatch(/GROUP BY c\.entity_id, c\.kind, c\.value_normalized/);
    expect(evidence?.sql).not.toMatch(/subject_type/);
  });

  it('carries the evidence into the row, not just the score', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    const evidenceParam = (insert()?.params ?? [])[7] as string[];

    expect(JSON.parse(evidenceParam[0])).toEqual([
      { kind: 'email', value: 'liam@example.com', score: IDENTIFIER_KIND_SCORES.email },
    ]);
  });

  it('stamps the detector and its version onto every row', async () => {
    // Without it a regression in the scoring rule is unattributable and every
    // stale proposal looks current.
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    expect(insert()?.params).toContain(CLEAN_DUPLICATE_DETECT_STAGE_ID);
    expect(insert()?.params).toContain(DUPLICATE_DETECT_VERSION);
  });
});

/* ===================================================================== *
 * Selection
 * ===================================================================== */

interface SourceRow {
  id: string;
  user_id: string;
  entity_type: string;
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
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      const [entityType, stageId, userId, version, cursor, limit] = (params ?? []) as [
        string,
        string,
        string,
        number,
        string | null,
        number,
      ];
      const now = Date.now();

      return rows
        .filter((row) => row.user_id === userId)
        .filter(
          (row) =>
            row.entity_type === 'Person' &&
            (row.is_active ?? true) === true &&
            row.merged_into_entity_id == null,
        )
        .filter((row) => {
          const entry = ledger.get(`${entityType}|${row.id}|${stageId}`);

          if (entry === undefined || entry.stageVersion < version) {
            return true;
          }

          return (
            entry.status === 'failed' && entry.nextAttemptAt != null && entry.nextAttemptAt.getTime() <= now
          );
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
    sweeps,
    seed: (entityId: string, entry: LedgerRow) =>
      ledger.set(`${ENTITY_TYPE}|${entityId}|${CLEAN_DUPLICATE_DETECT_STAGE_ID}`, entry),
  };
}

function sourceRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: personId(n),
    user_id: USER,
    entity_type: 'Person',
    is_active: true,
    merged_into_entity_id: null,
    ...overrides,
  };
}

describe('candidate selection', () => {
  const stage = new DuplicateDetectStage({ query: jest.fn() } as never, makeLogger() as never);

  it('never anti-joins its own output table', () => {
    // `WHERE NOT EXISTS (SELECT 1 FROM ci.merge_candidates …)` is the ratchet
    // wearing a different hat: a person would leave the candidate set the moment
    // one candidate was proposed for them, and a rescoring bump could never
    // reach them again.
    expect(DUPLICATE_DETECT_SOURCE.predicate).not.toContain('merge_candidates');
  });

  it('does not reach into the ledger from the predicate', () => {
    expect(DUPLICATE_DETECT_SOURCE.predicate).not.toMatch(/pipeline_state|\bp\./);
  });

  it('sweeps people, not pairs', () => {
    // The only shape the ledger can key — a pair has no id — and the only one
    // whose coverage means anything, since the pair set is quadratic and mostly
    // empty.
    expect(DUPLICATE_DETECT_SOURCE.table).toBe('entities');
    expect(DUPLICATE_DETECT_SOURCE.idColumn).toBe('entity_id');
    expect(DUPLICATE_DETECT_SOURCE.userColumn).toBe('owner_user_id');
  });

  it('re-examines an already-proposed person when the scoring rule improves', async () => {
    const harness = makeLedgerHarness([sourceRow(1)]);

    harness.seed(personId(1), {
      stageVersion: DUPLICATE_DETECT_VERSION,
      status: 'done',
      nextAttemptAt: null,
    });

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([]);

    const bumped = { ...stage, version: DUPLICATE_DETECT_VERSION + 1 } as typeof stage;

    await expect(harness.service.selectStale(bumped, USER, null, 10)).resolves.toEqual([personId(1)]);
  });

  it('excludes tombstones and inactive entities', async () => {
    const harness = makeLedgerHarness([
      sourceRow(1, { merged_into_entity_id: personId(9) }),
      sourceRow(2, { is_active: false }),
      sourceRow(3, { entity_type: 'File' }),
      sourceRow(4),
    ]);

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([personId(4)]);
  });
});

/* ===================================================================== *
 * Against real Postgres
 * ===================================================================== */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[DuplicateDetectStage.spec] SKIPPED (database half) — ${availability.reason}`);
}

jest.setTimeout(60_000);

/**
 * The half a fake cannot answer.
 *
 * Everything above asserts the SQL's TEXT and the pure functions. Neither can
 * tell you whether `count(DISTINCT value_e164) = 1` actually collapses a
 * subject's several claims into one E.164, whether the two aggregates line up
 * on the same (kind, value) as the join, or whether the upsert's
 * `WHERE status = 'pending'` really holds a rejection down across a version
 * bump — a fake agrees with whatever SQL it is handed.
 *
 * Nothing is committed: one transaction, rolled back in `afterAll`. No DDL is
 * applied, so no schema lock is needed — the three tables this block reads
 * (`ci.identifier_claims`, `ci.merge_candidates`, `ci.entity_merge_blocks`)
 * are all migrations that predate the stage itself.
 */
describeWithDatabase(`clean.duplicate_detect against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let ownerUserId: string;
  let results: Map<string, StageResult>;

  /** One person per role, so a pair's evidence is only ever its own. */
  const people = {
    exactA: randomUUID(),
    exactB: randomUUID(),
    partialA: randomUUID(),
    partialB: randomUUID(),
    last10A: randomUUID(),
    last10B: randomUUID(),
    conflictA: randomUUID(),
    conflictB: randomUUID(),
    blockedA: randomUUID(),
    blockedB: randomUUID(),
  };

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  function transactionalStage(): DuplicateDetectStage {
    return new DuplicateDetectStage(
      { query: (sql: string, params?: unknown[]) => runner.query(sql, params) } as never,
      makeLogger() as never,
    );
  }

  /** The pair as `ci.merge_candidates` stores it: ordered, a < b. */
  function pair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  function candidateFor(a: string, b: string) {
    const [entityIdA, entityIdB] = pair(a, b);

    return q<Array<{ score: number; status: string; detector_version: number; evidence: unknown }>>(
      `SELECT score, status, detector_version, evidence
         FROM ci.merge_candidates
        WHERE owner_user_id = $1 AND entity_id_a = $2 AND entity_id_b = $3`,
      [ownerUserId, entityIdA, entityIdB],
    ).then((rows) => rows[0]);
  }

  async function seedPerson(entityId: string, name: string): Promise<void> {
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', $2, '{}'::jsonb, $3)`,
      [entityId, name, ownerUserId],
    );
  }

  /**
   * A resolved phone claim. `role` varies so one entity may hold the same
   * number twice — which is the case the E.164 aggregate exists for.
   */
  async function seedPhoneClaim(
    entityId: string,
    valueNormalized: string,
    e164: string | null,
    role = 'self',
  ): Promise<void> {
    await q(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized,
          value_e164, entity_id, confidence, stage)
       VALUES ($1, 'person', $2, $3, 'phone', $4, $5, $2, 0.9, 'spec')`,
      [ownerUserId, entityId, role, valueNormalized, e164],
    );
  }

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('DuplicateDetectStage.spec ran with no database configured; the gate broke.');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });

    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ownerUserId = await createSyntheticTestUser((sql, params) => q(sql, params), 'DuplicateDetectStage');

    for (const [role, entityId] of Object.entries(people)) {
      await seedPerson(entityId, role);
    }

    // Each pair gets its OWN last-ten value: a shared one would put all ten
    // people in one group and MAX_GROUP_MEMBERS would suppress the lot.
    //
    // Both sides state the same country. The extra country-less claim on
    // `exactA` is the aggregate's job: one settled E.164 per subject, not two
    // rows differing only in a null.
    await seedPhoneClaim(people.exactA, '2079460958', '+442079460958');
    await seedPhoneClaim(people.exactA, '2079460958', null, 'from');
    await seedPhoneClaim(people.exactB, '2079460958', '+442079460958');

    // One side stated a country, the other never did.
    await seedPhoneClaim(people.partialA, '4155550100', '+14155550100');
    await seedPhoneClaim(people.partialB, '4155550100', null);

    // Neither side stated one: ten digits and nothing else.
    await seedPhoneClaim(people.last10A, '5105550111', null);
    await seedPhoneClaim(people.last10B, '5105550111', null);

    // The false identity the last-ten key cannot see: UK +44 20 7946 0959 and
    // US (207) 946-0959.
    await seedPhoneClaim(people.conflictA, '2079460959', '+442079460959');
    await seedPhoneClaim(people.conflictB, '2079460959', '+12079460959');

    // As strong as evidence gets — and permanently refused by the user.
    await seedPhoneClaim(people.blockedA, '6175550122', '+16175550122');
    await seedPhoneClaim(people.blockedB, '6175550122', '+16175550122');

    const [blockA, blockB] = pair(people.blockedA, people.blockedB);

    await q(
      `INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b, reason)
       VALUES ($1, $2, $3, 'spec')`,
      [ownerUserId, blockA, blockB],
    );

    results = await transactionalStage().run({ userId: ownerUserId } as never, Object.values(people));
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('ranks the three phone tiers strictly, on rows Postgres produced', async () => {
    const exact = await candidateFor(people.exactA, people.exactB);
    const partial = await candidateFor(people.partialA, people.partialB);
    const last10 = await candidateFor(people.last10A, people.last10B);

    expect(exact.score).toBeGreaterThan(partial.score);
    expect(partial.score).toBeGreaterThan(last10.score);

    expect(exact.score).toBeCloseTo(PHONE_MATCH_SCORES.e164Exact);
    expect(partial.score).toBeCloseTo(PHONE_MATCH_SCORES.e164Partial);
    expect(last10.score).toBeCloseTo(PHONE_MATCH_SCORES.last10Only);
  });

  it('carries the evidence that produced the score', async () => {
    const exact = await candidateFor(people.exactA, people.exactB);

    expect(exact.evidence).toEqual([
      { kind: 'phone', value: '2079460958', score: PHONE_MATCH_SCORES.e164Exact },
    ]);
  });

  it('proposes nothing for two numbers that state different countries', async () => {
    // The subject was still EXAMINED — this is a refusal, not a gap.
    expect(await candidateFor(people.conflictA, people.conflictB)).toBeUndefined();
    expect(results.get(people.conflictA)).toMatchObject({ outcome: 'done', detail: { candidates: 0 } });
  });

  it('still honours a merge block on the strongest new tier', async () => {
    // The pair matches exactly in E.164 — the highest score this stage can give
    // — and the user's permanent "these are NOT the same person" outranks it.
    expect(await candidateFor(people.blockedA, people.blockedB)).toBeUndefined();
    expect(results.get(people.blockedA)).toMatchObject({ outcome: 'done', detail: { candidates: 0 } });
  });

  it('keeps a rejected pair rejected across a generation bump, and rescores a pending one', async () => {
    const [a, b] = pair(people.exactA, people.exactB);

    await q(
      `UPDATE ci.merge_candidates SET status = 'rejected'
        WHERE owner_user_id = $1 AND entity_id_a = $2 AND entity_id_b = $3`,
      [ownerUserId, a, b],
    );

    const bumped = transactionalStage();

    // A generation bump, exactly as `versions.ts` describes one: the same stage,
    // one integer higher.
    Object.defineProperty(bumped, 'version', { value: DUPLICATE_DETECT_VERSION + 1 });

    await bumped.run({ userId: ownerUserId } as never, Object.values(people));

    const rejected = await candidateFor(people.exactA, people.exactB);
    const pending = await candidateFor(people.last10A, people.last10B);

    expect(rejected.status).toBe('rejected');
    expect(rejected.detector_version).toBe(DUPLICATE_DETECT_VERSION);

    // The contrast that makes the line above mean something: the upsert DID
    // reach the row still awaiting review.
    expect(pending.status).toBe('pending');
    expect(pending.detector_version).toBe(DUPLICATE_DETECT_VERSION + 1);
  });
});
