import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { hasPhoneExtension, normalizePhone } from '@ci/domains/graph';
import {
  PHONE_MAX_HOLDERS,
  PROFILE_URL_MAX_HOLDERS,
  PhoneHolders,
  parsePhone,
  phoneCorpusFacts,
  type PhoneClaimE164Row,
  type PhoneFactsCorpusRow,
} from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import { STAGE_VERSIONS } from '../../versions';
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
  type MergeCandidate,
  type ProfileFactsRow,
  type SharedClaim,
  adjudicateCandidatePhones,
  adjudicateCandidateProfiles,
  buildCandidates,
  buildNameOverlapCandidates,
  buildPhoneCandidates,
  buildProfileUrlCandidates,
  claimScore,
  duplicateDetectStageVersion,
  holdEmailPairs,
  mergeCandidateLists,
  profileFactsByEntity,
  scorePair,
} from '../clean/DuplicateDetectStage';
import { toE164 } from '../clean/IdentifierNormalizeStage';

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
    // A sum cannot. 8 = DUPLICATE_SCORING_GENERATION (6, fax lines refused by
    // the properties phone tier) + DUPLICATE_CANDIDATE_GENERATION (3, since
    // self claims carry every contact method a card states) - 1.
    expect(DUPLICATE_DETECT_VERSION).toBe(8);
    expect(STAGE_VERSIONS[CLEAN_DUPLICATE_DETECT_STAGE_ID]).toBe(DUPLICATE_DETECT_VERSION);
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
    expect(
      candidates.every((candidate) => candidate.evidence.some((item) => item.kind === 'name_cluster')),
    ).toBe(true);
  });

  it('drops a given name that fits more people than the cluster cap', () => {
    const rows = names(
      [1, 'william'],
      ...Array.from(
        { length: MAX_NAME_CLUSTER + 1 },
        (_, index) => [index + 2, `William Extra${index}`] as [number, string],
      ),
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
 * Profile URLs — the cross-source pass and its veto
 * ===================================================================== */

/*
 * The duplicate this pass exists for: one LinkedIn connection imported twice,
 * once from Connections.csv (`properties.URL`) and once from a contacts vCard
 * (the URL only as a NOTE `URL:` line). Every slug and name is invented.
 */
const SLUG_ADA = 'https://www.linkedin.com/in/ada-quillfeather-7x2';
const SLUG_OTHER_ADA = 'https://www.linkedin.com/in/ada-quillfeather-9m4';
const SLUG_BO = 'https://www.linkedin.com/in/bo-quillfeather-3k9';

function csvRow(n: number, name: string, url: string, connectedOn?: string): ProfileFactsRow {
  return {
    entity_id: personId(n),
    person_name: name,
    profile_props: { URL: url, ConnectedOn: connectedOn ?? null },
  };
}

function vcardRow(
  n: number,
  name: string,
  ...records: Array<{ url: string; connectedOn?: string }>
): ProfileFactsRow {
  const note = records
    .map(({ url, connectedOn }) => `URL: ${url}\n${connectedOn ? `Connected On: ${connectedOn}\n` : ''}`)
    .join('');

  return { entity_id: personId(n), person_name: name, profile_props: { Notes: [note] } };
}

/** A recruiter's profile pasted into every candidate's card. Invented. */
const SLUG_DESK = 'https://www.linkedin.com/in/acme-recruiter-desk';

/**
 * `count` people, numbered from `from`, whose cards carry only {@link SLUG_DESK}.
 * Their names share no token with each other or with "Zed".
 */
function pastedDeskRows(from: number, count: number): ProfileFactsRow[] {
  const names = ['Cleo Varga', 'Dov Ellery', 'Esme Tarrant', 'Fitz Ormond', 'Gus Pellow', 'Hal Wyncote'];

  return Array.from({ length: count }, (_, index) =>
    vcardRow(from + index, names[index % names.length] + (index >= names.length ? ` ${index}` : ''), {
      url: SLUG_DESK,
    }),
  );
}

function profileCandidates(rows: ProfileFactsRow[], slice: number[]) {
  return buildProfileUrlCandidates(profileFactsByEntity(rows), new Set(slice.map(personId)));
}

function kinds(candidate: MergeCandidate | undefined): string[] {
  return (candidate?.evidence ?? []).map((item) => item.kind);
}

describe('buildProfileUrlCandidates', () => {
  it('proposes the CSV and vCard copies of one connection at the auto-merge tier', () => {
    const { candidates } = profileCandidates(
      [
        csvRow(1, 'Ada Quillfeather', SLUG_ADA, '09 May 2014'),
        vcardRow(2, 'Ada Quillfeather', { url: `${SLUG_ADA}/?trk=people`, connectedOn: '09 May 2014' }),
      ],
      [1],
    );

    expect(candidates).toEqual([
      {
        entityIdA: personId(1),
        entityIdB: personId(2),
        score: 0.95,
        evidence: [{ kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 }],
      },
    ]);
  });

  it('finds a same-URL pair the name passes cannot pair at all', () => {
    // "A. Q." shares no indexable name token with the CSV name, so neither
    // name pass proposes it; agreeing Connected On dates corroborate the URL.
    const { candidates } = profileCandidates(
      [
        csvRow(1, 'Ada Quillfeather', SLUG_ADA, '09 May 2014'),
        vcardRow(2, 'A. Q.', { url: SLUG_ADA, connectedOn: '09 May 2014' }),
      ],
      [2],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(0.95);
  });

  it.each([
    ['a family-name conflict', vcardRow(2, 'Ada Brightwater', { url: SLUG_ADA }), 'family_name_conflict'],
    [
      'a Connected On conflict',
      vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA, connectedOn: '02 Jan 2019' }),
      'connected_on_conflict',
    ],
    ['no corroboration', vcardRow(2, 'Zed', { url: SLUG_ADA }), 'uncorroborated'],
  ])('holds an equal URL with %s at 0.8 for review', (_label, other, reason) => {
    const { candidates } = profileCandidates(
      [csvRow(1, 'Ada Quillfeather', SLUG_ADA, '09 May 2014'), other],
      [1],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(0.8);
    expect(candidates[0].evidence).toEqual([
      { kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.8 },
      { kind: 'profile_url_check', value: reason, score: 0 },
    ]);
  });

  it('marks a partial overlap and keeps it at 0.8', () => {
    const { candidates } = profileCandidates(
      [
        csvRow(1, 'Ada Quillfeather', SLUG_ADA),
        vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA }, { url: SLUG_BO }),
      ],
      [1],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(0.8);
    expect(kinds(candidates[0])).toEqual(['profile_url', 'profile_url_partial']);
  });

  it('never proposes two people with different profiles', () => {
    const { candidates } = profileCandidates(
      [csvRow(1, 'Ada Quillfeather', SLUG_ADA), vcardRow(2, 'Ada Quillfeather', { url: SLUG_OTHER_ADA })],
      [1, 2],
    );

    expect(candidates).toEqual([]);
  });

  it('caps profile URLs at the same group size as every other shared value', () => {
    // The URL cap lives in the memory domain because the auto-merger applies
    // it too; it must not drift from this stage's cap.
    expect(PROFILE_URL_MAX_HOLDERS).toBe(MAX_GROUP_MEMBERS);
  });

  it('suppresses a URL pasted into more cards than the group cap', () => {
    const rows = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, index) =>
      vcardRow(index + 1, `Ada Quillfeather ${index}`, { url: SLUG_ADA }),
    );

    const { candidates, suppressed } = profileCandidates(rows, [1]);

    expect(candidates).toEqual([]);
    expect([...suppressed]).toEqual([personId(1)]);
  });

  it('collapses the two directions of one pair into one candidate', () => {
    const { candidates } = profileCandidates(
      [csvRow(1, 'Ada Quillfeather', SLUG_ADA), vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA })],
      [1, 2],
    );

    expect(candidates).toHaveLength(1);
  });

  it('does not propose a pair that touches nobody in the slice', () => {
    const { candidates } = profileCandidates(
      [csvRow(1, 'Ada Quillfeather', SLUG_ADA), vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA })],
      [9],
    );

    expect(candidates).toEqual([]);
  });
});

