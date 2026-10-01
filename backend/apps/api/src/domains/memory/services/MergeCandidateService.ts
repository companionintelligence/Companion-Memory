import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { countAffected } from '@ci/common/persistence';

import { type Person, PersonEntity } from '../entities/PersonEntity';
import {
  EMAIL_EVIDENCE,
  emailHoldReason,
  holdEmailEvidence,
  type EmailCheckReason,
} from '../utils/emailIdentity';
import { pickFullerName } from '../utils/personNameTokens';
import {
  PHONE_CLAIM_E164_SQL,
  PHONE_EVIDENCE,
  PHONE_FACTS_CORPUS_SQL,
  PHONE_IDENTITY_SCORES,
  PHONE_MAX_HOLDERS,
  PhoneHolders,
  applyPhoneVerdict,
  carriedPhoneLines,
  extractPhoneFacts,
  isPlaceholderPersonName,
  phoneCorpusFacts,
  phoneFactsSqlObject,
  revalidatePhoneEvidence,
  sharedPhoneLines,
  type PhoneClaimE164Row,
  type PhoneFacts,
  type PhoneFactsCorpusRow,
  type PhoneRegion,
  type PhoneVerdict,
} from '../utils/phoneIdentity';
import {
  PROFILE_FACTS_CORPUS_SQL,
  PROFILE_URL_EVIDENCE,
  PROFILE_URL_SCORES,
  ProfileUrlHolders,
  applyProfileVerdict,
  extractProfileFacts,
  profileFactsSqlObject,
  type ProfileFacts,
  type ProfileFactsCorpusRow,
  type ProfileVerdict,
} from '../utils/profileUrls';

import { PersonMergeService } from './PersonMergeService';

/** The three states `ci.merge_candidates.status` is CHECK-constrained to. */
export type MergeCandidateStatus = 'pending' | 'accepted' | 'rejected';

export const MERGE_CANDIDATE_STATUSES: readonly MergeCandidateStatus[] = ['pending', 'accepted', 'rejected'];

export function isMergeCandidateStatus(value: string): value is MergeCandidateStatus {
  return (MERGE_CANDIDATE_STATUSES as readonly string[]).includes(value);
}

/** One shared claim behind a proposal, as written by the detector. */
export interface MergeCandidateEvidence {
  kind: string;
  value: string;
  score: number | null;
}

/** A scored pair the detector proposed, hydrated for review. */
export interface MergeCandidate {
  id: string;
  entityType: string;
  score: number;
  status: MergeCandidateStatus;
  detectedBy: string;
  detectorVersion: number;
  createdAt: Date;
  evidence: MergeCandidateEvidence[];
  /** Exactly the two people of the pair, `entity_id_a` first. */
  people: Person[];
}

