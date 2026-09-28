import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  PHONE_CLAIM_E164_SQL,
  PHONE_FACTS_CORPUS_SQL,
  PROFILE_FACTS_CORPUS_SQL,
  PhoneHolders,
  ProfileUrlHolders,
  applyPhoneVerdict,
  applyProfileVerdict,
  capUnadjudicatedPhones,
  compareTokenizedNames,
  extractProfileFacts,
  indexableTokens,
  phoneCorpusFacts,
  sharedPhoneLines,
  tokenizePersonName,
  type PhoneClaimE164Row,
  type PhoneFacts,
  type PhoneFactsCorpusRow,
  type ProfileFacts,
  type ProfileFactsCorpusRow,
  type TokenizedPersonName,
} from '@ci/domains/memory';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id.
 *
 * Declared locally ahead of its `STAGE_IDS` entry, as every stage written before
 * its wiring has been. `__tests__/stageWiring.spec.ts` fails by name until the
 * four central entries land.
 *
 * IDS ARE PERMANENT. Renaming this one abandons every ledger row and re-proposes
 * every pair the user has already dismissed.
 */
export const CLEAN_DUPLICATE_DETECT_STAGE_ID = 'clean.duplicate_detect';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'entity';

/** `ci.merge_candidates.entity_type` for the pairs this stage proposes. */
const CANDIDATE_ENTITY_TYPE = 'Person';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of the SCORING rule — {@link IDENTIFIER_KIND_SCORES},
 * {@link MAX_GROUP_MEMBERS}, which claim kinds count as evidence at all, the
 * profile-URL rule in `memory/utils/profileUrls.ts` (its normaliser, its
 * adjudicator and its `PROFILE_URL_MAX_HOLDERS` cap all change verdicts, so
 * editing any of them is a bump) and the phone rule in
 * `memory/utils/phoneIdentity.ts` (its parser, its NANP tables, its time-zone
 * list, its name and line-census guards and its `PHONE_MAX_HOLDERS` cap —
 * likewise).
 *
 * Bump it in the same commit that edits any of them. A bump re-proposes: every
 * PENDING candidate is rescored, and every pair whose evidence no longer clears
 * the floor is left behind (see {@link DuplicateDetectStage} on why nothing is
 * withdrawn). It does NOT resurrect a pair a human rejected — that decision is
 * sticky by design.
 *
 * 2 — phone evidence is adjudicated against `value_e164` instead of being
 * discounted wholesale. See {@link PHONE_MATCH_SCORES}.
 * 3 — name evidence is no longer exact-string only. Token-subset overlap
 * ("mr broza" ⊂ "william d broza") is scored and proposed; a last-name
 * conflict is not. See {@link buildNameOverlapCandidates}.
 * 4 — profile_url evidence (LinkedIn /in/ URLs from URL/URLs/Notes `URL:`
 * lines): set-equal and corroborated gives 0.95; family-name, Connected On
 * or uncorroborated gives 0.8; partial or disjoint URLs veto every pair. A
 * URL held by more than `PROFILE_URL_MAX_HOLDERS` people is removed before
 * any of that, for every pair, so it neither lifts nor vetoes one.
 * See {@link buildProfileUrlCandidates} and {@link adjudicateCandidateProfiles}.
 * 5 — properties phone tier: Person `Phones`/`phones`/`phone` and numeric
 * display names are parsed to E.164 (stated forms, or a valid geographic NANP
 * number under a derived, corpus-corroborated owner region; never toll-free,
 * premium, service, invalid or an extension), and a shared number is graded
 * 0.95 only on the same first given name or a placeholder side with a clean
 * line census, 0.85 + `phone_check` otherwise, `phone_country_conflict` on
 * disagreeing countries. The adjudicator is the only producer of a 0.95 phone
 * item — the claim pass's unguarded E.164 tier is capped at 0.85 — and the
 * profile veto still runs last. See {@link buildPhoneCandidates} and
 * {@link adjudicateCandidatePhones}.
 */
export const DUPLICATE_SCORING_GENERATION = 5;

/**
 * Generation of the CANDIDATE SET — which subjects are compared, i.e. the
 * applicability predicate in {@link DUPLICATE_DETECT_SOURCE} and the claim query
 * in {@link DuplicateDetectStage.loadEvidence}.
 *
 * Separate from the scoring generation because the two improve independently:
 * widening the comparison to `product_model` subjects should not rescore every
 * person pair, and re-weighting phone evidence should not re-sweep entities that
 * were never eligible.
 *
 * 2 — `enrich.person_self_claim` started writing `role = 'self'` claims for
 * every Person's own emails/phones/name, so a contact-card/vCard/Apple
 * Contacts Person that never resolved from a communication or event now has
 * evidence too (loadEvidence groups on `entity_id` regardless of
 * `subject_type`, so no query here changed — only the claim producers did).
 */
export const DUPLICATE_CANDIDATE_GENERATION = 2;

/**
 * The stage version, derived so that improving EITHER re-runs history.
 *
 * A SUM, offset so both-at-1 gives 1 (`versions.ts` refuses a version below 1).
 * Monotone in each term, so the version can only go UP — never `hash(...)`,
 * which is uniformly distributed and would move the version DOWN half the time,
 * pinning the corpus permanently. `EmbedStage` argues this at length.
 */
export const DUPLICATE_DETECT_VERSION = DUPLICATE_SCORING_GENERATION + DUPLICATE_CANDIDATE_GENERATION - 1;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * A missing entry is not an error (this file precedes the central declaration);
 * a disagreeing one is, and it throws here where the fix is one line. Only the
 * literal form is checked — a thunk for this stage could only be this function.
 */
export function duplicateDetectStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[CLEAN_DUPLICATE_DETECT_STAGE_ID];

  if (typeof declared === 'number' && declared !== DUPLICATE_DETECT_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${CLEAN_DUPLICATE_DETECT_STAGE_ID}"] declares ${declared} but the stage ` +
        `derives ${DUPLICATE_DETECT_VERSION} from DUPLICATE_SCORING_GENERATION ` +
        `(${DUPLICATE_SCORING_GENERATION}) + DUPLICATE_CANDIDATE_GENERATION ` +
        `(${DUPLICATE_CANDIDATE_GENERATION}) - 1. Bumping a generation is only half the change: ` +
        `update versions.ts in the same commit.`,
    );
  }

  return DUPLICATE_DETECT_VERSION;
}