describe('adjudicateCandidateProfiles — the veto', () => {
  const namePair = (): MergeCandidate => ({
    entityIdA: personId(1),
    entityIdB: personId(2),
    score: 0.62,
    evidence: [{ kind: 'name_cluster', value: 'ada', score: 0.62 }],
  });

  const emailPair = (): MergeCandidate => ({
    entityIdA: personId(1),
    entityIdB: personId(2),
    score: 0.95,
    evidence: [{ kind: 'email', value: 'ada@example.com', score: 0.95 }],
  });

  it('marks a same-name pair with different profiles as a conflict, and never raises it', () => {
    const facts = profileFactsByEntity([
      csvRow(1, 'Ada Quillfeather', SLUG_ADA),
      vcardRow(2, 'Ada Quillfeather', { url: SLUG_OTHER_ADA }),
    ]);

    const [vetoed] = adjudicateCandidateProfiles([namePair()], facts);

    expect(vetoed.score).toBe(0.62);
    expect(kinds(vetoed)).toEqual(['name_cluster', 'profile_url_conflict']);
  });

  it('caps an email pair whose people state different profiles below the auto-merge tier', () => {
    const facts = profileFactsByEntity([
      csvRow(1, 'Ada Quillfeather', SLUG_ADA),
      vcardRow(2, 'Ada Quillfeather', { url: SLUG_OTHER_ADA }),
    ]);

    const [vetoed] = adjudicateCandidateProfiles([emailPair()], facts);

    expect(vetoed.score).toBe(0.8);
    expect(kinds(vetoed)).toEqual(['email', 'profile_url_conflict']);
  });

  it('restores the partial cap that mergeCandidateLists would otherwise lift', () => {
    const facts = profileFactsByEntity([
      csvRow(1, 'Ada Quillfeather', SLUG_ADA),
      vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA }, { url: SLUG_BO }),
    ]);
    const { candidates: profile } = buildProfileUrlCandidates(facts, new Set([personId(1)]));

    const folded = mergeCandidateLists([emailPair()], profile);
    expect(folded[0].score).toBe(0.95);

    const [capped] = adjudicateCandidateProfiles(folded, facts);
    expect(capped.score).toBe(0.8);
    expect(kinds(capped)).toContain('profile_url_partial');
  });

  it('never lifts a name-tier pair on a URL held by more people than the cap', () => {
    // Regression: the URL pass suppresses an over-common URL, but name and
    // claim pairs are graded here, and "Zed" / "Zed Quimby" share the name
    // token the adjudicator takes as corroboration. Graded on the raw facts
    // the pair left at profile_url 0.95 and was folded without review.
    const facts = profileFactsByEntity([
      vcardRow(1, 'Zed', { url: SLUG_DESK }),
      vcardRow(2, 'Zed Quimby', { url: SLUG_DESK }),
      ...pastedDeskRows(3, 6),
    ]);
    const zedPair: MergeCandidate = {
      entityIdA: personId(1),
      entityIdB: personId(2),
      score: 0.5,
      evidence: [{ kind: 'name_cluster', value: 'zed', score: 0.5 }],
    };

    const [graded] = adjudicateCandidateProfiles([zedPair], facts);

    expect(graded).toEqual(zedPair);
    expect(buildProfileUrlCandidates(facts, new Set([personId(1), personId(2)])).candidates).toEqual([]);
  });

  it('does not veto an email pair on a URL held by more people than the cap', () => {
    // The pasted URL was never person 1's own profile, so it cannot
    // contradict person 2's.
    const facts = profileFactsByEntity([
      vcardRow(1, 'Ada Quillfeather', { url: SLUG_DESK }),
      csvRow(2, 'Ada Quillfeather', SLUG_ADA),
      ...pastedDeskRows(3, 6),
    ]);

    expect(adjudicateCandidateProfiles([emailPair()], facts)).toEqual([emailPair()]);
  });

  it('judges a card on its own profile when it also carries an over-common URL', () => {
    const facts = profileFactsByEntity([
      vcardRow(1, 'Ada Quillfeather', { url: SLUG_DESK }, { url: SLUG_ADA }),
      csvRow(2, 'Ada Quillfeather', SLUG_ADA),
      ...pastedDeskRows(3, 6),
    ]);

    const [graded] = adjudicateCandidateProfiles([namePair()], facts);

    expect(graded.score).toBe(0.95);
    expect(graded.evidence).toContainEqual({
      kind: 'profile_url',
      value: 'linkedin.com/in/ada-quillfeather-7x2',
      score: 0.95,
    });
    expect(kinds(graded)).not.toContain('profile_url_partial');
  });

  it('leaves a name-only pair with no URLs exactly as it was', () => {
    const facts = profileFactsByEntity([csvRow(3, 'Someone Else', SLUG_BO)]);

    expect(adjudicateCandidateProfiles([namePair()], facts)).toEqual([namePair()]);
  });

  it('leaves a pair alone when only one side states a URL', () => {
    const facts = profileFactsByEntity([csvRow(1, 'Ada Quillfeather', SLUG_ADA)]);

    expect(adjudicateCandidateProfiles([emailPair()], facts)).toEqual([emailPair()]);
  });
});