export interface MergeCandidatePage {
  candidates: MergeCandidate[];
  /** Reviewable pairs in this status, ignoring the cursor. */
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Rows per keyset page of the deterministic drain. */
const AUTO_MERGE_PAGE_SIZE = 100;

/** The verdict for a pair in which at least one side states no profile URL. */
const ABSENT: ProfileVerdict = { kind: 'absent' };

/**
 * The score a demoted row falls to when its live evidence no longer weighs
 * anything — e.g. a pair proposed only on a profile URL whose two sides now
 * state different profiles. The name floor: the weakest score any proposal
 * carries, so the row sits at the bottom of the queue, labelled, instead of
 * violating `merge_candidates_score_check (score > 0)`.
 */
const DEMOTED_FLOOR_SCORE = 0.5;

/**
 * The scheduler name of `DeterministicPersonMergeCron.drain`.
 *
 * Also the KILL SWITCH for the phone and profile-URL tiers: disabling this
 * schedule on the Jobs page stops the hourly drain, and the People page's
 * on-read fold reads the same setting and stops folding phone and profile-URL
 * pairs too, which the queue then shows for review. Only email pairs keep
 * folding on read unconditionally.
 */
export const DETERMINISTIC_MERGE_CRON = 'DeterministicPersonMergeCron.drain';

export interface AutoMergeOptions {
  /** Wall-clock budget. The drain stops starting new merges once it is spent. */
  budgetMs: number;
  /** Fold pairs whose ONLY deterministic evidence is an exact profile URL. Default true. */
  includeProfileUrl?: boolean;
  /** Fold pairs whose ONLY deterministic evidence is an adjudicated exact phone. Default true. */
  includePhone?: boolean;
  /** Keyset page size. Default {@link AUTO_MERGE_PAGE_SIZE}. */
  pageSize?: number;
}

export interface AutoMergeResult {
  /** Pairs folded. */
  merged: number;
  /** Pairs left pending untouched: an endpoint gone, two self endpoints, a failed merge, the tier off. */
  skipped: number;
  /** Pairs whose live re-check failed and were rewritten to reviewable evidence. */
  demoted: number;
  /**
   * Pairs whose live re-check left NO evidence at all — nothing that weighs and
   * no veto to reject — and whose pending row was therefore removed rather than
   * shown as a reasonless "Proposed as the same person". See {@link MergeCandidateService.revalidatePhoneEvidence}.
   */
  retired: number;
  /** Candidate rows read. */
  considered: number;
}

export interface PhoneRevalidationOptions {
  /** Wall-clock budget. The pass stops reading new pages once it is spent. */
  budgetMs: number;
  /** Keyset page size. Default {@link AUTO_MERGE_PAGE_SIZE}. */
  pageSize?: number;
}

export interface PhoneRevalidationResult {
  /** Pending rows carrying phone evidence that were read. */
  considered: number;
  /** Rows whose phone evidence partly stopped holding, rewritten to what still does. */
  rewritten: number;
  /** Rows left with no evidence at all, removed from the queue. */
  retired: number;
}

/** The outcome of writing one re-checked row back. */
type RecheckOutcome = 'rewritten' | 'retired' | 'failed';

export function hasEmailEvidence(evidence: readonly MergeCandidateEvidence[]): boolean {
  return evidence.some((item) => item.kind === 'email');
}

/** Phone evidence at the adjudicated exact tier — the same strength as an email. */
export function hasExactPhoneEvidence(evidence: readonly MergeCandidateEvidence[]): boolean {
  return evidence.some(
    (item) =>
      item.kind === PHONE_EVIDENCE.match && item.score != null && item.score >= PHONE_IDENTITY_SCORES.exact,
  );
}

/**
 * Opaque keyset cursor over the review order (`score DESC, id ASC`).
 *
 * Offset paging would be wrong here: accepting or rejecting a candidate takes
 * it out of the `pending` set, so every decision shifts the rows behind it and
 * an offset would silently skip the pair that moved up into the seam.
 */
export function encodeMergeCandidateCursor(candidate: { score: number; id: string }): string {
  return Buffer.from(`${candidate.score}::${candidate.id}`).toString('base64');
}

export function decodeMergeCandidateCursor(cursor: string): { score: number; id: string } | null {
  try {
    const [score, id] = Buffer.from(cursor, 'base64').toString('utf8').split('::');
    const parsed = Number(score);

    if (!Number.isFinite(parsed) || !id) {
      return null;
    }

    return { score: parsed, id };
  } catch {
    return null;
  }
}

function parseEvidence(raw: unknown): MergeCandidateEvidence[] {
  const list = typeof raw === 'string' ? safeJson(raw) : raw;

  if (!Array.isArray(list)) {
    return [];
  }

  return list.flatMap((item) => {
    if (item == null || typeof item !== 'object') {
      return [];
    }

    const row = item as Record<string, unknown>;
    const kind = typeof row.kind === 'string' ? row.kind : null;
    if (kind == null) {
      return [];
    }

    return [
      {
        kind,
        value: typeof row.value === 'string' ? row.value : String(row.value ?? ''),
        score: typeof row.score === 'number' ? row.score : null,
      },
    ];
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Both endpoints still live, and the pair not permanently blocked.
 *
 * Shared verbatim by the page and its count so the "N pending" the UI shows can
 * never disagree with the rows underneath it.
 */
const LIVE_PAIR_PREDICATE = `EXISTS (
            SELECT 1 FROM ci.entities a
             WHERE a.owner_user_id = mc.owner_user_id
               AND a.entity_id = mc.entity_id_a
               AND a.entity_type = mc.entity_type
               AND COALESCE(a.is_active, true) = true
               AND a.merged_into_entity_id IS NULL)
          AND EXISTS (
            SELECT 1 FROM ci.entities b
             WHERE b.owner_user_id = mc.owner_user_id
               AND b.entity_id = mc.entity_id_b
               AND b.entity_type = mc.entity_type
               AND COALESCE(b.is_active, true) = true
               AND b.merged_into_entity_id IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM ci.entity_merge_blocks blk
             WHERE blk.owner_user_id = mc.owner_user_id
               AND blk.entity_id_a = mc.entity_id_a
               AND blk.entity_id_b = mc.entity_id_b)`;

/**
 * These two people already share a mailbox.
 *
 * `ci.entity_identifiers` cannot answer this: it is unique on
 * `(owner, kind, value)`, so two live people cannot both hold the same email
 * there. Claims and properties still can, which is how the duplicates exist.
 * The one tier with no kill switch: it folded on read before the drain
 * existed.
 */
const SHARES_EXACT_EMAIL = `(
            mc.evidence @> '[{"kind":"email"}]'::jsonb
            OR EXISTS (
              SELECT 1
                FROM ci.identifier_claims ca
                JOIN ci.identifier_claims cb
                  ON ca.owner_user_id = cb.owner_user_id
                 AND ca.kind = 'email'
                 AND cb.kind = 'email'
                 AND ca.value_normalized = cb.value_normalized
               WHERE ca.owner_user_id = mc.owner_user_id
                 AND ca.entity_id = mc.entity_id_a
                 AND cb.entity_id = mc.entity_id_b
                 AND ca.disposition IS DISTINCT FROM 'rejected'
                 AND cb.disposition IS DISTINCT FROM 'rejected')
            OR EXISTS (
              SELECT 1
                FROM ci.entities ea
                JOIN ci.entities eb
                  ON ea.owner_user_id = eb.owner_user_id
               WHERE ea.entity_id = mc.entity_id_a
                 AND eb.entity_id = mc.entity_id_b
                 AND (
                   (lower(btrim(COALESCE(ea.properties->>'email', ''))) <> ''
                    AND lower(btrim(ea.properties->>'email'))
                      = lower(btrim(eb.properties->>'email')))
                   OR EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements_text(
                              COALESCE(ea.properties->'emails', '[]'::jsonb)
                            ) a_email
                       JOIN jsonb_array_elements_text(
                              COALESCE(eb.properties->'emails', '[]'::jsonb)
                            ) b_email
                         ON lower(btrim(a_email)) = lower(btrim(b_email))
                      WHERE lower(btrim(a_email)) <> '')))
          )`;

/**
 * The detector graded this pair's phone numbers `exact`: one equal, valid,
 * ordinary number, names compatible, the line not shared. See
 * `utils/phoneIdentity.ts` — its adjudicator is the only producer of a phone
 * item at this score; the detector caps every other one at 0.85.
 *
 * Deliberately NOT a join on `identifier_claims.value_e164`, which this
 * predicate used to carry: two claims agreeing on an E.164 say nothing about
 * whether the two people are one person or a household on one line, and that
 * clause folded such pairs with no name guard at all.
 */
const SHARES_EXACT_PHONE = `EXISTS (
              SELECT 1
                FROM jsonb_array_elements(mc.evidence) ev
               WHERE ev->>'kind' = '${PHONE_EVIDENCE.match}'
                 AND COALESCE((ev->>'score')::float, 0) >= ${PHONE_IDENTITY_SCORES.exact})`;

/**
 * The detector graded this pair's LinkedIn profile URLs `exact`: equal sets,
 * corroborated by a name token or a connection date, contradicted by neither.
 * See `utils/profileUrls.ts`.
 */
const SHARES_EXACT_PROFILE_URL = `EXISTS (
              SELECT 1
                FROM jsonb_array_elements(mc.evidence) ev
               WHERE ev->>'kind' = '${PROFILE_URL_EVIDENCE.match}'
                 AND COALESCE((ev->>'score')::float, 0) >= ${PROFILE_URL_SCORES.exact})`;

/**
 * The two people state DIFFERENT LinkedIn profiles (disjoint sets), or one
 * card lists a profile the other does not (overlapping, unequal sets). Either
 * outranks a shared email: two same-name people with different profiles are
 * two people, however they came to share a mailbox. A vetoed pair is NOT
 * hidden — it stays on the review queue, labelled, so a human can reject it
 * and make the rejection sticky.
 */
const PROFILE_URL_VETOED = `(
            mc.evidence @> '[{"kind":"${PROFILE_URL_EVIDENCE.conflict}"}]'::jsonb
            OR mc.evidence @> '[{"kind":"${PROFILE_URL_EVIDENCE.partial}"}]'::jsonb)`;

/**
 * A shared-mailbox pair held for a human (`utils/emailIdentity.ts`): one side
 * is the owner and the other's name contradicts theirs, or two contacts'
 * names share nothing. Folding it would join two people on one card's say-so,
 * so, like a profile veto, it blocks every fold and keeps the pair visible on
 * the queue, labelled.
 */
const EMAIL_HELD = `mc.evidence @> '[{"kind":"${EMAIL_EVIDENCE.check}"}]'::jsonb`;

/**
 * The row carries any phone evidence item — a match, the reason one was held
 * for review, or a country conflict. The population the review queue's phone
 * re-check reads ({@link MergeCandidateService.revalidatePhoneEvidence}).
 */
const CARRIES_PHONE_EVIDENCE = `(
            mc.evidence @> '[{"kind":"${PHONE_EVIDENCE.match}"}]'::jsonb
            OR mc.evidence @> '[{"kind":"${PHONE_EVIDENCE.check}"}]'::jsonb
            OR mc.evidence @> '[{"kind":"${PHONE_EVIDENCE.conflict}"}]'::jsonb)`;

/**
 * Evidence kinds that say "these are two people". A row whose live re-check
 * leaves one of them and nothing that weighs stays on the queue at
 * {@link DEMOTED_FLOOR_SCORE}, labelled, so the human can reject it and make
 * the rejection sticky; a row left with nothing at all is retired.
 */
const VETO_EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  PROFILE_URL_EVIDENCE.conflict,
  PROFILE_URL_EVIDENCE.partial,
  PHONE_EVIDENCE.conflict,
]);

/** Which switchable tiers are on. Email is always on. */
interface DeterministicTiers {
  profileUrl: boolean;
  phone: boolean;
}

/**
 * These two people are the same person on deterministic evidence. That is
 * not a review question; it is a fold. Used both to select auto-merge work
 * and to keep leftovers off the People page while the drain catches up.
 *
 * Fully parenthesised on purpose: it is interpolated after `AND NOT`, and
 * `NOT a AND NOT b` is not `NOT (a AND NOT b)`.
 */
function sharesDeterministicIdentity(tiers: DeterministicTiers): string {
  const clauses = [
    SHARES_EXACT_EMAIL,
    ...(tiers.phone ? [SHARES_EXACT_PHONE] : []),
    ...(tiers.profileUrl ? [SHARES_EXACT_PROFILE_URL] : []),
  ];

  return `((${clauses.map((clause) => `(${clause})`).join(' OR ')}) AND NOT ${PROFILE_URL_VETOED} AND NOT (${EMAIL_HELD}))`;
}

/** Every deterministic tier, the phone and the profile URL included. */
export const SHARES_DETERMINISTIC_IDENTITY = sharesDeterministicIdentity({ profileUrl: true, phone: true });

/** One endpoint as {@link chooseMergeTarget} reads it. */
export interface MergeTargetEndpoint {
  id: string;
  name: string | null;
  isSelf: boolean;
}

/**
 * Which of two people survives an unattended merge.
 *
 *  1. The self Person, always (two self endpoints never reach here).
 *  2. A real name over a placeholder: `PersonMergeService` keeps the
 *     TARGET's display name, so folding a vCard into its Google Voice stub
 *     would leave the contact named "+1 (202) 555-0142".
 *  3. The fuller name (`pickFullerName`: more name tokens, then the longer
 *     string), for the same reason.
 *  4. `entity_id_a` — the first argument — on a tie, so the choice is stable.
 */
export function chooseMergeTarget(a: MergeTargetEndpoint, b: MergeTargetEndpoint): string {
  if (a.isSelf) {
    return a.id;
  }

  if (b.isSelf) {
    return b.id;
  }

  const aPlaceholder = isPlaceholderPersonName(a.name);
  const bPlaceholder = isPlaceholderPersonName(b.name);

  if (aPlaceholder !== bPlaceholder) {
    return aPlaceholder ? b.id : a.id;
  }

  const fuller = pickFullerName([a.name, b.name]);

  return fuller != null && fuller === b.name && fuller !== a.name ? b.id : a.id;
}

/** One endpoint as the live re-check reads it. */
interface LiveEndpointRow {
  entity_id: string;
  person_name: string | null;
  profile_props: Record<string, unknown> | null;
  phone_props: Record<string, unknown> | null;
  is_self: boolean | null;
}

interface LiveEndpoint {
  id: string;
  name: string | null;
  profile: ProfileFacts;
  /** Raw phone fields. Read into `PhoneFacts` only once the phone corpus (and its region) is loaded. */
  phoneProps: Record<string, unknown> | null;
  /** `is_self`, or the row `users.entity_id` points at. */
  isSelf: boolean;
}

interface DeterministicRow {
  merge_candidate_id: string;
  entity_id_a: string;
  entity_id_b: string;
  score: number | string;
  evidence: unknown;
  via_email: boolean | null;
  via_phone: boolean | null;
}

/** One pending row as the review queue's phone re-check reads it. */
interface RecheckRow {
  merge_candidate_id: string;
  entity_id_a: string;
  entity_id_b: string;
  score: number | string;
  evidence: unknown;
}

/** The phone half of the drain's corpus state: loaded on first need, kept in step after every merge. */
interface PhoneCorpus {
  region: PhoneRegion | null;
  holders: PhoneHolders;
}

/** The values two people BOTH hold. Either side missing means nothing is shared. */
function sharedLines(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): Set<string> {
  if (left == null || right == null) {
    return new Set();
  }

  return new Set([...left].filter((line) => right.has(line)));
}

/**
 * The phone numbers two live people BOTH carry: each one's own record
 * (`carriedPhoneLines` — the fields the adjudicator reads, less what the
 * record itself refuses, a fax above all) plus the numbers each was observed
 * with (`observed`, from `loadObservedPhoneClaims`, self claims excluded).
 * Read with no region: this asks whether a number is on the record, not how
 * good an identifier it is, so it needs nothing corpus-wide.
 */
function carriedByBoth(
  a: LiveEndpoint,
  b: LiveEndpoint,
  observed: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const carried = (endpoint: LiveEndpoint): Set<string> => {
    const lines = carriedPhoneLines(
      extractPhoneFacts(endpoint.phoneProps, endpoint.name, endpoint.isSelf, null),
    );

    for (const line of observed.get(endpoint.id) ?? []) {
      lines.add(line);
    }

    return lines;
  };

  return sharedLines(carried(a), carried(b));
}

interface CandidateRow {
  merge_candidate_id: string;
  entity_type: string;
  entity_id_a: string;
  entity_id_b: string;
  score: number | string;
  status: string;
  detected_by: string;
  detector_version: number | string;
  created_at: Date | string;
  evidence: unknown;
}

/**
 * The reader for `ci.merge_candidates` — the review queue the duplicate
 * detector has been filling.
 *
 * `clean.duplicate_detect` scores pairs and files them here with the evidence
 * that justified each one, but until this service nothing ever SELECTed the
 * table: the pipeline's whole output was invisible to the user. This turns it
 * into a queue that can be paged, and {@link resolvePairs} closes the loop by
 * stamping the outcome of a merge or a rejection back onto the row.
 *
 * Distinct from {@link PersonDuplicateService}, which recomputes cruder exact
 * email/phone/name groups from `ci.entities.properties` on every call. Both
 * feed the same review UI; only this one carries a score and its evidence.
 */
@Injectable()
export class MergeCandidateService {
  constructor(
    @InjectRepository(PersonEntity)
    private readonly personRepository: Repository<PersonEntity>,
    private readonly logger: LoggerService,
    private readonly personMergeService: PersonMergeService,
  ) {
    this.logger.setContext(MergeCandidateService.name);
  }

  /**
   * Fold pending pairs that already share an identity, re-checking each one
   * against the LIVE rows immediately before it is merged.
   *
   * Three deterministic tiers qualify (see {@link SHARES_DETERMINISTIC_IDENTITY}):
   * a shared mailbox, an adjudicated exact phone, and an exact LinkedIn
   * profile URL. Name overlap, reviewed phones and last-ten-only phones stay
   * on the queue for a human, and no name clause exists in the predicate at
   * all.
   *
   * ── The live re-check ──────────────────────────────────────────────────────
   *
   * The stored evidence is as old as the detector's last sweep. Between that
   * sweep and this merge, earlier merges fold properties together and
   * re-imports rewrite them, so every pair is re-adjudicated with the same
   * `ProfileUrlHolders.adjudicate` and `PhoneHolders.adjudicate` the detector
   * used, on the endpoints as they are NOW. A pair that no longer qualifies
   * is DEMOTED — its row rewritten with the live verdicts' evidence — so it
   * becomes visible for review rather than hidden forever as "deterministic"
   * and never merged:
   *
   *  - disjoint or partial URL sets demote any pair, email pairs included;
   *  - a pair that is not an email pair merges only when a tier that is ON
   *    still says `exact` live: the profile URL, or the phone. Otherwise it
   *    demotes — a rename to another given name, a number that became
   *    over-common or gained a second real identity, a self endpoint;
   *  - a pair whose only tier is switched off (`includeProfileUrl` /
   *    `includePhone` false, the kill switch) is left exactly as it is.
   *
   * ── Corpus-wide counts, on the live corpus ─────────────────────────────────
   *
   * Both adjudicators read corpus counts — the profile-URL and phone holder
   * caps, the owner's own numbers, the phone line census, the foreign-stated
   * guard — so each keeps one holder index per call, read from the same
   * population the detector counts over (`PROFILE_FACTS_CORPUS_SQL`,
   * `PHONE_FACTS_CORPUS_SQL`). A number or URL can become over-common, or a
   * line gain a second identity, AFTER detection, and the stored 0.95 must not
   * carry a merge the detector would no longer grade `exact`.
   *
   * Each index is read at most once per call, and only when a row needs it:
   * the URL index when both endpoints state a URL, the phone index (and the
   * owner's region, derived from it) when a non-email row may merge on its
   * phone. Draining email pairs costs nothing extra. After each merge attempt
   * both endpoints are re-read into every loaded index, so a merged-away
   * source stops counting and the target counts what the merge folded into it.
   *
   * ── The self person ────────────────────────────────────────────────────────
   *
   * `users.entity_id` and any `is_self` row are always the merge TARGET, never
   * the source. A pair with two self endpoints is skipped and logged: folding
   * one "you" into another is a decision for the user, not a timer. A pair
   * whose only deterministic evidence is a phone is never folded into the
   * self Person at all — the phone adjudicator grades a self endpoint
   * `review` — so it demotes, labelled. `PersonMergeService` independently
   * refuses `users.entity_id` as a source.
   *
   * ── The survivor ───────────────────────────────────────────────────────────
   *
   * {@link chooseMergeTarget}: self, then a real name over a placeholder,
   * then the fuller name, then `entity_id_a`. The target keeps its display
   * name, and a Google Voice stub is usually the smaller uuid.
   *
   * ── Paging and budget ──────────────────────────────────────────────────────
   *
   * Keyset paging on the review order `(score DESC, merge_candidate_id ASC)`,
   * so a pair that is skipped (or whose merge throws) is passed over for the
   * rest of this run instead of being re-selected at the head of every page.
   * The drain stops on an empty page or when `budgetMs` is spent; leftovers
   * are picked up by the next run.
   */
  async autoMergeDeterministicPairs(
    context: UserServiceContext,
    options: AutoMergeOptions,
  ): Promise<AutoMergeResult> {
    const includeProfileUrl = options.includeProfileUrl ?? true;
    const includePhone = options.includePhone ?? true;
    const pageSize = Math.max(1, options.pageSize ?? AUTO_MERGE_PAGE_SIZE);
    const deadline = Date.now() + Math.max(0, options.budgetMs);
    const manager = this.personRepository.manager;
    const result: AutoMergeResult = { merged: 0, skipped: 0, demoted: 0, retired: 0, considered: 0 };
    const owner = await this.loadOwner(context);

    let cursor: { score: number; id: string } | null = null;
    /** Corpus-wide profile-URL holder counts. Loaded on first need; see "Corpus-wide counts". */
    let urlHolders: ProfileUrlHolders | null = null;
    /** Corpus-wide phone holders and the owner's region. Loaded on first need, likewise. */
    let phone: PhoneCorpus | null = null;

    const phoneFactsOf = (endpoint: LiveEndpoint, region: PhoneRegion | null): PhoneFacts =>
      extractPhoneFacts(endpoint.phoneProps, endpoint.name, endpoint.isSelf, region);

    /** Read `ids` live into `endpoints`, keeping every loaded index in step. */
    const refresh = async (endpoints: Map<string, LiveEndpoint>, ids: string[]): Promise<void> => {
      const fresh = await this.loadLiveEndpoints(context, ids, owner.selfEntityId);

      for (const id of ids) {
        const endpoint = fresh.get(id);

        if (endpoint == null) {
          endpoints.delete(id);
          urlHolders?.delete(id);
          phone?.holders.delete(id);
        } else {
          endpoints.set(id, endpoint);
          urlHolders?.set(id, endpoint.profile.urls);
          phone?.holders.set(id, phoneFactsOf(endpoint, phone.region));
        }
      }
    };

    drain: while (Date.now() < deadline) {
      const rows: DeterministicRow[] = await manager.query(
        `SELECT mc.merge_candidate_id, mc.entity_id_a, mc.entity_id_b, mc.score, mc.evidence,
                (${SHARES_EXACT_EMAIL}) AS via_email,
                (${SHARES_EXACT_PHONE}) AS via_phone
           FROM ci.merge_candidates mc
          WHERE mc.owner_user_id = $1
            AND mc.entity_type = 'Person'
            AND mc.status = 'pending'
            AND ${sharesDeterministicIdentity({ profileUrl: includeProfileUrl, phone: includePhone })}
            AND ${LIVE_PAIR_PREDICATE}
            AND ($2::float8 IS NULL
                 OR mc.score < $2::float8
                 OR (mc.score = $2::float8 AND mc.merge_candidate_id > $3::uuid))
          ORDER BY mc.score DESC, mc.merge_candidate_id ASC
          LIMIT $4`,
        [context.userId, cursor?.score ?? null, cursor?.id ?? null, pageSize],
      );

      if (rows.length === 0) {
        break;
      }

      const last = rows[rows.length - 1];
      cursor = { score: Number(last.score), id: last.merge_candidate_id };
      result.considered += rows.length;

      const endpoints = new Map<string, LiveEndpoint>();
      await refresh(
        endpoints,
        rows.flatMap((row) => [row.entity_id_a, row.entity_id_b]),
      );

      for (const row of rows) {
        if (Date.now() >= deadline) {
          break drain;
        }

        // Any merge earlier on this page may have folded properties into, or
        // tombstoned, one of this row's endpoints. Re-read what is stale.
        const stale = [row.entity_id_a, row.entity_id_b].filter((id) => !endpoints.has(id));
        if (stale.length > 0) {
          await refresh(endpoints, stale);
        }

        const a = endpoints.get(row.entity_id_a);
        const b = endpoints.get(row.entity_id_b);

        if (a == null || b == null) {
          // Merged away or deactivated since the page was read. The pair is
          // moot, and LIVE_PAIR_PREDICATE drops it from every later read.
          result.skipped += 1;
          continue;
        }

        let urlVerdict = ABSENT;

        if (a.profile.urls.size > 0 && b.profile.urls.size > 0) {
          urlHolders ??= await this.loadProfileUrlHolders(context);
          urlVerdict = urlHolders.adjudicate(a.profile, b.profile);
        }

        if (urlVerdict.kind === 'conflict' || urlVerdict.kind === 'partial') {
          result[await this.demote(context, row, null, urlVerdict)] += 1;
          continue;
        }

        if (row.via_email !== true) {
          const phoneTier = includePhone && row.via_phone === true;

          if (!phoneTier && !includeProfileUrl) {
            // Its only tier is switched off: leave the row exactly as it is.
            result.skipped += 1;
            continue;
          }

          const viaUrl = includeProfileUrl && urlVerdict.kind === 'exact';
          let phoneVerdict: PhoneVerdict | null = null;

          if (!viaUrl && phoneTier) {
            if (phone == null) {
              phone = await this.loadPhoneCorpus(context, owner);
            }

            phoneVerdict = phone.holders.adjudicate(
              phoneFactsOf(a, phone.region),
              phoneFactsOf(b, phone.region),
            );
          }

          if (!viaUrl && phoneVerdict?.kind !== 'exact') {
            result[await this.demote(context, row, phoneVerdict, urlVerdict, { a, b })] += 1;
            continue;
          }
        }

        if (row.via_email === true) {
          // The guards a shared mailbox needs, on the rows as they are now:
          // never fold a differently named person into the owner, nor two
          // contacts whose names share nothing.
          const hold = emailHoldReason(
            { name: a.name, isSelf: a.isSelf },
            { name: b.name, isSelf: b.isSelf },
          );

          if (hold != null) {
            result[await this.holdEmail(context, row, hold)] += 1;
            continue;
          }
        }

        if (a.isSelf && b.isSelf) {
          this.logger.warn('Deterministic auto-merge skipped a pair with two self endpoints', {
            entityIdA: row.entity_id_a,
            entityIdB: row.entity_id_b,
          });
          result.skipped += 1;
          continue;
        }

        const targetId = chooseMergeTarget(a, b);
        const sourceId = targetId === row.entity_id_a ? row.entity_id_b : row.entity_id_a;

        try {
          await this.personMergeService.mergePeople(context, [sourceId], targetId);
          await this.resolvePairs(context, [row.entity_id_a, row.entity_id_b], 'accepted');
          result.merged += 1;
        } catch (err: unknown) {
          // A lock timeout, a deadlock with the other drain (cron vs on-read
          // fold), or an endpoint merged away under us. Left pending; the
          // keyset moves past it and the next run retries.
          this.logger.warn('Deterministic auto-merge skipped a pair', {
            err,
            entityIdA: row.entity_id_a,
            entityIdB: row.entity_id_b,
          });
          result.skipped += 1;
        }

        // Both endpoints changed: the target's properties now hold the
        // source's, and the source is a tombstone. Force a re-read — now,
        // when an index is in use, so its counts see the merge.
        endpoints.delete(sourceId);
        endpoints.delete(targetId);

        if (urlHolders != null || phone != null) {
          await refresh(endpoints, [sourceId, targetId]);
        }
      }
    }

    if (result.merged > 0 || result.demoted > 0 || result.retired > 0) {
      this.logger.log('Auto-merged deterministic people', { ...result });
    }

    return result;
  }

  /**
   * Re-check the phone evidence of every pending pair on the review queue
   * against the LIVE records, and take out whatever no longer holds.
   *
   * ── Why the queue needs this ─────────────────────────────────────────────
   *
   * The detector writes a pair's evidence once per scoring generation, never
   * withdraws a pair, and is not re-run for a person whose record changes. The
   * drain above re-checks only the pairs it is about to fold. So a review-tier
   * phone pair ("Same phone number, but names differ") kept its evidence
   * forever, however the two records changed underneath it — a re-import
   * rewrites `properties` from that source's own card and drops what a merge
   * folded in, a user edits a contact, a number becomes over-common or turns
   * out to be the office fax. The card then asserted a shared number one of
   * the two people did not carry.
   *
   * ── What "still holds" means ─────────────────────────────────────────────
   *
   * The card's claim, checked as a fact: BOTH people still carry the number —
   * on their own record (the fields the phone adjudicator reads, minus a line
   * the record files as its fax), or as a number they were observed with
   * ({@link carriedByBoth}). NOT `ci.entity_identifiers`: it is unique per
   * (owner, kind, value), so two people can never both hold a number there,
   * and a check against it would call every genuinely shared number stale.
   *
   * Deliberately NOT a re-grade. Whether a number still carried by both is
   * still GOOD evidence — since become over-common, or the owner's — needs
   * the whole phone corpus, which costs a few hundred milliseconds to read at
   * a real corpus's size; that stays with the detector's next sweep and with
   * the drain, which reads the corpus anyway before it folds anything. This
   * pass reads three small, indexed statements per page.
   *
   * `revalidatePhoneEvidence` (utils/phoneIdentity.ts) does the arithmetic and
   * is subtractive — it removes numbers, never adds one or raises a score. A
   * row whose evidence all holds is left exactly as it was: no write, no
   * reorder under the reviewer. A row that lost some is rewritten; a row that
   * lost everything is retired ({@link rewriteOrRetire}). Human decisions are
   * never touched: every write is `WHERE status = 'pending'`.
   *
   * Keyset-paged on `merge_candidate_id` (a rewrite changes the score, so the
   * review order is not stable under this pass) and bounded by `budgetMs`, like
   * the drain.
   *
   * Never throws. It runs on the People page's read path, and a failed check
   * must leave the queue exactly as it was rather than fail the page; what it
   * managed before the failure is kept and counted.
   */
  async revalidatePhoneEvidence(
    context: UserServiceContext,
    options: PhoneRevalidationOptions,
  ): Promise<PhoneRevalidationResult> {
    const result: PhoneRevalidationResult = { considered: 0, rewritten: 0, retired: 0 };

    try {
      await this.recheckPhonePages(context, options, result);
    } catch (err: unknown) {
      this.logger.warn('Could not re-check phone evidence on the review queue; it is shown as stored', {
        err,
        ...result,
      });
    }

    if (result.rewritten > 0 || result.retired > 0) {
      this.logger.log('Re-checked phone evidence on the review queue', { ...result });
    }

    return result;
  }

  /** {@link revalidatePhoneEvidence}'s pages, counting into `result` as it goes. */
  private async recheckPhonePages(
    context: UserServiceContext,
    options: PhoneRevalidationOptions,
    result: PhoneRevalidationResult,
  ): Promise<void> {
    const pageSize = Math.max(1, options.pageSize ?? AUTO_MERGE_PAGE_SIZE);
    const deadline = Date.now() + Math.max(0, options.budgetMs);
    const manager = this.personRepository.manager;

    let cursor: string | null = null;

    while (Date.now() < deadline) {
      const rows: RecheckRow[] = await manager.query(
        `SELECT mc.merge_candidate_id, mc.entity_id_a, mc.entity_id_b, mc.score, mc.evidence
           FROM ci.merge_candidates mc
          WHERE mc.owner_user_id = $1
            AND mc.entity_type = 'Person'
            AND mc.status = 'pending'
            AND ${CARRIES_PHONE_EVIDENCE}
            AND ${LIVE_PAIR_PREDICATE}
            AND ($2::uuid IS NULL OR mc.merge_candidate_id > $2::uuid)
          ORDER BY mc.merge_candidate_id ASC
          LIMIT $3`,
        [context.userId, cursor, pageSize],
      );

      if (rows.length === 0) {
        break;
      }

      cursor = rows[rows.length - 1].merge_candidate_id;
      result.considered += rows.length;

      const ids = rows.flatMap((row) => [row.entity_id_a, row.entity_id_b]);
      const endpoints = await this.loadLiveEndpoints(context, ids, null);
      const observed = await this.loadObservedPhoneClaims(context, ids);

      for (const row of rows) {
        const a = endpoints.get(row.entity_id_a);
        const b = endpoints.get(row.entity_id_b);

        if (a == null || b == null) {
          // Merged away since the page was read; LIVE_PAIR_PREDICATE drops it.
          continue;
        }

        const checked = revalidatePhoneEvidence(
          { score: Number(row.score), evidence: parseEvidence(row.evidence) },
          { carried: carriedByBoth(a, b, observed) },
        );

        if (!checked.changed) {
          continue;
        }

        const outcome = await this.rewriteOrRetire(context, row.merge_candidate_id, checked);

        if (outcome !== 'failed') {
          result[outcome] += 1;
        }
      }
    }
  }

  /**
   * The phone values each of `entityIds` was OBSERVED with — claims written by
   * the linkers when a message or an event resolved to them — minus the
   * values the claim pass would refuse as over-common: held by more than
   * `PHONE_MAX_HOLDERS` people (the claim pass's `MAX_GROUP_MEMBERS`; the
   * detector's spec pins the two equal). Non-rejected claims only, as the
   * claim pass reads them.
   *
   * SELF claims (`subject_type = 'person' AND role = 'self'`) are left out of
   * each person's own set, and only there: they are a copy of the person's
   * record, which {@link carriedByBoth} reads live instead —
   * `enrich.person_self_claim` never retracts one, so a number a re-import
   * dropped from the record would otherwise keep "holding" through its own
   * stale copy. They still count as holders, as they do in the claim pass's cap.
   *
   * The holder count is taken over (value, entity) groups, not with
   * `count(DISTINCT entity_id)`: see `DuplicateDetectStage.loadEvidence` on
   * TimescaleDB's skip-scan planner and that aggregate.
   */
  private async loadObservedPhoneClaims(
    context: UserServiceContext,
    entityIds: string[],
  ): Promise<Map<string, Set<string>>> {
    const unique = [...new Set(entityIds)];
    const byEntity = new Map<string, Set<string>>();

    if (unique.length === 0) {
      return byEntity;
    }

    const rows: Array<{ entity_id: string; value_normalized: string; holders: number | string }> =
      await this.personRepository.manager.query(
        `WITH mine AS MATERIALIZED (
           SELECT c.entity_id, c.value_normalized
             FROM ci.identifier_claims c
            WHERE c.owner_user_id = $1
              AND c.entity_id = ANY($2::uuid[])
              AND c.kind = 'phone'
              AND c.disposition IS DISTINCT FROM 'rejected'
              AND NOT (c.subject_type = 'person' AND c.role = 'self')
            GROUP BY c.entity_id, c.value_normalized
         ),
         held AS MATERIALIZED (
           SELECT o.value_normalized, o.entity_id
             FROM (SELECT DISTINCT value_normalized FROM mine) v
             JOIN ci.identifier_claims o
               ON o.owner_user_id = $1
              AND o.kind = 'phone'
              AND o.value_normalized = v.value_normalized
            WHERE o.entity_id IS NOT NULL
              AND o.disposition IS DISTINCT FROM 'rejected'
            GROUP BY o.value_normalized, o.entity_id
         )
         SELECT m.entity_id, m.value_normalized, count(*)::int AS holders
           FROM mine m
           JOIN held h ON h.value_normalized = m.value_normalized
          GROUP BY m.entity_id, m.value_normalized`,
        [context.userId, unique],
      );

    for (const row of rows) {
      if (Number(row.holders) > PHONE_MAX_HOLDERS) {
        continue;
      }

      const lines = byEntity.get(row.entity_id) ?? new Set<string>();
      lines.add(row.value_normalized);
      byEntity.set(row.entity_id, lines);
    }

    return byEntity;
  }

  /**
   * Write a re-checked row back, or retire it. Only ever a PENDING row: a
   * human decision is never rewritten.
   *
   *  - anything left that weighs → rewritten with that score;
   *  - only a veto left (a profile conflict or partial, a phone country
   *    conflict) → kept at {@link DEMOTED_FLOOR_SCORE}, labelled, so the human
   *    can reject it and make the rejection sticky;
   *  - nothing left at all → DELETED. A pending row with no evidence renders
   *    as "Proposed as the same person" with no reason, which is a claim the
   *    records do not make. The detector re-proposes the pair if evidence
   *    returns on a later sweep; nothing a human decided is lost.
   *
   * Never throws: a failed write leaves the row as it was, to be re-checked
   * next time, and must not fail the People page that triggered the check.
   */
  private async rewriteOrRetire(
    context: UserServiceContext,
    mergeCandidateId: string,
    rewritten: { score: number; evidence: Array<{ kind: string; value: string; score: number | null }> },
  ): Promise<RecheckOutcome> {
    const manager = this.personRepository.manager;
    const weighs = rewritten.score > 0;
    const vetoed = rewritten.evidence.some((item) => VETO_EVIDENCE_KINDS.has(item.kind));

    try {
      if (!weighs && !vetoed) {
        await manager.query(
          `DELETE FROM ci.merge_candidates
            WHERE owner_user_id = $1
              AND merge_candidate_id = $2
              AND status = 'pending'`,
          [context.userId, mergeCandidateId],
        );

        return 'retired';
      }

      await manager.query(
        `UPDATE ci.merge_candidates
            SET score = $3, evidence = $4::jsonb, updated_at = now()
          WHERE owner_user_id = $1
            AND merge_candidate_id = $2
            AND status = 'pending'`,
        [
          context.userId,
          mergeCandidateId,
          weighs ? rewritten.score : DEMOTED_FLOOR_SCORE,
          JSON.stringify(rewritten.evidence),
        ],
      );

      return 'rewritten';
    } catch (err: unknown) {
      this.logger.warn('Could not write a re-checked merge candidate back; it stays as it was', {
        err,
        mergeCandidateId,
      });

      return 'failed';
    }
  }

  /** `users.entity_id` and the time zone: who "self" is, and what region the phone rule may infer. */
  private async loadOwner(
    context: UserServiceContext,
  ): Promise<{ selfEntityId: string | null; timezone: string | null }> {
    const [userRow]: Array<{ entity_id: string | null; timezone: string | null }> =
      await this.personRepository.manager.query(`SELECT entity_id, timezone FROM ci.users WHERE id = $1`, [
        context.userId,
      ]);

    return { selfEntityId: userRow?.entity_id ?? null, timezone: userRow?.timezone ?? null };
  }

  /**
   * Who states each profile URL across the owner's corpus: the counts the
   * holder cap reads. `PROFILE_FACTS_CORPUS_SQL` is the detector's own
   * population, so a URL is over-common to both callers or to neither.
   */
  private async loadProfileUrlHolders(context: UserServiceContext): Promise<ProfileUrlHolders> {
    const rows: ProfileFactsCorpusRow[] = await this.personRepository.manager.query(
      PROFILE_FACTS_CORPUS_SQL,
      [context.userId],
    );

    return new ProfileUrlHolders(
      rows.map((row) => [row.entity_id, extractProfileFacts(row.profile_props, row.person_name)] as const),
    );
  }

  /**
   * Who holds each phone number across the owner's corpus, and the owner's
   * region derived from it — the same statements, in the same order, as
   * `DuplicateDetectStage.loadPhoneCorpus`, so the holder cap, the owner's
   * lines, the line census and the foreign-stated guard mean the same thing
   * here as they did when the evidence was written.
   */
  private async loadPhoneCorpus(
    context: UserServiceContext,
    owner: { selfEntityId: string | null; timezone: string | null },
  ): Promise<PhoneCorpus> {
    const manager = this.personRepository.manager;
    const rows: PhoneFactsCorpusRow[] = await manager.query(PHONE_FACTS_CORPUS_SQL, [context.userId]);
    const { region, facts } = phoneCorpusFacts(rows, owner);
    const shared = sharedPhoneLines(facts);
    const claims: PhoneClaimE164Row[] =
      shared.length === 0 ? [] : await manager.query(PHONE_CLAIM_E164_SQL, [context.userId, shared]);

    return {
      region,
      holders: new PhoneHolders(
        facts,
        claims.map((row) => [row.l10, row.e164] as const),
      ),
    };
  }

  /**
   * Live profile facts, raw phone fields, names and self flags for `ids`, one
   * query. Only live Persons are returned, so an id missing from the map is a
   * pair that is moot.
   */
  private async loadLiveEndpoints(
    context: UserServiceContext,
    ids: string[],
    selfEntityId: string | null,
  ): Promise<Map<string, LiveEndpoint>> {
    const unique = [...new Set(ids)];

    if (unique.length === 0) {
      return new Map();
    }

    const rows: LiveEndpointRow[] = await this.personRepository.manager.query(
      `SELECT e.entity_id,
              e.name AS person_name,
              ${profileFactsSqlObject('e')} AS profile_props,
              ${phoneFactsSqlObject('e')} AS phone_props,
              (e.is_self IS TRUE OR e.properties->>'is_self' = 'true') AS is_self
         FROM ci.entities e
        WHERE e.owner_user_id = $1
          AND e.entity_id = ANY($2::uuid[])
          AND e.entity_type = 'Person'
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL`,
      [context.userId, unique],
    );

    return new Map(
      rows.map((row) => [
        row.entity_id,
        {
          id: row.entity_id,
          name: row.person_name,
          profile: extractProfileFacts(row.profile_props, row.person_name),
          phoneProps: row.phone_props,
          isSelf: row.is_self === true || row.entity_id === selfEntityId,
        },
      ]),
    );
  }

  /**
   * Hold a shared-mailbox pair for review instead of folding it: its email
   * item capped and an `email_check` marker added ({@link holdEmailEvidence}),
   * which {@link EMAIL_HELD} keeps out of every later fold. Never throws, like
   * {@link demote}.
   */
  private async holdEmail(
    context: UserServiceContext,
    row: DeterministicRow,
    reason: EmailCheckReason,
  ): Promise<'demoted' | 'skipped'> {
    const stored = { score: Number(row.score), evidence: parseEvidence(row.evidence) };
    const outcome = await this.rewriteOrRetire(
      context,
      row.merge_candidate_id,
      holdEmailEvidence(stored, reason),
    );

    if (outcome === 'failed') {
      return 'skipped';
    }

    this.logger.log('Held a shared-email pair for review instead of folding it', {
      mergeCandidateId: row.merge_candidate_id,
      reason,
    });

    return 'demoted';
  }

  /**
   * Rewrite a pending row's evidence under the LIVE verdicts, so a pair that
   * no longer qualifies becomes a visible review question instead of a
   * "deterministic" row that is hidden and never merged. The phone verdict,
   * when one was taken, is applied first and the profile verdict last, as the
   * detector applies them, so a profile veto's cap is the last word. A null
   * phone verdict leaves the stored phone items as they were. `status =
   * 'pending'` guards a concurrent human decision.
   *
   * An `absent` phone verdict — the two records no longer share any number —
   * is NOT handed to `applyPhoneVerdict`, which would keep the stored exact
   * item, capped to 0.85 and marked `unadjudicated`: a "Same phone number"
   * card for a number one side no longer carries. It goes through
   * `revalidatePhoneEvidence` instead, which keeps the item only while both
   * people still carry the number another way (an observed claim), held below
   * the auto-merge tier, as the review queue's own re-check does
   * ({@link revalidatePhoneEvidence}, {@link carriedByBoth}).
   *
   * Written back by {@link rewriteOrRetire}: a row left with nothing at all is
   * retired rather than floored with empty evidence.
   *
   * Never throws: a failed rewrite leaves the row as it was, to be re-checked
   * on the next run, and must not fail the People page that triggered the
   * on-read fold.
   */
  private async demote(
    context: UserServiceContext,
    row: DeterministicRow,
    phoneVerdict: PhoneVerdict | null,
    urlVerdict: ProfileVerdict,
    live: { a: LiveEndpoint; b: LiveEndpoint } | null = null,
  ): Promise<'demoted' | 'retired' | 'skipped'> {
    const stored = { score: Number(row.score), evidence: parseEvidence(row.evidence) };
    let phoneChecked: { score: number; evidence: MergeCandidateEvidence[] } = stored;

    if (phoneVerdict?.kind === 'absent' && live != null) {
      let observed: Map<string, Set<string>>;

      try {
        observed = await this.loadObservedPhoneClaims(context, [live.a.id, live.b.id]);
      } catch (err: unknown) {
        this.logger.warn(
          'Could not read claims to demote a deterministic merge candidate; it stays as it was',
          {
            err,
            mergeCandidateId: row.merge_candidate_id,
          },
        );

        return 'skipped';
      }

      phoneChecked = revalidatePhoneEvidence(stored, {
        carried: carriedByBoth(live.a, live.b, observed),
        capUnadjudicated: true,
      });
    } else if (phoneVerdict != null) {
      phoneChecked = applyPhoneVerdict(stored, phoneVerdict);
    }

    const outcome = await this.rewriteOrRetire(
      context,
      row.merge_candidate_id,
      applyProfileVerdict(phoneChecked, urlVerdict),
    );

    if (outcome === 'failed') {
      return 'skipped';
    }

    this.logger.log(
      outcome === 'retired'
        ? 'Retired a deterministic merge candidate whose live re-check left no evidence'
        : 'Demoted a deterministic merge candidate after a live re-check',
      {
        mergeCandidateId: row.merge_candidate_id,
        verdict:
          urlVerdict.kind === 'absent' && phoneVerdict != null
            ? `phone:${phoneVerdict.kind}`
            : urlVerdict.kind,
      },
    );

    return outcome === 'retired' ? 'retired' : 'demoted';
  }

  /**
   * One page of candidates for `entityType`, strongest score first.
   *
   * Rows whose people no longer exist as live entities are skipped rather than
   * returned half-hydrated: a pair merged (or tombstoned) elsewhere is not a
   * question the user can still answer. Pairs already recorded in
   * `ci.entity_merge_blocks` are excluded too — that table is the permanent
   * "never ask again", and it outlives any single detector generation.
   */
  async findCandidates(
    context: UserServiceContext,
    options: {
      status?: MergeCandidateStatus;
      entityType?: string;
      limit?: number;
      after?: string | null;
      /**
       * Whether the profile-URL tier is being folded. When the kill switch is
       * off, exact profile-URL pairs are NOT merged, so they are shown for
       * review instead of hidden. Default true.
       */
      includeProfileUrl?: boolean;
      /** The same, for the adjudicated exact phone tier. Default true. */
      includePhone?: boolean;
    } = {},
  ): Promise<MergeCandidatePage> {
    const status = options.status ?? 'pending';
    const entityType = options.entityType ?? 'Person';
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = options.after ? decodeMergeCandidateCursor(options.after) : null;
    // Deterministic pairs are folded (on read, and by the hourly drain); any
    // not yet folded must not appear as "are these the same person?" on the
    // review queue. A VETOED pair is not deterministic, so it stays visible.
    const hideDeterministic =
      status === 'pending'
        ? `AND NOT ${sharesDeterministicIdentity({
            profileUrl: options.includeProfileUrl ?? true,
            phone: options.includePhone ?? true,
          })}`
        : '';

    // One extra row answers hasNextPage without a second round-trip.
    const rows: CandidateRow[] = await this.personRepository.manager.query(
      `SELECT mc.merge_candidate_id, mc.entity_type, mc.entity_id_a, mc.entity_id_b,
              mc.score, mc.status, mc.detected_by, mc.detector_version, mc.created_at, mc.evidence
         FROM ci.merge_candidates mc
        WHERE mc.owner_user_id = $1
          AND mc.entity_type = $2
          AND mc.status = $3
          AND ($4::float8 IS NULL
               OR mc.score < $4::float8
               OR (mc.score = $4::float8 AND mc.merge_candidate_id > $5::uuid))
          AND ${LIVE_PAIR_PREDICATE}
          ${hideDeterministic}
        ORDER BY mc.score DESC, mc.merge_candidate_id ASC
        LIMIT $6`,
      [context.userId, entityType, status, cursor?.score ?? null, cursor?.id ?? null, limit + 1],
    );

    const [countRow]: Array<{ total: number | string }> = await this.personRepository.manager.query(
      `SELECT COUNT(*)::int AS total
         FROM ci.merge_candidates mc
        WHERE mc.owner_user_id = $1
          AND mc.entity_type = $2
          AND mc.status = $3
          AND ${LIVE_PAIR_PREDICATE}
          ${hideDeterministic}`,
      [context.userId, entityType, status],
    );

    const totalCount = Number(countRow?.total ?? 0);
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;

    if (page.length === 0) {
      return { candidates: [], totalCount, hasNextPage: false, endCursor: null };
    }

    const byId = await this.loadPeople(context, page);

    const candidates: MergeCandidate[] = [];
    for (const row of page) {
      const personA = byId.get(row.entity_id_a);
      const personB = byId.get(row.entity_id_b);

      // The SQL already required both endpoints to be live Persons; a miss here
      // means the repository read disagreed, so drop the pair rather than
      // render half of it.
      if (personA == null || personB == null) {
        continue;
      }

      candidates.push({
        id: row.merge_candidate_id,
        entityType: row.entity_type,
        score: Number(row.score),
        status: row.status as MergeCandidateStatus,
        detectedBy: row.detected_by,
        detectorVersion: Number(row.detector_version),
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        evidence: parseEvidence(row.evidence),
        people: [personA, personB],
      });
    }

    const last = page[page.length - 1];

    return {
      candidates,
      totalCount,
      hasNextPage,
      endCursor: encodeMergeCandidateCursor({ score: Number(last.score), id: last.merge_candidate_id }),
    };
  }

  /**
   * Stamp the outcome of a user decision onto every pending candidate whose
   * BOTH endpoints are in `entityIds`.
   *
   * The set, not a pair, is the unit of the decision: the review UI merges (or
   * rejects) a whole group, so one click can settle several proposals at once.
   * Only `pending` rows move — a candidate the user already decided keeps the
   * first answer, matching the detector's own upsert rule.
   */
  async resolvePairs(
    context: UserServiceContext,
    entityIds: string[],
    status: Exclude<MergeCandidateStatus, 'pending'>,
  ): Promise<number> {
    const unique = [...new Set(entityIds)];

    if (unique.length < 2) {
      return 0;
    }

    // Counted through a CTE: a bare UPDATE … RETURNING resolves to
    // [rows, rowCount], whose length is 2 whatever it touched (countAffected).
    const resolved = await countAffected(
      this.personRepository.manager,
      `WITH resolved AS (
         UPDATE ci.merge_candidates
            SET status = $3, updated_at = now()
          WHERE owner_user_id = $1
            AND status = 'pending'
            AND entity_id_a = ANY($2::uuid[])
            AND entity_id_b = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM resolved`,
      [context.userId, unique, status],
    );

    if (resolved > 0) {
      this.logger.log('Resolved merge candidates', { status, entities: unique.length, rows: resolved });
    }

    return resolved;
  }

  private async loadPeople(context: UserServiceContext, rows: CandidateRow[]): Promise<Map<string, Person>> {
    const ids = [...new Set(rows.flatMap((row) => [row.entity_id_a, row.entity_id_b]))];

    const entities = await this.personRepository
      .createQueryBuilder('person')
      .where('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere('person.entity_id IN (:...ids)', { ids })
      .getMany();

    return new Map(entities.map((entity) => [entity.id, PersonEntity.toEgressType(entity)]));
  }
}
