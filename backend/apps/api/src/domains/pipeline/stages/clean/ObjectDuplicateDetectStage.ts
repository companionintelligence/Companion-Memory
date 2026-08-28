import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The memory domain's PUBLIC barrel — `no-cross-domain-internals` allows
// `index.ts` and nothing else. The same route `PlacePromoteStage` and
// `ObservationPromoteStage` already take into this domain.
import {
  ObjectDuplicateService,
  type ObjectDuplicateGroup,
  type ObjectDuplicateReason,
} from '@ci/domains/memory';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

import type { CandidateEvidence, MergeCandidate } from './DuplicateDetectStage';

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
export const CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID = 'clean.object_duplicate_detect';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'object';

/**
 * `ci.merge_candidates.entity_type` for the pairs this stage proposes.
 *
 * `'Item'`, NOT `'Object'`, and the difference is load-bearing rather than
 * cosmetic. `ci.merge_candidates.entity_type` is bare `TEXT` with no CHECK, so
 * the database accepts either — but every reader of the table joins it back to
 * `ci.entities.entity_type`:
 *
 *  - `MergeCandidateService`'s `LIVE_PAIR_PREDICATE` requires
 *    `a.entity_type = mc.entity_type` on BOTH endpoints, so a row filed under a
 *    type no entity carries is filtered out of the review queue forever;
 *  - `ObjectMergeService` — the executor these proposals exist for — resolves
 *    its endpoints with `... AND entity_type = 'Item'`.
 *
 * An owned unit's base row is `entity_type = 'Item'` (`ObjectPromoteStage`
 * inserts the literal; `ci.objects.entity_type` defaults to it). Filing under
 * `'Object'` would produce exactly the dead row the Place exclusion below warns
 * about: written nightly, readable by nobody, executable by nobody.
 */
const CANDIDATE_ENTITY_TYPE = 'Item';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of the SCORING rule — {@link OBJECT_REASON_SCORES},
 * {@link MIN_OBJECT_CANDIDATE_SCORE}, and how a pair's evidence is combined.
 *
 * Bump it in the same commit that edits any of them. A bump rescores every
 * PENDING candidate and leaves behind every pair whose evidence no longer
 * clears the floor; it does NOT resurrect a pair a human rejected.
 */
export const OBJECT_DUPLICATE_SCORING_GENERATION = 1;

/**
 * Generation of the CANDIDATE SET — which units are compared at all.
 *
 * That is the applicability predicate in
 * {@link OBJECT_DUPLICATE_DETECT_SOURCE} AND the `keys` CTE inside
 * `ObjectDuplicateService.findDuplicateGroups`, because the grouping rules live
 * there and this stage deliberately does not own a second copy of them. Bump
 * this when that query learns a new rung, changes `MIN_IDENTIFIER_LENGTH`, or
 * stops grouping on something it groups on today — the detector improving is
 * exactly the case a re-sweep exists for, and the review UI's read path gives
 * that query no version of its own.
 */
export const OBJECT_DUPLICATE_CANDIDATE_GENERATION = 1;

/**
 * The stage version, derived so that improving EITHER re-runs history.
 *
 * A SUM offset so both-at-1 gives 1, for the reason spelled out on
 * `DUPLICATE_DETECT_VERSION`: monotone in each term, so the version can only go
 * up.
 */
export const OBJECT_DUPLICATE_DETECT_VERSION =
  OBJECT_DUPLICATE_SCORING_GENERATION + OBJECT_DUPLICATE_CANDIDATE_GENERATION - 1;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * A missing entry is not an error (this file precedes the central declaration);
 * a disagreeing one is, and it throws here where the fix is one line.
 */