/* ===================================================================== *
 * Phones — the properties pass and its adjudicator
 * ===================================================================== */

/*
 * The duplicate this pass exists for: a Google Voice participant stub, named
 * by its number with the ten-digit key in `phones`, and the contacts vCard of
 * the same person, which kept the number as typed in `Phones`. Every number
 * and name is invented: 555-01XX under real area codes, the toll-free range,
 * and the UK drama range.
 */
const ADA_NUMBER = '+1 (202) 555-0142';
const ADA_E164 = '+12025550142';
const ADA_DIGITS = '2025550142';
const UK_E164 = '+442079460958';
const UK_DIGITS = '2079460958';

const digitsOf = (value: string) => value.replace(/\D/g, '').slice(-10);

function stubRow(n: number, number = ADA_NUMBER): PhoneFactsCorpusRow {
  return {
    entity_id: personId(n),
    person_name: number,
    phone_props: { phones: [digitsOf(number)] },
    is_self: false,
  };
}

function cardRow(n: number, name: string, ...typed: string[]): PhoneFactsCorpusRow {
  return {
    entity_id: personId(n),
    person_name: name,
    phone_props: { Phones: typed, phones: typed.map(digitsOf) },
    is_self: false,
  };
}

function phoneCorpus(
  rows: PhoneFactsCorpusRow[],
  owner: { timezone: string | null; selfEntityId: string | null } = {
    timezone: 'America/Los_Angeles',
    selfEntityId: null,
  },
  claims: Array<[string, string]> = [],
) {
  const { facts } = phoneCorpusFacts(rows, owner);

  return { facts, holders: new PhoneHolders(facts, claims) };
}