// Module load, not first sweep: the earliest failure is the cheapest one.
duplicateDetectStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * The sweep pages over PEOPLE, not over pairs. That is the only shape that fits
 * the ledger — `ci.pipeline_state` is keyed `(entity_type, entity_id, stage)`
 * and a pair has no id — and it is also the shape that makes coverage mean
 * something: "every person in this corpus has been examined for duplicates at
 * rule version N" is answerable, and "every pair has" is not, because the pair
 * set is quadratic and mostly empty.
 *
 * ── `merged_into_entity_id IS NULL` is applicability, not completion ────────
 *
 * It LOOKS like the ratchet, so it needs saying: a tombstoned entity is not a
 * person, it is a redirect left behind by `PersonMergeService`. And this stage
 * NEVER WRITES `merged_into_entity_id` — it proposes and a human disposes — so
 * the column is not this stage's output and a row can never leave the candidate
 * set because this stage succeeded. Compare `s.time_source IS NULL` in
 * `TemporalRepairStage`, which would be the ratchet, and is not there.
 *
 * `is_active` is the same argument one column over.
 *
 * The predicate must never mention `ci.merge_candidates`. That table IS this
 * stage's output, and anti-joining it (`WHERE NOT EXISTS (SELECT 1 FROM
 * ci.merge_candidates …)`) is precisely the shape the pipeline README calls "the
 * same ratchet wearing a different hat": a person would leave the candidate set
 * the moment one candidate was proposed for them, and a rescoring bump could
 * never reach them again.
 */
export const DUPLICATE_DETECT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate:
    `s.entity_type = 'Person' ` +
    `AND COALESCE(s.is_active, true) = true ` +
    `AND s.merged_into_entity_id IS NULL`,
};

// ---------------------------------------------------------------------------
// The scoring rule
// ---------------------------------------------------------------------------

/**
 * Evidence strength per identifier kind, from the rebuild plan §7.1.
 *
 * These are the numbers `PersonDuplicateService` uses today, kept deliberately —
 * changing the corpus's source of truth and its scale in one change would make
 * the result unattributable to either.
 *
 * `confidence` in `types.ts` says never fabricate a number, and these are
 * genuinely calibrated by what the identifier MEANS, not by how it feels:
 *
 *  - **email 0.95** — a mailbox is close to globally unique to a person. Not
 *    1.0: shared household and role addresses exist, which is what
 *    {@link MAX_GROUP_MEMBERS} bounds.
 *  - **phone 0.85** — the number a phone match is worth when nothing better is
 *    known about it. It is no longer the number most phone matches get:
 *    `value_e164` now exists on the claim and {@link PHONE_MATCH_SCORES}
 *    adjudicates against it. This entry survives as the middle tier there and
 *    as the answer for a phone claim reaching {@link claimScore} without the
 *    E.164 columns — see that table for the whole argument.
 *  - **name 0.5** — display names are not unique and this is the number that
 *    keeps them below any plausible auto-merge floor. Two people called "John
 *    Smith" are a QUESTION, not an answer.
 */
export const IDENTIFIER_KIND_SCORES: Readonly<Record<string, number>> = {
  email: 0.95,
  phone: 0.85,
  /**
   * NOT in the plan's list, because the kind did not exist when it was written.
   * `20260809183010_identifier_claims` adds `handle` to both `kind` CHECKs,
   * with the reason: `classifyParticipant` routes an @handle to `name` today,
   * so an Instagram/X identity shares a namespace with a human display name and
   * two unrelated people who both go by "alex" collide.
   *
   * Below `phone` because a handle can be released and re-registered by someone
   * else, which no phone number this corpus contains has done. Far above `name`
   * because a handle IS unique within its platform namespace at any instant and
   * a display name never is.
   */
  handle: 0.8,
  name: 0.5,
};

/**
 * What a shared phone is worth once `value_e164` is consulted.
 *
 * ── Why this table exists at all ───────────────────────────────────────────
 *
 * `value_normalized` is the LAST TEN DIGITS — the cross-repo join key, and
 * lossy in a way that manufactures identities: UK `+44 20 7946 0958` and US
 * `(207) 946-0958` both normalise to `2079460958`. A flat 0.85 for every phone
 * match was the honest price of not being able to tell those apart. That is no
 * longer the situation. `clean.identifier_normalize` writes `value_e164`
 * beside the key (`20260809183010_identifier_claims`), and both claim
 * producers — `enrich.person_link` and `enrich.person_self_claim` — carry it
 * through, so most phone claims in a real corpus now STATE their country. The
 * discount was provisional on exactly that, and holding it after the condition
 * was met means paying for a collision the evidence already excludes.
 *
 * ── The four answers, and why each is that number ──────────────────────────
 *
 *  - **`e164Exact` 0.95** — both sides state a country and the full
 *    international numbers are EQUAL. Nothing is inferred; the match is on the
 *    whole of the number, which is what an email match is. `enrich.person_link`
 *    has already made this call — `MATCH_CONFIDENCE.phone_e164` equals
 *    `MATCH_CONFIDENCE.email_exact` there — so this is that grading carried
 *    into this table's scale, not a new opinion. Not 1.0, for the same reason
 *    `email` is not: a household landline is shared, which
 *    {@link MAX_GROUP_MEMBERS} bounds.
 *  - **`e164Partial` 0.85** — one side states a country, the other does not.
 *    We matched ten digits and cannot confirm the country. Deliberately the
 *    unchanged {@link IDENTIFIER_KIND_SCORES}.phone, and deliberately written
 *    as a reference to it: this tier IS the old behaviour, kept for the case
 *    the widening does not reach.
 *  - **`last10Only` 0.75** — NEITHER side states a country. The only tier where
 *    nothing in the evidence excludes the UK/US collision the discount was
 *    invented for, so it sorts below every tier that does. Below `handle` (0.8)
 *    because a handle is unique in its namespace at any instant and a
 *    country-less ten-digit key is not unique across namespaces at all; far
 *    above `name` (0.5) because ten digits do not agree by chance.
 *  - **a country CONFLICT is not evidence** — both sides state a country and
 *    they DISAGREE. The migration says it outright: two claims agreeing on
 *    `value_normalized` and disagreeing on `value_e164` are provably different
 *    numbers. `enrich.person_link` refuses that match outright
 *    (`phone_country_conflict`); refusing it here too is the same rule, and it
 *    is the one case where reading the column REMOVES a proposal rather than
 *    reordering one. {@link claimScore} returns null, exactly as it does for an
 *    uncalibrated kind.
 *
 * ── `e164Exact` no longer reaches the auto-merge tier on its own ───────────
 *
 * An equal E.164 on two claims says nothing about whether the two people are
 * one person or two people on one household line, and this table has no name
 * guard. Since scoring generation 5 the properties phone adjudicator
 * (`memory/utils/phoneIdentity.ts`, via {@link adjudicateCandidatePhones})
 * re-states the phone evidence of every pair whose two people carry phone
 * properties, and caps any other phone item at 0.95 to 0.85 with a
 * `phone_check: unadjudicated` marker. The claim pass still FINDS pairs with
 * these scores; only the adjudicator can keep one at 0.95.
 */
export const PHONE_MATCH_SCORES = {
  e164Exact: 0.95,
  e164Partial: IDENTIFIER_KIND_SCORES.phone,
  last10Only: 0.75,
} as const;

/**
 * How many subjects may share one normalized value before it stops being
 * evidence.
 *
 * Six, as `PersonDuplicateService` caps today. Above it the value is not an
 * identifier, it is a SHARED ONE: `info@`, `noreply@`, a family landline, a
 * support number. Proposing the 15 pairs that a 6-way group generates — or the
 * 4,950 a 100-way group generates — would bury the real duplicates in a review
 * queue nobody can finish, which is the practical way a proposal system dies.
 *
 * The over-large group is not silently dropped: it is counted, and the subject
 * is recorded `skipped: identifiers_too_common` so the operator can see that a
 * person was examined and deliberately not proposed for.
 *
 * Profile URLs are capped by `PROFILE_URL_MAX_HOLDERS` in
 * `memory/utils/profileUrls.ts` instead, and property phone numbers by
 * `PHONE_MAX_HOLDERS` in `memory/utils/phoneIdentity.ts`, because the
 * auto-merger applies those caps too and cannot import this file. The spec
 * pins all three equal.
 */
export const MAX_GROUP_MEMBERS = 6;

/**
 * How many people a bare given name may fit before it stops being a question
 * and becomes noise ("william" against forty email Williams).
 *
 * Higher than {@link MAX_GROUP_MEMBERS} because the UI groups these into one
 * picker rather than N pairwise cards. Above the cap the given-name match is
 * dropped; family-token matches for the same person still stand.
 */
export const MAX_NAME_CLUSTER = 8;

/**
 * Minimum score worth writing a row for.
 *
 * Equal to the weakest single piece of evidence, so a lone name match still
 * surfaces. Deliberately NOT an auto-merge floor: the plan sets that to 1.1
 * (off) and this stage has no merge path at all to gate.
 */
export const MIN_CANDIDATE_SCORE = 0.5;

// ---------------------------------------------------------------------------
// Evidence and scoring — pure
// ---------------------------------------------------------------------------

/** One shared identifier between two subjects, as the claim query returns it. */
export interface SharedClaim {
  /** The swept subject. */
  subject_id: string;
  /** The other subject holding the same claim. */
  other_id: string;
  kind: string;
  value_normalized: string;
  /**
   * The swept subject's E.164 form of this value, when its claims state a
   * country and agree on which. NULL for every non-phone kind, and for a phone
   * the subject holds under two different countries — which is not a country,
   * it is an unresolved disagreement, and it is scored as one.
   */
  subject_e164: string | null;
  /** The same, for the other subject. */
  other_e164: string | null;
  /** Distinct subjects across the whole corpus holding this (kind, value). */
  group_size: number;
}

/** One piece of evidence, as it is written into `ci.merge_candidates.evidence`. */
export interface CandidateEvidence {
  kind: string;
  value: string;
  score: number;
}

/** One proposed pair, ordered and scored. */
export interface MergeCandidate {
  /** The lexicographically smaller uuid. `CHECK (entity_id_a < entity_id_b)`. */
  entityIdA: string;
  entityIdB: string;
  score: number;
  evidence: CandidateEvidence[];
}

/**
 * What one shared identifier is worth, or null when it is not evidence.
 *
 * Null has two causes and they are the same answer: a kind nobody has
 * calibrated (defaulting a weight for it is the fabricated confidence
 * `types.ts` forbids), and a phone whose two sides state different countries
 * (they are not the same number, so nothing about the pair has been evidenced).
 *
 * A phone claim that arrives with neither E.164 side reads as `last10Only`,
 * which is what it is: ten digits and no country.
 */
export function claimScore(claim: SharedClaim): number | null {
  if (claim.kind !== 'phone') {
    return IDENTIFIER_KIND_SCORES[claim.kind] ?? null;
  }

  const { subject_e164: subject, other_e164: other } = claim;

  if (subject != null && other != null) {
    return subject === other ? PHONE_MATCH_SCORES.e164Exact : null;
  }

  if (subject != null || other != null) {
    return PHONE_MATCH_SCORES.e164Partial;
  }

  return PHONE_MATCH_SCORES.last10Only;
}

/**
 * Score one pair from its shared claims.
 *
 * The score is the MAXIMUM of the per-kind strengths, never a sum and never a
 * product. Two shared emails are not stronger evidence than one — they are one
 * fact (these are the same mailbox owner) observed twice — and a rule that added
 * them would push a pair past any floor by finding more copies of the same
 * thing. The other matches are not discarded: they all land in `evidence`, which
 * is what a reviewer actually reads.
 *
 * Evidence is ordered strongest-first so the review UI's first line is the
 * reason the pair is here.
 */
export function scorePair(claims: readonly SharedClaim[]): MergeCandidate | null {
  if (claims.length === 0) {
    return null;
  }

  const [first] = claims;
  const [entityIdA, entityIdB] =
    first.subject_id < first.other_id
      ? [first.subject_id, first.other_id]
      : [first.other_id, first.subject_id];

  const seen = new Set<string>();
  const evidence: CandidateEvidence[] = [];

  for (const claim of claims) {
    const score = claimScore(claim);

    if (score == null) {
      // An uncalibrated kind, or a phone the two sides state different
      // countries for. Neither is evidence; see {@link claimScore}.
      continue;
    }

    const key = `${claim.kind}|${claim.value_normalized}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    evidence.push({ kind: claim.kind, value: claim.value_normalized, score });
  }

  if (evidence.length === 0) {
    return null;
  }

  evidence.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));

  const score = evidence[0].score;

  if (score < MIN_CANDIDATE_SCORE) {
    return null;
  }

  return { entityIdA, entityIdB, score, evidence };
}