export function objectDuplicateDetectStageVersion(
  versions: Record<string, StageVersion> = STAGE_VERSIONS,
): number {
  const declared = versions[CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID];

  if (typeof declared === 'number' && declared !== OBJECT_DUPLICATE_DETECT_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID}"] declares ${declared} but the ` +
        `stage derives ${OBJECT_DUPLICATE_DETECT_VERSION} from ` +
        `OBJECT_DUPLICATE_SCORING_GENERATION (${OBJECT_DUPLICATE_SCORING_GENERATION}) + ` +
        `OBJECT_DUPLICATE_CANDIDATE_GENERATION (${OBJECT_DUPLICATE_CANDIDATE_GENERATION}) - 1. ` +
        `Bumping a generation is only half the change: update versions.ts in the same commit.`,
    );
  }

  return OBJECT_DUPLICATE_DETECT_VERSION;
}

// Module load, not first sweep: the earliest failure is the cheapest one.
objectDuplicateDetectStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * The sweep pages over UNITS, not over pairs — the same shape argument as
 * `DUPLICATE_DETECT_SOURCE`: `ci.pipeline_state` is keyed
 * `(entity_type, entity_id, stage)` and a pair has no id, and "every unit has
 * been examined at rule version N" is answerable where "every pair has" is not.
 *
 * The predicate is the liveness half of `ObjectDuplicateService`'s own `units`
 * CTE, stated here in the sweep's terms so the two agree about what a unit is.
 * `merged_into_object_id IS NULL` looks like the ratchet and is not: a
 * tombstoned unit is a redirect `ObjectMergeService` left behind, this stage
 * NEVER writes that column (or any other on `ci.objects`), and so no row can
 * leave the candidate set because this stage succeeded.
 *
 * The predicate must never mention `ci.merge_candidates`. That table IS this
 * stage's output, and anti-joining it is the completion ratchet the ledger
 * exists to prevent: a unit would leave the candidate set the moment one pair
 * was proposed for it, and a rescoring bump could never reach it again.
 */
export const OBJECT_DUPLICATE_DETECT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'objects',
  idColumn: 'object_id',
  userColumn: 'user_id',
  predicate:
    `s.merged_into_object_id IS NULL ` +
    `AND EXISTS (SELECT 1 FROM ci.entities e ` +
    `WHERE e.entity_id = s.object_id ` +
    `AND e.owner_user_id = s.user_id ` +
    `AND e.is_active IS DISTINCT FROM FALSE ` +
    `AND e.merged_into_entity_id IS NULL)`,
};

// ---------------------------------------------------------------------------
// The scoring rule
// ---------------------------------------------------------------------------

/**
 * Evidence strength per grouping reason.
 *
 * `ObjectDuplicateService` ranks its three reasons but scores none of them — it
 * feeds a UI that shows a human the group and its members. `ci.merge_candidates`
 * needs a number in `(0, 1]`, so the calibration is here, and it is
 * deliberately LOWER across the board than the person scores next door. A
 * shared mailbox is evidence that two Person rows are one person; a shared
 * barcode is not evidence that two unit rows are one unit, because **owning two
 * of the same thing is ordinary**. `ObjectDuplicateService`'s own docblock says
 * so ("you own two of the same mug"), and no column in this database
 * distinguishes the two cases.
 *
 *  - **identifier 0.8** — the strongest signal available, and still not near
 *    the person tier, because the rung cannot tell a UNIT-unique code (serial,
 *    IMEI) from a PRODUCT-unique one (UPC, EAN, ASIN): both live in the same
 *    `identifier_codes` bag and both survive `MIN_IDENTIFIER_LENGTH`. Two
 *    genuinely separate purchases of one book share an ASIN. Splitting this
 *    number by namespace is the obvious improvement and it needs the namespace
 *    carried out of that query first.
 *  - **product_name 0.6** — same catalogue product AND the same display name.
 *    Two rows for the same product called exactly the same thing are more often
 *    one import seen twice than two shelves.
 *  - **brand_model 0.55** — same brand and model acquired on the same DAY. The
 *    date is what makes it a duplicate signal at all; without it this is a
 *    "you own two" signal and nothing else.
 *
 * All three sit above {@link MIN_OBJECT_CANDIDATE_SCORE} and far below anything
 * that could be read as an auto-merge floor. There is no auto-merge floor: this
 * stage has no merge path to gate.
 */