function phoneCandidates(rows: PhoneFactsCorpusRow[], slice: number[]) {
  const { facts, holders } = phoneCorpus(rows);

  return buildPhoneCandidates(facts, holders, new Set(slice.map(personId)));
}

describe('buildPhoneCandidates', () => {
  it('proposes a number-named stub against the vCard that states the number, at the auto-merge tier', () => {
    const { candidates } = phoneCandidates([stubRow(1), cardRow(2, 'Ada Quill', '+1 202-555-0142')], [1]);

    expect(candidates).toEqual([
      {
        entityIdA: personId(1),
        entityIdB: personId(2),
        score: 0.95,
        evidence: [{ kind: 'phone', value: ADA_E164, score: 0.95 }],
      },
    ]);
  });

  it('finds a pair the name pass cannot pair at all', () => {
    // The stub's only name is its number: no token in common with "Ada Quill".
    const names = buildNameOverlapCandidates(
      [
        { entity_id: personId(1), name: ADA_NUMBER },
        { entity_id: personId(2), name: 'Ada Quill' },
      ],
      new Set([personId(1)]),
    );

    expect(names.candidates).toEqual([]);
    expect(
      phoneCandidates([stubRow(1), cardRow(2, 'Ada Quill', '(202) 555-0142')], [1]).candidates,
    ).toHaveLength(1);
  });

  it('holds a shared household line with two given names for review', () => {
    const { candidates } = phoneCandidates(
      [cardRow(1, 'Ada Quill', '(202) 555-0142'), cardRow(2, 'Bo Quill', '(202) 555-0142')],
      [1],
    );

    expect(candidates).toEqual([
      {
        entityIdA: personId(1),
        entityIdB: personId(2),
        score: 0.85,
        evidence: [
          { kind: 'phone', value: ADA_E164, score: 0.85 },
          { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
        ],
      },
    ]);
  });

  it.each([
    ['a toll-free number', '(888) 555-0100'],
    ['an invalid number', '(123) 555-0100'],
    ['an extension', '(202) 555-0142 x12'],
  ])('proposes nothing on %s', (_label, number) => {
    expect(
      phoneCandidates([cardRow(1, 'Ada Quill', number), cardRow(2, 'Ada Quill', number)], [1, 2]).candidates,
    ).toEqual([]);
  });

  it('proposes nothing for the same digits in two countries', () => {
    expect(
      phoneCandidates(
        [cardRow(1, 'Ada Quill', '+44 20 7946 0958'), cardRow(2, 'Ada Quill', '+1 207 946 0958')],
        [1, 2],
      ).candidates,
    ).toEqual([]);
  });

  it('caps property phones at the same group size as every other shared value', () => {
    expect(PHONE_MAX_HOLDERS).toBe(MAX_GROUP_MEMBERS);
  });

  it('suppresses a number more people hold than the group cap', () => {
    const names = ['Ada', 'Bo', 'Cleo', 'Dov', 'Esme', 'Fitz', 'Gus'];
    const rows = names.map((name, index) => cardRow(index + 1, `${name} Quill`, '(202) 555-0142'));

    const { candidates, suppressed } = phoneCandidates(rows, [1]);

    expect(rows).toHaveLength(MAX_GROUP_MEMBERS + 1);
    expect(candidates).toEqual([]);
    expect([...suppressed]).toEqual([personId(1)]);
  });

  it('collapses the two directions of one pair into one candidate', () => {
    expect(
      phoneCandidates([stubRow(1), cardRow(2, 'Ada Quill', ADA_NUMBER)], [1, 2]).candidates,
    ).toHaveLength(1);
  });

  it('does not propose a pair that touches nobody in the slice', () => {
    expect(phoneCandidates([stubRow(1), cardRow(2, 'Ada Quill', ADA_NUMBER)], [9]).candidates).toEqual([]);
  });
});

describe('adjudicateCandidatePhones', () => {
  /** What the claim pass writes for two claims stating the same E.164 — no name guard at all. */
  const claimExact = (): MergeCandidate =>
    scorePair([
      claim({ kind: 'phone', value_normalized: ADA_DIGITS, subject_e164: ADA_E164, other_e164: ADA_E164 }),
    ])!;

  it('downgrades a claim-pass E.164 match between two given names on one line', () => {
    expect(claimExact().score).toBe(PHONE_MATCH_SCORES.e164Exact);
    const { facts, holders } = phoneCorpus([
      cardRow(1, 'Ada Quill', '(202) 555-0142'),
      cardRow(2, 'Bo Quill', '(202) 555-0142'),
    ]);

    const [graded] = adjudicateCandidatePhones([claimExact()], facts, holders);

    expect(graded.score).toBe(0.85);
    expect(graded.evidence).toEqual([
      { kind: 'phone', value: ADA_E164, score: 0.85 },
      { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
    ]);
  });

  it('caps a claim-pass E.164 match whose people carry no phone properties', () => {
    const { facts, holders } = phoneCorpus([]);

    const [graded] = adjudicateCandidatePhones([claimExact()], facts, holders);

    expect(graded.score).toBe(0.85);
    expect(kinds(graded)).toEqual(['phone', 'phone_check']);
    expect(graded.evidence[1].value).toBe('unadjudicated');
  });

  it('keeps the review grade that mergeCandidateLists would otherwise lift', () => {
    const { facts, holders } = phoneCorpus([
      cardRow(1, 'Ada Quill', '(202) 555-0142'),
      cardRow(2, 'Bo Quill', '(202) 555-0142'),
    ]);
    const { candidates: phone } = buildPhoneCandidates(facts, holders, new Set([personId(1)]));

    const folded = mergeCandidateLists([claimExact()], phone);
    expect(folded[0].score).toBe(0.95);

    expect(adjudicateCandidatePhones(folded, facts, holders)[0].score).toBe(0.85);
  });

  it('removes a claim-pass match on a number that is not evidence at all', () => {
    const tollFree = scorePair([claim({ kind: 'phone', value_normalized: '8885550100' })])!;
    const { facts, holders } = phoneCorpus([
      cardRow(1, 'Ada Quill', '(888) 555-0100'),
      cardRow(2, 'Ada Quill', '(888) 555-0100'),
    ]);

    expect(adjudicateCandidatePhones([tollFree], facts, holders)[0]).toMatchObject({
      score: 0,
      evidence: [],
    });
  });

  it('leaves a name-only pair with no phones exactly as it was', () => {
    const namePair: MergeCandidate = {
      entityIdA: personId(1),
      entityIdB: personId(2),
      score: 0.62,
      evidence: [{ kind: 'name_overlap', value: 'quill', score: 0.62 }],
    };
    const { facts, holders } = phoneCorpus([cardRow(3, 'Someone Else', '(212) 555-0199')]);

    expect(adjudicateCandidatePhones([namePair], facts, holders)).toEqual([namePair]);
  });

  it('lets the profile veto have the last word over an exact phone', () => {
    const { facts, holders } = phoneCorpus([stubRow(1), cardRow(2, 'Ada Quill', ADA_NUMBER)]);
    const profileFacts = profileFactsByEntity([
      csvRow(1, ADA_NUMBER, SLUG_ADA),
      vcardRow(2, 'Ada Quill', { url: SLUG_OTHER_ADA }),
    ]);
    const { candidates } = buildPhoneCandidates(facts, holders, new Set([personId(1)]));

    const [graded] = adjudicateCandidateProfiles(
      adjudicateCandidatePhones(candidates, facts, holders),
      profileFacts,
    );

    expect(graded.score).toBe(0.8);
    expect(kinds(graded)).toEqual(['phone', 'profile_url_conflict']);
  });
});

describe('holdEmailPairs — names that say two people, on a shared email', () => {
  const OWNER = '00000000-0000-4000-8000-00000000000a';
  const FRIEND = '00000000-0000-4000-8000-00000000000b';
  const STUB = '00000000-0000-4000-8000-00000000000c';
  const emailPair = (a: string, b: string): MergeCandidate => ({
    entityIdA: a,
    entityIdB: b,
    score: 0.95,
    evidence: [{ kind: 'email', value: 'ada@quill.example', score: 0.95 }],
  });
  const names = new Map<string, string | null>([
    [OWNER, 'Ada Quill'],
    [FRIEND, 'Bo Brightwater'],
    [STUB, 'ada@quill.example'],
  ]);

  it("holds a card that lists the owner's address under someone else's name", () => {
    // Folded, the friend would become the owner — and their address with them.
    expect(holdEmailPairs([emailPair(OWNER, FRIEND)], names, new Set([OWNER]))).toEqual([
      {
        entityIdA: OWNER,
        entityIdB: FRIEND,
        score: 0.85,
        evidence: [
          { kind: 'email', value: 'ada@quill.example', score: 0.85 },
          { kind: 'email_check', value: 'self_endpoint', score: 0 },
        ],
      },
    ]);
  });

  it("holds two contacts whose names share nothing: a friend's card against the owner's own card", () => {
    // The owner's contact cards are ordinary Persons, not the self Person.
    const CARD = '00000000-0000-4000-8000-00000000000d';
    const withCard = new Map(names).set(CARD, 'Ada D Quill');

    expect(holdEmailPairs([emailPair(CARD, FRIEND)], withCard, new Set([OWNER]))).toEqual([
      {
        entityIdA: CARD,
        entityIdB: FRIEND,
        score: 0.85,
        evidence: [
          { kind: 'email', value: 'ada@quill.example', score: 0.85 },
          { kind: 'email_check', value: 'name_conflict', score: 0 },
        ],
      },
    ]);
  });

  it("leaves the owner's own mail stub, a contact against a stub, and non-email pairs alone", () => {
    const stub = emailPair(OWNER, STUB);
    const contacts = emailPair(FRIEND, STUB);
    const phone: MergeCandidate = {
      ...emailPair(OWNER, FRIEND),
      evidence: [{ kind: 'phone', value: '+12025550142', score: 0.85 }],
    };

    expect(holdEmailPairs([stub, contacts, phone], names, new Set([OWNER]))).toEqual([stub, contacts, phone]);
  });
});

describe('phone parity with the shared normalisers', () => {
  const inputs = [
    '+1 (202) 555-0142',
    '202-555-0142',
    '(202) 555-0142',
    '12025550142',
    '+44 20 7946 0958',
    '0044 20 7946 0958',
    '020 7946 0958',
    '+33 1 23 45 67 89',
    '+1 800 555 0100',
    '555-0142',
    '52886',
    '‪+1 (202) 555‑0142‬',
    '202.555.0142 x12',
  ];

  it.each(inputs)('keeps normalizePhone’s last ten digits for %p', (raw) => {
    // The join key `properties.phones` and `identifier_claims.value_normalized`
    // carry; a drift here would make holders of one number disagree on its key.
    if (hasPhoneExtension(raw)) {
      // The one deliberate exception. The join key REFUSES an extension now
      // (it used to keep the last ten digits of line + extension), but `l10`
      // still carries that truncation: it is the key the old rule wrote into
      // `phones`, and a record that still holds one — a merge survivor, an
      // import whose typed number was never kept — must meet its own refusal on
      // the same line, or the truncation reads as an inferred +1 number.
      expect(normalizePhone(raw)).toBeNull();
      expect(parsePhone(raw, 'NANP')).toMatchObject({
        status: 'extension',
        l10: raw.replace(/\D/g, '').slice(-10),
      });

      return;
    }

    expect(parsePhone(raw, 'NANP').l10).toBe(normalizePhone(raw) ?? '');
  });

  it.each(inputs)('states exactly what toE164 states for %p', (raw) => {
    const parsed = parsePhone(raw, null);

    if (parsed.status === 'ok' && parsed.stated) {
      expect(parsed.e164).toBe(toE164(raw));
    } else {
      // A value this rule refuses may still have a toE164 form (a toll-free
      // number does), but nothing toE164 cannot state is stated here.
      expect(parsed.e164).toBeNull();
    }
  });

  it('never states a number toE164 would not', () => {
    for (const raw of inputs) {
      const parsed = parsePhone(raw, null);

      if (toE164(raw) == null) {
        expect(parsed.stated && parsed.status === 'ok').toBe(false);
      }
    }
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
    /** Rows the corpus-wide profile-facts query returns. */
    profileRows?: ProfileFactsRow[];
    /** Rows the corpus-wide person-name query returns. */
    nameRows?: Array<{ entity_id: string; name: string | null }>;
    /** Rows the corpus-wide phone-facts query returns. */
    phoneRows?: PhoneFactsCorpusRow[];
    /** The `ci.users` row. Defaults to a North American time zone and no self Person. */
    owner?: { timezone: string | null; entity_id: string | null };
    /** Stated E.164 forms the claims table carries. */
    claimE164?: PhoneClaimE164Row[];
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

    // Ahead of the name branch: the facts queries select `e.name` too.
    if (/profile_props/i.test(sql) && /FROM ci\.entities e/i.test(sql)) {
      return opts.profileRows ?? [];
    }

    if (/phone_props/i.test(sql) && /FROM ci\.entities e/i.test(sql)) {
      return opts.phoneRows ?? [];
    }

    if (/FROM ci\.users/i.test(sql)) {
      return [opts.owner ?? { timezone: 'America/Los_Angeles', entity_id: null }];
    }

    if (/value_e164 AS e164/i.test(sql)) {
      return opts.claimE164 ?? [];
    }

    if (/e\.name/i.test(sql) && /FROM ci\.entities e/i.test(sql)) {
      return opts.nameRows ?? [];
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

  it('writes the profile-URL pair and records it for both people', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      profileRows: [
        csvRow(1, 'Ada Quillfeather', SLUG_ADA, '09 May 2014'),
        vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA, connectedOn: '09 May 2014' }),
      ],
    });

    const results = await stage.run(CTX, [personId(1), personId(2)]);

    expect(results.get(personId(1))).toMatchObject({ outcome: 'done', detail: { candidates: 1 } });
    const params = insert()?.params ?? [];
    expect(params[4]).toEqual([0.95]);
    expect(JSON.parse((params[7] as string[])[0])).toEqual([
      { kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 },
    ]);
  });

  it('records a claim-less person that WAS proposed on a profile URL as done, not as a coverage gap', async () => {
    const { stage } = makeStage({
      present: [personId(1)],
      claimCounts: { [personId(1)]: 0 },
      profileRows: [
        csvRow(1, 'Ada Quillfeather', SLUG_ADA),
        vcardRow(2, 'Ada Quillfeather', { url: SLUG_ADA }),
      ],
    });

    const results = await stage.run(CTX, [personId(1)]);

    expect(results.get(personId(1))).toMatchObject({ outcome: 'done', detail: { candidates: 1 } });
  });

  it('vetoes an email pair whose people state different profiles before writing it', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      claims: [claim({ subject_id: personId(1), other_id: personId(2) })],
      profileRows: [
        csvRow(1, 'Ada Quillfeather', SLUG_ADA),
        vcardRow(2, 'Ada Quillfeather', { url: SLUG_OTHER_ADA }),
      ],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    const params = insert()?.params ?? [];
    expect(params[4]).toEqual([0.8]);
    expect(JSON.parse((params[7] as string[])[0]).map((item: { kind: string }) => item.kind)).toEqual([
      'email',
      'profile_url_conflict',
    ]);
  });

  it('writes a name pair whose people share only an over-common URL at its name score', async () => {
    // The whole slice path, end to end: name pass, URL pass, veto, write.
    const profileRows = [
      vcardRow(1, 'Zed', { url: SLUG_DESK }),
      vcardRow(2, 'Zed Quimby', { url: SLUG_DESK }),
      ...pastedDeskRows(3, 6),
    ];
    const { stage, insert } = makeStage({
      present: [personId(1)],
      profileRows,
      nameRows: profileRows.map((row) => ({ entity_id: row.entity_id, name: row.person_name })),
    });

    const results = await stage.run(CTX, [personId(1)]);

    const params = insert()?.params ?? [];
    expect(params[2]).toEqual([personId(1)]);
    expect(params[3]).toEqual([personId(2)]);
    expect(params[4]).toEqual([0.5]);
    expect(JSON.parse((params[7] as string[])[0])).toEqual([
      { kind: 'name_cluster', value: 'zed', score: 0.5 },
    ]);
    expect(results.get(personId(1))).toMatchObject({
      outcome: 'done',
      detail: { candidates: 1, suppressedCommonValues: true },
    });
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

describe('run — the phone pass', () => {
  it('writes a stub/vCard pair at the auto-merge tier and records the claim-less stub as done', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1)],
      claimCounts: { [personId(1)]: 0 },
      phoneRows: [stubRow(1), cardRow(2, 'Ada Quill', '+1 202-555-0142')],
    });

    const results = await stage.run(CTX, [personId(1)]);

    const params = insert()?.params ?? [];
    expect(params[4]).toEqual([0.95]);
    expect(JSON.parse((params[7] as string[])[0])).toEqual([{ kind: 'phone', value: ADA_E164, score: 0.95 }]);
    expect(results.get(personId(1))).toMatchObject({ outcome: 'done', detail: { candidates: 1 } });
  });

  it('writes a shared household line with two given names at the review tier, labelled', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1)],
      phoneRows: [cardRow(1, 'Ada Quill', '(202) 555-0142'), cardRow(2, 'Bo Quill', '(202) 555-0142')],
    });

    await stage.run(CTX, [personId(1)]);

    const params = insert()?.params ?? [];
    expect(params[4]).toEqual([0.85]);
    expect(JSON.parse((params[7] as string[])[0])).toEqual([
      { kind: 'phone', value: ADA_E164, score: 0.85 },
      { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
    ]);
  });

  it('downgrades the claim pass’s unguarded E.164 match before writing it', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      claims: [
        claim({
          subject_id: personId(1),
          other_id: personId(2),
          kind: 'phone',
          value_normalized: ADA_DIGITS,
          subject_e164: ADA_E164,
          other_e164: ADA_E164,
        }),
      ],
      phoneRows: [cardRow(1, 'Ada Quill', '(202) 555-0142'), cardRow(2, 'Bo Quill', '(202) 555-0142')],
    });

    await stage.run(CTX, [personId(1), personId(2)]);

    expect((insert()?.params ?? [])[4]).toEqual([0.85]);
  });

  it("never grades a pair with the owner's self Person exact", async () => {
    const { stage, insert } = makeStage({
      present: [personId(1)],
      owner: { timezone: 'America/Los_Angeles', entity_id: personId(2) },
      phoneRows: [stubRow(1), cardRow(2, 'Ada Quill', ADA_NUMBER)],
    });

    await stage.run(CTX, [personId(1)]);

    const params = insert()?.params ?? [];
    expect(params[4]).toEqual([0.85]);
    expect(JSON.parse((params[7] as string[])[0])).toContainEqual({
      kind: 'phone_check',
      value: 'self_endpoint',
      score: 0,
    });
  });

  it('records a person whose only shared number is over-common as skipped', async () => {
    const names = ['Ada', 'Bo', 'Cleo', 'Dov', 'Esme', 'Fitz', 'Gus'];
    const { stage, insert } = makeStage({
      present: [personId(1)],
      phoneRows: names.map((name, index) => cardRow(index + 1, `${name} Quill`, '(202) 555-0142')),
    });

    const results = await stage.run(CTX, [personId(1)]);

    expect(insert()).toBeUndefined();
    expect(results.get(personId(1))).toMatchObject({ outcome: 'skipped', reason: 'identifiers_too_common' });
  });

  it('writes no exact tier for national numbers when the owner has no derivable region', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1)],
      owner: { timezone: 'UTC', entity_id: null },
      phoneRows: [stubRow(1, ADA_DIGITS), cardRow(2, 'Ada Quill', '(202) 555-0142')],
    });

    await stage.run(CTX, [personId(1)]);

    const params = insert()?.params ?? [];
    expect(params[4]).toEqual([0.75]);
    expect(JSON.parse((params[7] as string[])[0])).toEqual([
      { kind: 'phone', value: ADA_DIGITS, score: 0.75 },
    ]);
  });

  it('lets a claim that states the digits abroad block the North American reading', async () => {
    const { stage, insert, statements } = makeStage({
      present: [personId(1)],
      phoneRows: [stubRow(1, UK_DIGITS), cardRow(2, 'Ada Quill', '(207) 946-0958')],
      claimE164: [{ l10: UK_DIGITS, e164: UK_E164 }],
    });

    await stage.run(CTX, [personId(1)]);

    expect((insert()?.params ?? [])[4]).toEqual([0.75]);
    // Asked only about digits two people share.
    const claimRead = statements.find((statement) => /value_e164 AS e164/.test(statement.sql));
    expect(claimRead?.params).toEqual([USER, [UK_DIGITS]]);
  });

  it('drops a claim-pass match on a toll-free number instead of writing it', async () => {
    const { stage, insert } = makeStage({
      present: [personId(1), personId(2)],
      claims: [
        claim({
          subject_id: personId(1),
          other_id: personId(2),
          kind: 'phone',
          value_normalized: '8885550100',
        }),
      ],
      phoneRows: [cardRow(1, 'Ada Quill', '(888) 555-0100'), cardRow(2, 'Ada Quill', '(888) 555-0100')],
    });

    const results = await stage.run(CTX, [personId(1), personId(2)]);

    expect(insert()).toBeUndefined();
    expect(results.get(personId(1))).toMatchObject({ outcome: 'done', detail: { candidates: 0 } });
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

    // Two legs: the swept subjects (`mine`) and every holder of their values
    // (`holders`). Group size and the other side's E.164 form are derived from
    // `holders`, not re-read — the correlated per-row form never finished on a
    // real corpus (see `loadEvidence`).
    expect(evidence?.sql.match(/disposition IS DISTINCT FROM 'rejected'/g)?.length).toBe(2);
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

  async function seedPerson(
    entityId: string,
    name: string | null,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', $2, $4::jsonb, $3)`,
      [entityId, name, ownerUserId, JSON.stringify(properties)],
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

    // Since scoring generation 5 a claim pair's 0.95 survives only when the
    // phone adjudicator grades it from the two people's OWN properties; a
    // claim-only E.164 match is capped at 0.85 (see adjudicateCandidatePhones).
    // So the exact pair states the number on both cards, as a contact import
    // does, and is nameless on both sides: its names say nothing either way.
    for (const [role, entityId] of Object.entries(people)) {
      if (entityId === people.exactA || entityId === people.exactB) {
        await seedPerson(entityId, null, { Phones: ['+44 20 7946 0958'], phones: ['2079460958'] });
      } else {
        await seedPerson(entityId, role);
      }
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

    // The adjudicator's item replaces the claim pass's: the full number, not
    // the ten-digit key, because it is the number that was judged — which
    // also proves PHONE_FACTS_CORPUS_SQL ran against the real schema.
    expect(exact.evidence).toEqual([
      { kind: 'phone', value: '+442079460958', score: PHONE_MATCH_SCORES.e164Exact },
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