/**
 * Group a slice's shared claims into scored pairs, dropping over-large groups.
 *
 * Returns the candidates AND, per swept subject, whether anything was dropped
 * for being too common — because "examined and found nothing" and "examined and
 * declined to guess" are different answers and the ledger has room for both.
 */
export function buildCandidates(claims: readonly SharedClaim[]): {
  candidates: MergeCandidate[];
  /** Subject ids for which at least one shared value exceeded the group cap. */
  suppressed: Set<string>;
} {
  const byPair = new Map<string, SharedClaim[]>();
  const suppressed = new Set<string>();

  for (const claim of claims) {
    if (claim.group_size > MAX_GROUP_MEMBERS) {
      suppressed.add(claim.subject_id);

      continue;
    }

    // Key on the ORDERED pair so the two directions of the same pair — which
    // both appear whenever both subjects are in the same slice — collapse into
    // one candidate instead of two rows racing the same unique index.
    const [a, b] =
      claim.subject_id < claim.other_id
        ? [claim.subject_id, claim.other_id]
        : [claim.other_id, claim.subject_id];
    const key = `${a}|${b}`;
    const bucket = byPair.get(key);

    if (bucket == null) {
      byPair.set(key, [claim]);
    } else {
      bucket.push(claim);
    }
  }

  const candidates: MergeCandidate[] = [];

  for (const bucket of byPair.values()) {
    const candidate = scorePair(bucket);

    if (candidate != null) {
      candidates.push(candidate);
    }
  }

  return { candidates, suppressed };
}

/** One live person name, as the name-overlap pass reads it. */
export interface PersonNameRow {
  entity_id: string;
  name: string | null;
}

/**
 * Fold two candidate lists for the same pair into one row.
 *
 * Exact-identifier evidence and name-overlap evidence are different facts
 * about the same two people. The score stays the MAX (an email is not made
 * stronger by also sharing a last name); every piece of evidence is kept.
 */
export function mergeCandidateLists(
  left: readonly MergeCandidate[],
  right: readonly MergeCandidate[],
): MergeCandidate[] {
  const byPair = new Map<string, MergeCandidate>();

  for (const candidate of [...left, ...right]) {
    const key = `${candidate.entityIdA}|${candidate.entityIdB}`;
    const existing = byPair.get(key);

    if (existing == null) {
      byPair.set(key, {
        ...candidate,
        evidence: candidate.evidence.map((item) => ({ ...item })),
      });
      continue;
    }

    const seen = new Set(existing.evidence.map((item) => `${item.kind}|${item.value}`));

    for (const item of candidate.evidence) {
      const evidenceKey = `${item.kind}|${item.value}`;
      if (seen.has(evidenceKey)) {
        continue;
      }

      seen.add(evidenceKey);
      existing.evidence.push(item);
    }

    existing.evidence.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
    existing.score = existing.evidence[0]?.score ?? existing.score;
  }

  return [...byPair.values()];
}

/**
 * Propose pairs whose display names overlap by token subset.
 *
 * Exact name claims ("william broza" = "william broza") are already handled
 * by {@link buildCandidates}. This pass is the one that notices "mr broza"
 * and "william d broza" are a question, and that Discord "william" might be
 * one of several email Williams.
 *
 * Only pairs that include at least one swept subject are returned — this
 * stage examines a slice, not the whole corpus, and proposing a pair that
 * touches nobody in the slice would write a row nobody asked this sweep
 * for.
 */