export const OBJECT_REASON_SCORES: Readonly<Record<ObjectDuplicateReason, number>> = {
  identifier: 0.8,
  product_name: 0.6,
  brand_model: 0.55,
};

/**
 * Minimum score worth writing a row for.
 *
 * Equal to the weakest reason the detector can produce, so every group it
 * surfaces to the review UI is also proposable here. A floor that silently
 * dropped one of the three rungs would make the nightly ledger and the
 * on-demand UI disagree about the same corpus, which is worse than either
 * answer alone.
 */
export const MIN_OBJECT_CANDIDATE_SCORE = 0.55;

/**
 * Pairs to propose from one slice's groups, deduplicated and scored.
 *
 * ── Why a group becomes pairs ─────────────────────────────────────────────
 *
 * `ci.merge_candidates` stores an ORDERED PAIR under a unique index and a
 * `CHECK (entity_id_a < entity_id_b)`; it has no representation for a group.
 * A group of n members is therefore n(n-1)/2 rows, bounded at 15 by the
 * detector's own `MAX_GROUP_SIZE = 6`.
 *
 * ── Why the pairs must be deduplicated before they reach SQL ──────────────
 *
 * One pair routinely appears in two groups: units sharing a barcode usually
 * share brand+model too. The detector only suppresses a weaker group whose
 * member set is IDENTICAL to a stronger one, so overlapping-but-different
 * groups both survive — and two rows for the same pair in one
 * `INSERT ... ON CONFLICT DO UPDATE` is not a duplicate row, it is the error
 * `ON CONFLICT DO UPDATE command cannot affect row a second time`, which would
 * fail the whole slice.
 *
 * ── Why the score is a MAX and never a sum ────────────────────────────────
 *
 * Same rule as `scorePair` one file over. Two reasons agreeing is one fact
 * observed twice, not stronger evidence, and summing would push any pair with
 * enough corroborating detail past any floor. Every reason is kept in
 * `evidence`, strongest first, because the evidence is what a reviewer reads.
 */
export function buildObjectCandidates(groups: readonly ObjectDuplicateGroup[]): MergeCandidate[] {
  const byPair = new Map<string, MergeCandidate>();

  for (const group of groups) {
    const score = OBJECT_REASON_SCORES[group.reason];

    if (score == null || score < MIN_OBJECT_CANDIDATE_SCORE) {
      // A reason nobody has calibrated. Ignored rather than defaulted:
      // inventing a weight is the fabricated confidence `types.ts` forbids.
      continue;
    }

    const ids = [...new Set(group.items.map((item) => item.id))].sort();

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [entityIdA, entityIdB] = [ids[i], ids[j]];
        const key = `${entityIdA}|${entityIdB}`;
        const evidence: CandidateEvidence = { kind: group.reason, value: group.value, score };
        const existing = byPair.get(key);

        if (existing == null) {
          byPair.set(key, { entityIdA, entityIdB, score, evidence: [evidence] });

          continue;
        }

        if (existing.evidence.some((item) => item.kind === evidence.kind && item.value === evidence.value)) {
          continue;
        }

        existing.evidence.push(evidence);
        existing.evidence.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
        existing.score = existing.evidence[0].score;
      }
    }
  }

  return [...byPair.values()];
}

/**
 * Pages of groups one slice may read before it stops asking.
 *
 * A slice is `DEFAULT_SLICE_SIZE` = 200 units and each page is
 * `ObjectDuplicateService`'s `MAX_LIMIT` = 100 groups, so this is a ceiling of
 * 2,000 groups for 200 units — an order of magnitude above the worst shape a
 * real slice produces (one group per identifier code, plus two). It exists so a
 * corpus with pathological grouping cannot turn one slice into an unbounded
 * read loop; when it bites, the slice is still recorded honestly, carrying
 * `truncated` in its detail.
 */
const MAX_GROUP_PAGES = 20;