export function buildNameOverlapCandidates(
  rows: readonly PersonNameRow[],
  sliceIds: ReadonlySet<string>,
): { candidates: MergeCandidate[]; suppressed: Set<string> } {
  const tokenized = new Map<string, TokenizedPersonName>();

  for (const row of rows) {
    const parsed = tokenizePersonName(row.name);
    if (parsed == null || parsed.isRelational) {
      continue;
    }

    tokenized.set(row.entity_id, parsed);
  }

  const holders = new Map<string, string[]>();
  for (const [entityId, name] of tokenized) {
    for (const token of indexableTokens(name)) {
      const bucket = holders.get(token);
      if (bucket == null) {
        holders.set(token, [entityId]);
      } else {
        bucket.push(entityId);
      }
    }
  }

  const pairEvidence = new Map<string, MergeCandidate>();
  const givenFits = new Map<string, Set<string>>();
  const suppressed = new Set<string>();

  for (const subjectId of sliceIds) {
    const subject = tokenized.get(subjectId);
    if (subject == null) {
      continue;
    }

    const others = new Set<string>();
    for (const token of indexableTokens(subject)) {
      for (const otherId of holders.get(token) ?? []) {
        if (otherId !== subjectId) {
          others.add(otherId);
        }
      }
    }

    for (const otherId of others) {
      const other = tokenized.get(otherId);
      if (other == null) {
        continue;
      }

      const overlap = compareTokenizedNames(subject, other);
      if (overlap == null) {
        continue;
      }

      if (overlap.kind === 'family') {
        const family = subject.family ?? other.family;
        if (family != null && (holders.get(family)?.length ?? 0) > MAX_GROUP_MEMBERS) {
          suppressed.add(subjectId);
          continue;
        }
      }

      if (overlap.kind === 'given') {
        const key = subject.set.size <= other.set.size ? subjectId : otherId;
        const fits = givenFits.get(key) ?? new Set<string>();
        fits.add(subjectId === key ? otherId : subjectId);
        givenFits.set(key, fits);
      }

      const [entityIdA, entityIdB] = subjectId < otherId ? [subjectId, otherId] : [otherId, subjectId];
      const pairKey = `${entityIdA}|${entityIdB}`;
      const kind = overlap.kind === 'given' ? 'name_cluster' : 'name_overlap';
      const value = overlap.shared[overlap.shared.length - 1] ?? overlap.shared[0] ?? '';
      const existing = pairEvidence.get(pairKey);

      if (existing == null) {
        pairEvidence.set(pairKey, {
          entityIdA,
          entityIdB,
          score: overlap.score,
          evidence: [{ kind, value, score: overlap.score }],
        });
        continue;
      }

      if (overlap.score > existing.score) {
        existing.score = overlap.score;
      }

      if (!existing.evidence.some((item) => item.kind === kind && item.value === value)) {
        existing.evidence.push({ kind, value, score: overlap.score });
        existing.evidence.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
      }
    }
  }

  const candidates: MergeCandidate[] = [];

  for (const candidate of pairEvidence.values()) {
    const cluster = candidate.evidence.find((item) => item.kind === 'name_cluster');
    if (cluster != null) {
      const leftFits = givenFits.get(candidate.entityIdA)?.size ?? 0;
      const rightFits = givenFits.get(candidate.entityIdB)?.size ?? 0;
      const fits = Math.max(leftFits, rightFits);

      if (fits > MAX_NAME_CLUSTER) {
        suppressed.add(candidate.entityIdA);
        suppressed.add(candidate.entityIdB);
        continue;
      }
    }

    if (candidate.score < MIN_CANDIDATE_SCORE) {
      continue;
    }

    candidates.push(candidate);
  }

  return { candidates, suppressed };
}

/** One live person's profile fields, as {@link DuplicateDetectStage.loadProfileFacts} reads them. */
export type ProfileFactsRow = ProfileFactsCorpusRow;

/** Row → facts, keyed by entity id. A row whose fields hold no profile URL is dropped. */
export function profileFactsByEntity(rows: readonly ProfileFactsRow[]): Map<string, ProfileFacts> {
  const facts = new Map<string, ProfileFacts>();

  for (const row of rows) {
    const extracted = extractProfileFacts(row.profile_props, row.person_name);

    if (extracted.urls.size > 0) {
      facts.set(row.entity_id, extracted);
    }
  }

  return facts;
}

/**
 * Propose pairs that state the same LinkedIn profile.
 *
 * This is the pass the claim and name passes cannot be: the LinkedIn CSV copy
 * and the vCard copy of one connection share no email, no phone and — when
 * one side is "Ada L." and the other "Ada Lovelace-King" — no name the
 * tokenizer would pair. They share the profile URL.
 *
 * A URL held by more than `PROFILE_URL_MAX_HOLDERS` people (equal to
 * {@link MAX_GROUP_MEMBERS}) is not an identity, it is a shared page someone
 * pasted into many cards; the subject is marked suppressed exactly as an
 * over-common email is. Each surviving pair is graded by
 * `ProfileUrlHolders.adjudicate` — the cap, then `adjudicateProfileUrls`, the
 * same pair of steps the auto-merger re-runs on the live rows — and turned
 * into evidence by `applyProfileVerdict`.
 *
 * `facts` must be the WHOLE corpus (`loadProfileFacts`), not the slice: the
 * holder counts are taken from it.
 *
 * Only pairs touching the slice are returned, as {@link buildNameOverlapCandidates}.
 */
export function buildProfileUrlCandidates(
  facts: ReadonlyMap<string, ProfileFacts>,
  sliceIds: ReadonlySet<string>,
): { candidates: MergeCandidate[]; suppressed: Set<string> } {
  const holders = new ProfileUrlHolders(facts);
  const byPair = new Map<string, MergeCandidate>();
  const suppressed = new Set<string>();

  for (const subjectId of sliceIds) {
    const subject = facts.get(subjectId);

    if (subject == null) {
      continue;
    }

    for (const url of subject.urls) {
      if (holders.isOverCommon(url)) {
        suppressed.add(subjectId);
        continue;
      }

      for (const otherId of holders.holdersOf(url)) {
        if (otherId === subjectId) {
          continue;
        }

        const [entityIdA, entityIdB] = subjectId < otherId ? [subjectId, otherId] : [otherId, subjectId];
        const key = `${entityIdA}|${entityIdB}`;

        if (byPair.has(key)) {
          continue;
        }

        // Adjudicated in (a, b) order, so the evidence text is the same from
        // whichever end of the pair the sweep found it. Capped, so a card that
        // also carries an over-common URL is judged on its own profile alone.
        const verdict = holders.adjudicate(facts.get(entityIdA)!, facts.get(entityIdB)!);
        const graded = applyProfileVerdict({ score: 0, evidence: [] as CandidateEvidence[] }, verdict);

        if (graded.score < MIN_CANDIDATE_SCORE) {
          continue;
        }

        byPair.set(key, { entityIdA, entityIdB, ...graded });
      }
    }
  }

  return { candidates: [...byPair.values()], suppressed };
}

/**
 * The veto: re-state every candidate's profile-URL evidence under the verdict
 * for its two people.
 *
 * Runs over the MERGED list, after {@link mergeCandidateLists}, for two
 * reasons. A claim or name pair whose two people state different LinkedIn
 * profiles has to carry that fact (`profile_url_conflict`) and lose any
 * auto-merge-tier score, however strong its email match. And
 * {@link mergeCandidateLists} rescores a folded pair to its strongest item,
 * which would silently lift a capped `partial` pair back to 0.95 if an email
 * joined it; re-applying the verdict afterwards restores the cap.
 *
 * Only pairs whose BOTH people state a URL are touched — anything else is
 * `absent`, and applying `absent` would change nothing.
 *
 * ── The holder cap applies here too ────────────────────────────────────────
 *
 * Most of the pairs this sees were NOT found by {@link buildProfileUrlCandidates}
 * — they are name and claim pairs — so the cap that pass applies has not
 * touched them. Without it here, two people who share only a URL pasted into
 * forty cards would be graded `exact` (their shared name token is the
 * corroboration), and a 0.5 given-name match would leave at 0.95, hidden from
 * review and folded by the drain. So every verdict goes through
 * `ProfileUrlHolders.adjudicate`, whose counts are taken from `facts` — the
 * WHOLE corpus — and a person whose only URLs are over-common is treated as
 * stating none.
 */
export function adjudicateCandidateProfiles(
  candidates: readonly MergeCandidate[],
  facts: ReadonlyMap<string, ProfileFacts>,
): MergeCandidate[] {
  const holders = new ProfileUrlHolders(facts);

  return candidates.map((candidate) => {
    const left = facts.get(candidate.entityIdA);
    const right = facts.get(candidate.entityIdB);

    if (left == null || right == null) {
      return candidate;
    }

    const verdict = holders.adjudicate(left, right);

    if (verdict.kind === 'absent') {
      // Nothing to state, and nothing stale to strip: a pair carries
      // `profile_url` evidence only when buildProfileUrlCandidates found it
      // through a URL both people still hold under the cap.
      return candidate;
    }

    return { ...candidate, ...applyProfileVerdict(candidate, verdict) };
  });
}

/**
 * Propose pairs whose Person records carry the same phone number.
 *
 * The pass the claim pass cannot be: a Google Voice participant stub is
 * named by its number and usually has no identifier claim, and the vCard
 * copy of the same contact shares no name token with "+1 (202) 555-0142".
 * They share the number in their own `properties`.
 *
 * A number whose digits more than `PHONE_MAX_HOLDERS` people carry (equal to
 * {@link MAX_GROUP_MEMBERS}) is a switchboard, not an identity; the subject
 * is marked suppressed exactly as an over-common email is. Every other pair
 * sharing digits is graded by `PhoneHolders.adjudicate` — the same call the
 * auto-merger re-runs on the live rows — and kept when its evidence clears
 * the floor. Unusable numbers (toll-free, invalid, the owner's) and country
 * conflicts weigh nothing, so they propose nothing.
 *
 * `facts` and `holders` must be the WHOLE corpus (`loadPhoneCorpus`), not the
 * slice. Only pairs touching the slice are returned.
 */