/** One page's worth of groups. `MAX_LIMIT` inside the detector. */
const GROUP_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Proposes duplicate owned units. NEVER MERGES THEM.
 *
 * ── What this stage adds ───────────────────────────────────────────────────
 *
 * The scored object detector already existed and was thrown away on every call:
 * `ObjectDuplicateService.findDuplicateGroups` is reachable only from the
 * `itemDuplicates` GraphQL query, which recomputes the whole corpus's groups
 * per request and writes nothing. So nothing ever accumulated, nothing could be
 * reviewed between sessions, and "have these units been examined?" had no
 * answer. This stage puts that computation on the ledger and files its output
 * where the person detector already files its own — one review queue, two
 * detectors, one `detected_by` column saying which produced each row.
 *
 * It reuses that service rather than re-deriving the grouping. The scoring
 * (which is genuinely new — the service ranks reasons but produces no number)
 * lives here in {@link OBJECT_REASON_SCORES}, and the two are versioned
 * separately for exactly that reason.
 *
 * ── CLEAN proposes; it never merges ────────────────────────────────────────
 *
 * There is no merge path in this file, no call to `ObjectMergeService`, no
 * write to any `ci.objects` or `ci.entities` column, and no configuration that
 * would create one. The asymmetry that makes that the only defensible design is
 * the same one the person detector documents, and it is if anything sharper
 * here: `ObjectMergeService.mergeObjects` repoints identifiers, observations,
 * receipt line items and relationships, stamps `merged_into_object_id`, and
 * DELETES the sources' search rows. A wrong proposal costs one click; a wrong
 * merge costs the distinction between the two you own, permanently — and "you
 * own two of the same thing" is a completely ordinary state of the world that
 * no evidence in this database can rule out.
 *
 * ── Why NOT `Place` ────────────────────────────────────────────────────────
 *
 * Because there is no `PlaceMergeService`. A Place proposal would be a row
 * nothing can act on, filed nightly, forever.
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 *  - `done` — the unit was examined; `detail.candidates` says how many pairs it
 *    appears in, INCLUDING ZERO. Zero is a real answer ("examined, no
 *    duplicate") and it is what makes coverage mean anything.
 *  - `skipped: source_row_missing` — deleted, tombstoned by a merge, or
 *    re-owned between the sweep and the slice.
 *  - `failed: candidate_write_failed` — the pairs were computed, the upsert did
 *    not commit. Retryable.
 */
@Injectable()
export class ObjectDuplicateDetectStage implements Stage {
  readonly id = CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID;

  /** Resolved once at construction; see `GeocodeStage` on why not a getter. */
  readonly version = objectDuplicateDetectStageVersion();

  /**
   * `pipeline-index`: Postgres statements and no external call, exactly as the
   * person detector. Two workers proposing the same pair concurrently is
   * absorbed by the unique index and the upsert, so no singleton queue is
   * needed and none is asked for.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = OBJECT_DUPLICATE_DETECT_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly duplicates: ObjectDuplicateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectDuplicateDetectStage.name);
  }

  /**
   * Examine one slice of units.
   *
   * Idempotent: the same slice produces the same pairs, and the upsert is keyed
   * on the ordered pair, so a duplicate dispatch costs one redundant statement
   * and changes nothing. A pair discovered from both ends — the common case,
   * since both units are usually in the same corpus — is one row, because
   * {@link buildObjectCandidates} orders the pair before it reaches SQL.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const live = await this.loadLiveUnits(ctx.userId, ids);

    for (const id of ids) {
      if (!live.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const examined = ids.filter((id) => live.has(id));

    if (examined.length === 0) {
      return results;
    }

    const { groups, truncated } = await this.loadGroups(ctx, examined);
    const candidates = buildObjectCandidates(groups);

    /** How many surviving pairs each swept unit appears in. */
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

        // One statement, one verdict. Every unit that contributed a pair shares
        // it; the rest are answered normally below.
        for (const candidate of candidates) {
          for (const id of [candidate.entityIdA, candidate.entityIdB]) {
            if (live.has(id)) {
              results.set(id, {
                outcome: 'failed',
                reason: 'candidate_write_failed',
                detail: { message },
              });
            }
          }
        }

        this.logger.error(
          `Object merge candidate write failed for ${candidates.length} pairs`,
          err instanceof Error ? err : new Error(message),
        );
      }
    }

    for (const id of examined) {
      if (results.has(id)) {
        continue;
      }

      results.set(id, {
        outcome: 'done',
        detail: { candidates: proposedFor.get(id) ?? 0, truncated },
      });
    }

    return results;
  }

  /**
   * Which of the slice's ids are still live units owned by this user.
   *
   * Re-applies the applicability predicate at slice time, deliberately: a slice
   * can arrive from a dead letter replayed weeks later, by which time a unit may
   * have been merged away, and proposing a merge for a tombstone would put a
   * pair in the review queue that cannot be acted on.
   *
   * User-scoped for the reason every stage is: re-scoping is the difference
   * between "this id is not yours" and reading someone else's possessions.
   */
  private async loadLiveUnits(userId: string, ids: string[]): Promise<Set<string>> {
    const rows = await this.dataSource.query<Array<{ object_id: string }>>(
      `SELECT o.object_id
         FROM ci.objects o
         JOIN ci.entities e
           ON e.entity_id = o.object_id
          AND e.owner_user_id = $2::uuid
          AND e.is_active IS DISTINCT FROM FALSE
          AND e.merged_into_entity_id IS NULL
        WHERE o.object_id = ANY($1::uuid[])
          AND o.user_id = $2::uuid
          AND o.merged_into_object_id IS NULL`,
      [ids, userId],
    );

    return new Set(rows.map((row) => row.object_id));
  }

  /**
   * Every duplicate group this slice's units belong to, corpus-wide.
   *
   * Paged rather than taken in one read because the detector caps a page at 100
   * groups; the loop stops at {@link MAX_GROUP_PAGES}, and says so, rather than
   * reading until a pathological corpus runs it out of memory.
   *
   * `ci.entity_merge_blocks` filtering happens INSIDE the detector
   * (`dropBlocked`), so a pair the user has permanently refused never reaches
   * the scoring here and never costs a row. That is deliberately not
   * re-implemented: one definition of "the user said no", shared by the nightly
   * ledger and the review UI.
   */
  private async loadGroups(
    ctx: UserServiceContext,
    objectIds: string[],
  ): Promise<{ groups: ObjectDuplicateGroup[]; truncated: boolean }> {
    const groups: ObjectDuplicateGroup[] = [];

    for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
      const result = await this.duplicates.findDuplicateGroups(ctx, {
        objectIds,
        limit: GROUP_PAGE_SIZE,
        offset: page * GROUP_PAGE_SIZE,
      });

      groups.push(...result.groups);

      if (!result.hasMore) {
        return { groups, truncated: false };
      }
    }

    this.logger.warn(
      `Object duplicate groups truncated at ${MAX_GROUP_PAGES * GROUP_PAGE_SIZE} for a slice of ` +
        `${objectIds.length} units; the remainder is left for the next sweep`,
    );

    return { groups, truncated: true };
  }

  /**
   * Upsert the slice's pairs into `ci.merge_candidates`, in one statement.
   *
   * `WHERE status = 'pending'` is the human's veto, and it is the same clause
   * the person detector uses for the same reasons: a pair the user REJECTED
   * stays rejected rather than being asked again on every sweep, and a pair the
   * user ACCEPTED keeps its acceptance so a concurrent sweep cannot walk it
   * back to pending between the click and the merge. A permanent "never ask
   * again" is `ci.entity_merge_blocks`, which the detector already honours.
   *
   * Nothing is withdrawn. A bump that no longer finds a pair leaves the old
   * PENDING row in place — `detector_version` identifies it, and reaping stale
   * proposals is a deliberate act, not a side effect of this stage running.
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