export function buildPhoneCandidates(
  facts: ReadonlyMap<string, PhoneFacts>,
  holders: PhoneHolders,
  sliceIds: ReadonlySet<string>,
): { candidates: MergeCandidate[]; suppressed: Set<string> } {
  const byPair = new Map<string, MergeCandidate>();
  const seen = new Set<string>();
  const suppressed = new Set<string>();

  for (const subjectId of sliceIds) {
    const subject = facts.get(subjectId);

    if (subject == null) {
      continue;
    }

    for (const line of subject.lines.keys()) {
      if (holders.isOverCommon(line)) {
        suppressed.add(subjectId);
        continue;
      }

      for (const otherId of holders.holdersOf(line)) {
        if (otherId === subjectId) {
          continue;
        }

        const [entityIdA, entityIdB] = subjectId < otherId ? [subjectId, otherId] : [otherId, subjectId];
        const key = `${entityIdA}|${entityIdB}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);

        const left = facts.get(entityIdA);
        const right = facts.get(entityIdB);

        if (left == null || right == null) {
          continue;
        }

        // Adjudicated in (a, b) order, so the evidence text is the same from
        // whichever end of the pair the sweep found it.
        const graded = applyPhoneVerdict(
          { score: 0, evidence: [] as CandidateEvidence[] },
          holders.adjudicate(left, right),
        );

        if (graded.score >= MIN_CANDIDATE_SCORE) {
          byPair.set(key, { entityIdA, entityIdB, ...graded });
        }
      }
    }
  }

  return { candidates: [...byPair.values()], suppressed };
}

/**
 * Re-state every candidate's phone evidence under the verdict for its two
 * people, and hold every phone item the adjudicator did not write below the
 * auto-merge tier.
 *
 * Runs over the MERGED list, after {@link mergeCandidateLists} and BEFORE
 * {@link adjudicateCandidateProfiles}, for three reasons:
 *
 *  - A claim pair graded `e164Exact` (0.95) by {@link claimScore} has passed
 *    no name guard at all. Where both people carry phone properties, the
 *    adjudicator's verdict replaces it (a household line with two given names
 *    becomes review); where they do not, it is capped at 0.85 and marked
 *    `unadjudicated`. So the ONLY 0.95 phone item that can reach the
 *    auto-merger is one `PhoneHolders.adjudicate` wrote.
 *  - {@link mergeCandidateLists} rescores a folded pair to its strongest item,
 *    which would lift a reviewed phone pair back to 0.95 if the claim pass
 *    found the same number; re-applying the verdict afterwards restores it.
 *  - The profile veto must have the last word: a phone match can never lift a
 *    pair past `profile_url_conflict`.
 *
 * `facts` and `holders` are the whole corpus, as {@link buildPhoneCandidates}.
 */
export function adjudicateCandidatePhones(
  candidates: readonly MergeCandidate[],
  facts: ReadonlyMap<string, PhoneFacts>,
  holders: PhoneHolders,
): MergeCandidate[] {
  return candidates.map((candidate) => {
    const left = facts.get(candidate.entityIdA);
    const right = facts.get(candidate.entityIdB);
    const graded =
      left != null && right != null
        ? applyPhoneVerdict(candidate, holders.adjudicate(left, right))
        : capUnadjudicatedPhones(candidate);

    return { ...candidate, ...graded };
  });
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Proposes duplicate people. NEVER MERGES THEM.
 *
 * ── The decision this stage encodes ────────────────────────────────────────
 *
 * Clean proposes; a human disposes. There is no merge path in this file, no
 * auto-merge floor to raise, and no configuration that would create one. (The
 * deterministic tiers — a shared email, an adjudicated exact phone, an exact
 * `profile_url` — are folded by `MergeCandidateService`, which re-adjudicates
 * the live rows before every merge; this stage only writes the evidence.) That
 * is not caution about the scoring being imperfect — it is that a merge is
 * IRREVERSIBLE IN PRACTICE: `PersonMergeService` repoints
 * `entity_identifiers`, `communications.from_entity_id` / `to_entity_ids[]`,
 * `events.organizer_entity_id` / `participant_entity_ids[]` and every
 * relationship, then deletes embeddings. Unpicking that from an audit row is a
 * migration, not an undo. The asymmetry is total: a wrong proposal costs one
 * click, and a wrong merge costs the distinction between two people in a
 * personal archive, permanently.
 *
 * So the output is a row in `ci.merge_candidates` carrying the score AND the
 * evidence that produced it. The evidence is the load-bearing half. A reviewer
 * asked "are these the same person? 0.95" can only guess; a reviewer told
 * "they share liam@example.com" can answer.
 *
 * ── Why `ci.identifier_claims` and not `ci.entity_identifiers` ─────────────
 *
 * `ci.entity_identifiers` is UNIQUE on `(owner_user_id, kind, value_normalized)`,
 * so two entities CANNOT both hold the same normalized identifier: the losing
 * claim was discarded at write time by `ON CONFLICT DO NOTHING`. Duplicate
 * detection over that table is therefore structurally impossible, which is why
 * `PersonDuplicateService` reaches around it and unnests
 * `properties->'emails'` / `properties->'phones'` JSONB arrays instead — a
 * workaround that breaks silently for any writer that populates
 * `entity_identifiers` without also writing the redundant JSONB copy.
 *
 * `ci.identifier_claims` (Phase 4) keeps every claim — losing, unresolved and
 * rejected — so the group-by that finds duplicates is a group-by rather than an
 * archaeology dig. **This stage cannot run until that table exists**, and it
 * groups on `entity_id` rather than the plan's `subject_id`; both points are in
 * the note on {@link DuplicateDetectStage.loadEvidence}.
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 *  - `done` — the person was examined; `detail.candidates` says how many pairs
 *    were proposed, INCLUDING ZERO. Zero is a real answer — "this person has
 *    identifiers and no duplicate" — and it is the reason coverage is
 *    meaningful. It must never be confused with the next line.
 *  - `skipped: no_identifier_claims` — the person has NO claims at all and
 *    none of the name, profile-URL and phone passes proposed anything for
 *    them, so there was nothing to compare on. Countable, and it is the number
 *    that says how much of the corpus `enrich.person_link` has not reached yet.
 *  - `skipped: identifiers_too_common` — every shared value this person has is
 *    held by more than {@link MAX_GROUP_MEMBERS} subjects. Examined, and
 *    deliberately not guessed at.
 *  - `skipped: source_row_missing` — deleted or re-owned between sweep and slice.
 *  - `failed: candidate_write_failed` — the pairs were computed, the upsert did
 *    not commit. Retryable.
 */
@Injectable()
export class DuplicateDetectStage implements Stage {
  readonly id = CLEAN_DUPLICATE_DETECT_STAGE_ID;

  /** Resolved once at construction; see `GeocodeStage` on why not a getter. */
  readonly version = duplicateDetectStageVersion();

  /**
   * `pipeline-index`: two Postgres statements per slice and no external call.
   *
   * The plan pairs `clean.duplicate_detect` with "a singleton policy so two
   * workers cannot merge overlapping groups". That requirement belongs to a
   * MERGE, and this stage does not merge. Two workers proposing the same pair
   * concurrently is absorbed by the unique index and the upsert — the ordinary
   * cooperative-claim story the ledger already tells — so no singleton queue is
   * needed and none is asked for.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = DUPLICATE_DETECT_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DuplicateDetectStage.name);
  }

  /**
   * Examine one slice of people.
   *
   * Idempotent: the same slice produces the same pairs, and the upsert is keyed
   * on the ordered pair, so a duplicate dispatch costs one redundant statement.
   * The symmetric pair (B, A) is normalized to (A, B) in
   * {@link buildCandidates} before it reaches SQL, so a pair discovered from
   * both ends — the common case, since both people are usually in the same
   * corpus — is one row, not two.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const subjects = await this.loadSubjects(ctx.userId, ids);

    for (const id of ids) {
      if (!subjects.has(id)) {
        // Deleted, deactivated, tombstoned by a merge, or re-owned between the
        // sweep and the slice. A skip: nothing to retry.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const examined = ids.filter((id) => subjects.has(id));

    if (examined.length === 0) {
      return results;
    }

    const claims = await this.loadEvidence(ctx.userId, examined);
    const { candidates: exactCandidates, suppressed } = buildCandidates(claims);
    const names = await this.loadPersonNames(ctx.userId);
    const { candidates: nameCandidates, suppressed: nameSuppressed } = buildNameOverlapCandidates(
      names,
      new Set(examined),
    );

    const profileFacts = profileFactsByEntity(await this.loadProfileFacts(ctx.userId));
    const { candidates: profileCandidates, suppressed: profileSuppressed } = buildProfileUrlCandidates(
      profileFacts,
      new Set(examined),
    );

    const phoneCorpus = await this.loadPhoneCorpus(ctx.userId);
    const { candidates: phoneCandidates, suppressed: phoneSuppressed } = buildPhoneCandidates(
      phoneCorpus.facts,
      phoneCorpus.holders,
      new Set(examined),
    );

    for (const id of [...nameSuppressed, ...profileSuppressed, ...phoneSuppressed]) {
      suppressed.add(id);
    }

    // Phone before profile: the profile veto has the last word on the score.
    // The floor is re-applied because the phone verdict can REMOVE evidence —
    // a claim pair whose only shared number turns out to be toll-free, say.
    const candidates = adjudicateCandidateProfiles(
      adjudicateCandidatePhones(
        mergeCandidateLists(
          mergeCandidateLists(mergeCandidateLists(exactCandidates, nameCandidates), profileCandidates),
          phoneCandidates,
        ),
        phoneCorpus.facts,
        phoneCorpus.holders,
      ),
      profileFacts,
    ).filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE);

    /** How many surviving pairs each swept subject appears in. */
    const proposedFor = new Map<string, number>();

    for (const candidate of candidates) {
      for (const id of [candidate.entityIdA, candidate.entityIdB]) {
        proposedFor.set(id, (proposedFor.get(id) ?? 0) + 1);
      }
    }

    if (candidates.length > 0) {
      try {
        await this.writeCandidates(ctx.userId, candidates);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // One statement, one verdict. Every subject that contributed a pair
        // shares it; the rest are answered normally below.
        for (const candidate of candidates) {
          for (const id of [candidate.entityIdA, candidate.entityIdB]) {
            if (subjects.has(id)) {
              results.set(id, {
                outcome: 'failed',
                reason: 'candidate_write_failed',
                detail: { message },
              });
            }
          }
        }

        this.logger.error(
          `Merge candidate write failed for ${candidates.length} pairs`,
          err instanceof Error ? err : new Error(message),
        );
      }
    }

    for (const id of examined) {
      if (results.has(id)) {
        continue;
      }

      const proposed = proposedFor.get(id) ?? 0;

      // The claim COUNT — not the shared-claim rows — is what separates the two
      // very different silences. `loadEvidence` returns only claims another
      // subject also holds, so a person with a perfectly good email that nobody
      // else has produces no rows there and would otherwise be recorded
      // `no_identifier_claims`. That is a lie about the healthy majority of the
      // corpus, and it would make the ledger read as "identity has not reached
      // these people" when identity has reached them and found nothing.
      //
      // A person with no claims who was still PROPOSED — by name, by profile
      // URL or by a phone in their own properties, none of which needs a
      // claim — was examined and answered, so it is `done`, not a coverage gap.
      if ((subjects.get(id) ?? 0) === 0 && proposed === 0) {
        results.set(id, { outcome: 'skipped', reason: 'no_identifier_claims' });

        continue;
      }

      if (proposed === 0 && suppressed.has(id)) {
        // Examined, and deliberately not guessed at: every value this person
        // shares is held by more subjects than the cap allows.
        results.set(id, {
          outcome: 'skipped',
          reason: 'identifiers_too_common',
          detail: { maxGroupMembers: MAX_GROUP_MEMBERS },
        });

        continue;
      }

      // `done` with zero candidates is a real answer — "examined, no duplicates"
      // — and it is what makes coverage mean anything at all.
      results.set(id, {
        outcome: 'done',
        detail: { candidates: proposed, suppressedCommonValues: suppressed.has(id) },
      });
    }

    return results;
  }

  /**
   * Which of the slice's ids are still live people owned by this user, and how
   * many identifier claims each one has.
   *
   * Re-applies the applicability predicate at slice time, deliberately. The
   * sweep already filtered, but a slice can arrive from a dead letter replayed
   * weeks later — by which time a person may have been merged away — and
   * proposing a merge for a tombstone would put a pair in the review queue that
   * cannot be acted on.
   *
   * The COUNT is what separates "identity has not reached this person" from
   * "this person has identifiers and no duplicate", which is the difference
   * between a coverage number that reads as a gap and one that reads as a clean
   * result. `loadEvidence` cannot answer it: by construction it returns only
   * claims that another subject also holds.
   *
   * User-scoped for the reason every stage is: re-scoping is the difference
   * between "this id is not yours" and reading someone else's contacts.
   */
  private async loadSubjects(userId: string, ids: string[]): Promise<Map<string, number>> {
    const rows = await this.dataSource.query<Array<{ entity_id: string; claim_count: number }>>(
      `SELECT e.entity_id,
              (SELECT count(*)
                 FROM ci.identifier_claims c
                WHERE c.owner_user_id = $2::uuid
                  AND c.entity_id = e.entity_id
                  AND c.disposition IS DISTINCT FROM 'rejected')::int AS claim_count
         FROM ci.entities e
        WHERE e.entity_id = ANY($1::uuid[])
          AND e.owner_user_id = $2::uuid
          AND e.entity_type = '${CANDIDATE_ENTITY_TYPE}'
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL`,
      [ids, userId],
    );

    return new Map(rows.map((row) => [row.entity_id, Number(row.claim_count)]));
  }

  /**
   * Live Person display names for the owner — the input to
   * {@link buildNameOverlapCandidates}.
   *
   * Loaded corpus-wide rather than regex-matched against the slice's tokens
   * because display names keep diacritics ("José") while tokens are NFKD-
   * folded ("jose"), so a word-boundary lookup on the raw column would miss
   * the people the pass exists to find. A user's person list fits in one
   * result set; the nightly slice cost is the price of comparing names that
   * are not exact identifier matches.
   */
  private loadPersonNames(userId: string): Promise<PersonNameRow[]> {
    return this.dataSource.query<PersonNameRow[]>(
      `SELECT e.entity_id, e.name
         FROM ci.entities e
        WHERE e.owner_user_id = $1::uuid
          AND e.entity_type = '${CANDIDATE_ENTITY_TYPE}'
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL
          AND e.name IS NOT NULL
          AND btrim(e.name) <> ''`,
      [userId],
    );
  }

  /**
   * The profile-URL fields of every live Person that could hold a LinkedIn
   * profile — the input to {@link buildProfileUrlCandidates} and
   * {@link adjudicateCandidateProfiles}.
   *
   * Corpus-wide, like {@link loadPersonNames} and for the same reason: the
   * other copy of a slice subject can be anyone in the corpus. The ILIKE is a
   * superset prefilter only (a few thousand rows on a real corpus, not the
   * whole Person table); `normalizeProfileUrl` decides in TypeScript. Only the
   * handful of keys the extractor reads are loaded, never the whole
   * `properties` bag.
   *
   * `person_name`, not `name`: the column is aliased so nothing downstream can
   * mistake this row set for {@link loadPersonNames}'.
   */
  private loadProfileFacts(userId: string): Promise<ProfileFactsRow[]> {
    return this.dataSource.query<ProfileFactsRow[]>(PROFILE_FACTS_CORPUS_SQL, [userId]);
  }

  /**
   * The phone facts of every live Person that carries a phone value or is
   * named by a number, the owner's region derived from them, and the holder
   * index over them — the input to {@link buildPhoneCandidates} and
   * {@link adjudicateCandidatePhones}.
   *
   * Corpus-wide, like {@link loadProfileFacts}: the other copy of a slice
   * subject can be anyone, and the holder cap, the owner's lines and the line
   * census are all corpus counts. Three statements, none per-row:
   *
   *  - `ci.users` for the time zone and `users.entity_id` (a self Person that
   *    is not flagged `is_self` is still the owner);
   *  - `PHONE_FACTS_CORPUS_SQL`, the auto-merger's population too;
   *  - `PHONE_CLAIM_E164_SQL` for the stated forms claims carry, asked only
   *    about digits two or more people share (the only ones a pair can form
   *    on), so the foreign-stated guard sees `value_e164` as well.
   */
  private async loadPhoneCorpus(userId: string): Promise<{
    facts: Map<string, PhoneFacts>;
    holders: PhoneHolders;
  }> {
    const [owner] = await this.dataSource.query<Array<{ timezone: string | null; entity_id: string | null }>>(
      `SELECT u.timezone, u.entity_id FROM ci.users u WHERE u.id = $1::uuid`,
      [userId],
    );
    const rows = await this.dataSource.query<PhoneFactsCorpusRow[]>(PHONE_FACTS_CORPUS_SQL, [userId]);
    const { facts } = phoneCorpusFacts(rows, {
      timezone: owner?.timezone ?? null,
      selfEntityId: owner?.entity_id ?? null,
    });
    const shared = sharedPhoneLines(facts);
    const claims =
      shared.length === 0
        ? []
        : await this.dataSource.query<PhoneClaimE164Row[]>(PHONE_CLAIM_E164_SQL, [userId, shared]);

    return {
      facts,
      holders: new PhoneHolders(
        facts,
        claims.map((row) => [row.l10, row.e164] as const),
      ),
    };
  }

  /**
   * Every identifier the slice's people share with another person.
   *
   * ── Grouped on `entity_id`, NOT on `subject_id` ───────────────────────────
   *
   * The rebuild plan's §7.1 query groups `ci.identifier_claims` by
   * `subject_id` with `subject_type = 'person'`. The table as built
   * (`20260809183010_identifier_claims`) does not have that shape, and the
   * difference is not cosmetic:
   *
   *  - `subject_id` is WHERE the identifier was observed — a communication or an
   *    event row, in the overwhelming majority of claims.
   *  - `entity_id` is WHO it resolved to, nullable, and it is the person.
   *
   * Grouping on `subject_id` would therefore find duplicates only among claims a
   * contact importer wrote as `subject_type = 'person'` (an entity asserting its
   * own identifier) and would miss every duplicate evidenced by mail and
   * calendar traffic — which is nearly all of them. The table's own index
   * comment states the correct rule outright: *"One identifier resolving to more
   * than one entity IS the merge candidate"*. So: group on `entity_id`, and the
   * `subject_type` filter disappears entirely, because where a claim was
   * observed has no bearing on who it identifies.
   *
   * `entity_id IS NULL` claims — the triage queue of identifiers that resolved to
   * nobody — are excluded on both sides. An unresolved claim is not evidence
   * that two PEOPLE are the same; it is evidence that a person is missing, which
   * is `enrich.person_link`'s problem.
   *
   * `disposition = 'rejected'` claims are excluded too, on both sides. That is a
   * human's verdict that this identifier does NOT belong to this entity, and the
   * table keeps the row precisely so the rejection is not re-derived. Building a
   * merge proposal out of one would re-derive it by the back door.
   *
   * ── If the table is not there yet ─────────────────────────────────────────
   *
   * The statement raises `relation "ci.identifier_claims" does not exist`, the
   * slice throws, and `PipelineSliceListener` does the right thing: every
   * claimed id is failed with `stage_threw: …`, the payload is written verbatim
   * to `ci.pipeline_dead_letters`, and pg-boss's retry applies. Loud and
   * replayable — and the reason this stage must not be bound in
   * `stageProviders` ahead of its migration.
   *
   * ── Why the group size is computed in SQL ─────────────────────────────────
   *
   * `MAX_GROUP_MEMBERS` bounds how many subjects may share a value CORPUS-WIDE,
   * not how many appear in this slice. A slice of 200 people can contain two
   * members of a 400-member `noreply@` group and would look like an ordinary
   * pair from inside the slice. The window function counts the whole group, so
   * the cap means what it says regardless of how the sweep happened to page.
   *
   * ── Why it is SET-BASED, not a correlated subquery ─────────────────────
   *
   * An earlier revision computed `group_size` and the other side's E.164 form
   * as correlated subqueries — `(SELECT count(DISTINCT o.entity_id) …)` per
   * row — on the theory that each would ride `identifier_claims_lookup_idx`.
   * Measured against a real corpus (1.57M claims, 183-id slice, 2026-09-15)
   * that revision did not finish in SIX HOURS, and three retries of the same
   * slice ran concurrently on eight backends. Two things went wrong at once:
   *
   *  1. TimescaleDB's skip-scan planner (`enable_skipscan_for_distinct_aggregates`,
   *     on by default since 2.20) rewrote the `count(DISTINCT entity_id)`
   *     subquery as a skip scan over `identifier_claims_entity_idx` — the index
   *     ordered by the DISTINCT column — with `kind` and `value_normalized`
   *     demoted to a heap FILTER. One evaluation therefore walked most of the
   *     table; the subquery alone timed out at 60 s for 364 rows.
   *  2. Because the subqueries appeared in the `SELECT DISTINCT` list, the
   *     planner evaluated them once per JOINED row (142k for that slice —
   *     one shared name held 4,468 claims), not once per `mine` row.
   *
   * So the query now materialises the small sets and joins them. `mine` is the
   * slice's identifiers; `holders` is every entity holding one of those
   * identifiers, grouped to one row per (entity, kind, value) with its E.164
   * form aggregated in the same pass; `sized` counts holders per value with a
   * window function. The final join is then one row per (subject, other) pair
   * with no correlated work and no DISTINCT. `MATERIALIZED` is deliberate:
   * without it Postgres inlines the CTEs and is free to plan its way back into
   * the correlated shape. Same slice, same rows, 0.4 s.
   *
   * ── Why the E.164 form is AGGREGATED, not selected ────────────────────────
   *
   * `value_e164` lives on the CLAIM, and one subject routinely holds several
   * claims for one normalized value — the same number seen in a mail header, a
   * calendar invite and a contact card — of which some may state a country and
   * some may not. Selecting the column raw would multiply those into two rows
   * differing only in a nullable column, and the pair would then be scored
   * twice under two different tiers.
   *
   * So both sides collapse to ONE answer per (subject, kind, value):
   * `count(DISTINCT value_e164) = 1` means every claim that stated a country
   * stated the same one, and `min()` is then that country's form. Zero claims
   * stating a country, or two disagreeing, both yield NULL — "this subject does
   * not have a settled international form", which {@link claimScore} reads as
   * exactly that rather than picking a winner.
   *
   * The other side's form comes from the same `holders` aggregate, so it costs
   * nothing extra; `CASE WHEN s.kind = 'phone'` keeps the column NULL for every
   * other kind, as the previous per-row lookup did.
   *
   * ── Why the block check probes ONE order, not two ─────────────────────────
   *
   * `ci.entity_merge_blocks` carries `CHECK (entity_id_a < entity_id_b)`
   * (`entity_merge_blocks_ordered`, verified against the live schema), so every
   * block is stored canonically and `LEAST/GREATEST` is COMPLETE — it cannot
   * miss a block written the other way round, because the database refuses to
   * store one. Probing both orders would be one wasted index lookup per claim
   * for a case the constraint makes unreachable. If that constraint is ever
   * dropped, this must go back to the two-way test in the same change.
   *
   * The block is the user's permanent "these are NOT the same person", and it is
   * applied HERE — before scoring — so a blocked pair never reaches the review
   * queue and never costs a row.
   */
  private loadEvidence(userId: string, ids: string[]): Promise<SharedClaim[]> {
    return this.dataSource.query<SharedClaim[]>(
      `WITH mine AS MATERIALIZED (
         SELECT c.entity_id AS subject_id,
                c.kind,
                c.value_normalized,
                CASE WHEN count(DISTINCT c.value_e164) = 1
                     THEN min(c.value_e164) END AS subject_e164
           FROM ci.identifier_claims c
          WHERE c.owner_user_id = $2::uuid
            AND c.entity_id = ANY($1::uuid[])
            AND c.disposition IS DISTINCT FROM 'rejected'
          GROUP BY c.entity_id, c.kind, c.value_normalized
       ),
       holders AS MATERIALIZED (
         SELECT o.entity_id,
                o.kind,
                o.value_normalized,
                CASE WHEN count(DISTINCT o.value_e164) = 1
                     THEN min(o.value_e164) END AS e164
           FROM (SELECT kind, value_normalized FROM mine GROUP BY kind, value_normalized) v
           JOIN ci.identifier_claims o
             ON o.owner_user_id = $2::uuid
            AND o.kind = v.kind
            AND o.value_normalized = v.value_normalized
          WHERE o.entity_id IS NOT NULL
            AND o.disposition IS DISTINCT FROM 'rejected'
          GROUP BY o.entity_id, o.kind, o.value_normalized
       ),
       sized AS MATERIALIZED (
         SELECT h.entity_id,
                h.kind,
                h.value_normalized,
                h.e164,
                count(*) OVER (PARTITION BY h.kind, h.value_normalized) AS group_size
           FROM holders h
       )
       SELECT s.subject_id,
              o.entity_id AS other_id,
              s.kind,
              s.value_normalized,
              s.subject_e164,
              CASE WHEN s.kind = 'phone' THEN o.e164 END AS other_e164,
              o.group_size::int AS group_size
         FROM mine s
         JOIN sized o
           ON o.kind = s.kind
          AND o.value_normalized = s.value_normalized
          AND o.entity_id <> s.subject_id
         JOIN ci.entities e
           ON e.entity_id = o.entity_id
          AND e.owner_user_id = $2::uuid
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL
        WHERE NOT EXISTS (
                SELECT 1
                  FROM ci.entity_merge_blocks b
                 WHERE b.owner_user_id = $2::uuid
                   AND b.entity_id_a = LEAST(s.subject_id, o.entity_id)
                   AND b.entity_id_b = GREATEST(s.subject_id, o.entity_id))`,
      [ids, userId],
    );
  }

  /**
   * Upsert the slice's pairs into `ci.merge_candidates`, in one statement.
   *
   * ── `WHERE status = 'pending'` is the human's veto ────────────────────────
   *
   * The `DO UPDATE` refreshes score and evidence only while the row is still
   * awaiting review. A pair the user REJECTED stays rejected: re-proposing it
   * on the next sweep would ask the same question forever, which is how a review
   * queue stops being read. A pair the user ACCEPTED keeps its acceptance, so a
   * concurrent sweep cannot walk it back to pending between the click and the
   * merge.
   *
   * A permanent "never ask again" is `ci.entity_merge_blocks`, which
   * {@link loadEvidence} already honours — a decision that outlives this table
   * and applies to every detector generation, not just this one.
   *
   * ── Nothing is withdrawn ──────────────────────────────────────────────────
   *
   * A rescoring bump that no longer finds a pair leaves the old PENDING row in
   * place rather than deleting it. Deleting would be this stage destroying its
   * own prior proposal, and a review queue whose contents change under the
   * reviewer is worse than a stale row: `detector_version` says which generation
   * produced each row, so a stale proposal is identifiable and reapable by a
   * deliberate `clean.fact_reap`, which is where that decision belongs.
   *
   * `evidence` is written as one jsonb array per pair rather than as rows,
   * matching `ci.promotion_candidates.evidence`, the shape the review UI in this
   * repo already reads.
   */
  private async writeCandidates(userId: string, candidates: MergeCandidate[]): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci.merge_candidates (
         owner_user_id, entity_type, entity_id_a, entity_id_b,
         score, evidence, detected_by, detector_version
       )
       SELECT $1::uuid, $2::text, u.entity_id_a, u.entity_id_b,
              u.score, u.evidence, $6::text, $7::int
         FROM unnest($3::uuid[], $4::uuid[], $5::float8[], $8::jsonb[])
              AS u(entity_id_a, entity_id_b, score, evidence)
       ON CONFLICT (owner_user_id, entity_type, entity_id_a, entity_id_b)
       DO UPDATE SET score            = EXCLUDED.score,
                     evidence         = EXCLUDED.evidence,
                     detector_version = EXCLUDED.detector_version,
                     updated_at       = now()
             WHERE ci.merge_candidates.status = 'pending'`,
      [
        userId,
        CANDIDATE_ENTITY_TYPE,
        candidates.map((candidate) => candidate.entityIdA),
        candidates.map((candidate) => candidate.entityIdB),
        candidates.map((candidate) => candidate.score),
        this.id,
        this.version,
        candidates.map((candidate) => JSON.stringify(candidate.evidence)),
      ],
    );
  }
}
