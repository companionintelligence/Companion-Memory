import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import type { MergeCounts } from '@ci/domains/memory';

import { CLAIM_LEASE_SECONDS, STAGE_IDS } from '../constants';

import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/**
 * Ceiling on subjects re-opened per user per tick. An UPDATE over this many
 * ledger rows is a few milliseconds; the sweep that follows is paced by the
 * dispatcher like any other, so the number only bounds the tick's own work.
 */
export const IDENTIFIER_ARRIVAL_BATCH = 20_000;

/** Which ledger stage owns each claim subject type. */
const STAGE_FOR_SUBJECT: Readonly<Record<string, string>> = {
  communication: STAGE_IDS.ENRICH_PERSON_LINK,
  event: STAGE_IDS.ENRICH_EVENT_PERSON_LINK,
};

/**
 * `ci.entity_merges.entity_type` of a Person merge — the one kind that moves
 * identifier claims. NOT a ledger `entity_type`: each stage records under the
 * type it declares, and `clean.duplicate_detect` declares `'entity'`.
 */
const MERGED_ENTITY_TYPE = 'Person';

/**
 * The `details.counts` key every merge that carried its evidence writes (0
 * included): claims re-pointed onto the survivor, and the sources' merge
 * blocks carried to it. A merge recorded before `PersonMergeService` did
 * either is NOT a signal. It moved no claims, so re-examining its survivor
 * finds nothing the merge added; and it carried no blocks, so a survivor whose
 * claims are later re-derived from its folded card could be proposed — and,
 * on a shared address, folded — against someone a human ruled out for the
 * source. Typed against {@link MergeCounts} so a rename fails the build rather
 * than silently ending every re-open.
 */
const EVIDENCE_CARRIED_COUNT: keyof MergeCounts = 'blocksCarried';

/**
 * The stages whose decisions about a Person a merge INTO it makes provisional.
 *
 *  - `enrich.person_self_claim` read the survivor's `properties`, which the
 *    merge has since folded the sources' emails, phones and names into.
 *  - `clean.duplicate_detect` read the survivor's claims, which the merge has
 *    since joined by every claim that resolved to a source.
 *
 * Both at once is safe: `STAGE_DEPENDENCIES` makes the self-claim leg a
 * PRODUCER of the detector, so the detector leg waits for the survivor's
 * claims to be re-derived before it re-examines the survivor.
 *
 * Ids only. Everything else is read off the registered stage, never copied:
 * the ledger `entity_type` each records under (`'Person'` for the self-claim
 * stage, `'entity'` for the detector — the slice listener refuses any other,
 * so a row under a guessed type is a row that does not exist), and the source
 * a survivor must still satisfy. The source keeps a re-open honest: the
 * ledger's `coverage()` counts a re-opened row as stale until it is re-decided,
 * and a row the stage's predicate excludes is never swept, so re-opening one
 * would read as unfinished work forever.
 */
const MERGE_SURVIVOR_STAGES: readonly string[] = [
  STAGE_IDS.ENRICH_PERSON_SELF_CLAIM,
  STAGE_IDS.CLEAN_DUPLICATE_DETECT,
];

interface StaleSubjectRow {
  subject_type: string;
  subject_id: string;
}

/**
 * New evidence re-opens old decisions.
 *
 * The person-link stages resolve a participant only through
 * `ci.entity_identifiers`. A message swept before the person it names had an
 * identifier there is recorded as decided — `skipped: no_identifier_resolved`,
 * or `done` with a partial list — and the unresolved observation sits in
 * `ci.identifier_claims` with `entity_id IS NULL`. THE ONE RULE never revisits
 * a decided row: only a version bump does, and a bump re-opens the whole
 * corpus for what is a handful of rows' worth of news.
 *
 * On a real import that was every Messenger message the owner had: the
 * import's messages were swept at 18:57, the people they named were created
 * (and their names indexed) at 19:05, and 1,339,935 claims on 161,916 messages
 * stayed unresolved forever — every inbound group message reduced to the one
 * recipient the index knew at the time, the owner.
 *
 * This service asks the small table the question, once per user per tick:
 * which identifiers were registered AFTER a still-unresolved claim on the same
 * `(kind, value)` was last adjudicated? Their subjects are re-opened on the
 * ledger (`stage_version` back to 0), and the next sweep of the stage
 * re-adjudicates them against the index as it now stands. The claim upsert
 * stamps `observed_at = now()` on every re-run, so a subject whose claim still
 * resolves to nobody afterwards is not re-opened again by the same identifier.
 *
 * Driven from `ci.entity_identifiers` rather than from the claims: the
 * identifiers a user has number in the thousands, the unresolved claims can
 * number in the millions, and the join lands on
 * `identifier_claims_unresolved_idx` for each identifier rather than the
 * reverse.
 *
 * ── A merge is new evidence too ────────────────────────────────────────────
 *
 * `PersonMergeService` moves every claim that resolved to a merged-away source
 * onto the survivor, in the merge's own transaction. The survivor's
 * duplicate-detection decision was made on less evidence than it now holds,
 * so a third copy sharing only the source's address or number is never
 * proposed against it: the pair the detector did propose, with the source, is
 * moot once the source is a tombstone. The merge cannot re-open that decision
 * itself — `PipelineStateService` is the only writer of `ci.pipeline_state`,
 * and the memory domain does not depend on this one. So the merge's audit row
 * is the signal: `ci.entity_merges` commits with the claims it describes, and
 * this service re-opens the survivor's decisions that predate it. Only a merge
 * that carried its evidence counts ({@link EVIDENCE_CARRIED_COUNT}); one
 * recorded before merges did is left to the next version bump, as it was.
 *
 * "Predate" is `ci.pipeline_state.updated_at` before the merge's `created_at`
 * plus {@link CLAIM_LEASE_SECONDS}. The margin covers a slice that read the
 * survivor before the merge committed and recorded its answer after the merge
 * began (`created_at` is `now()`, the merge transaction's START), and a slice
 * may run that long before the ledger considers it dead. Its cost is one more
 * run for a survivor decided within the margin: that run lands long after the
 * merge, so it is not found again.
 */
@Injectable()
export class IdentifierArrivalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stateService: PipelineStateService,
    private readonly stageRegistry: StageRegistry,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IdentifierArrivalService.name);
  }

  /**
   * Re-open every subject (bounded by `limit`) that carries an unresolved
   * claim an identifier registered since could now answer, and every Person
   * decision (bounded by `limit` per stage) that predates a merge into that
   * Person. Returns how many ledger rows were re-opened.
   */
  async reopenForUser(userId: string, limit = IDENTIFIER_ARRIVAL_BATCH): Promise<number> {
    const reopened = await this.reopenForRegisteredIdentifiers(userId, limit);

    return reopened + (await this.reopenForMergeSurvivors(userId, limit));
  }

  private async reopenForRegisteredIdentifiers(userId: string, limit: number): Promise<number> {
    const rows = await this.dataSource.query<StaleSubjectRow[]>(
      `SELECT DISTINCT ic.subject_type, ic.subject_id
         FROM ci.entity_identifiers ei
         JOIN ci.identifier_claims ic
           ON ic.owner_user_id = ei.owner_user_id
          AND ic.kind = ei.kind
          AND ic.value_normalized = ei.value_normalized
        WHERE ei.owner_user_id = $1::uuid
          AND ic.entity_id IS NULL
          AND ic.disposition IS NULL
          AND ei.created_at > ic.observed_at
        LIMIT $2::int`,
      [userId, limit],
    );

    if (rows.length === 0) {
      return 0;
    }

    const bySubjectType = new Map<string, string[]>();

    for (const row of rows) {
      const ids = bySubjectType.get(row.subject_type) ?? [];

      ids.push(String(row.subject_id));
      bySubjectType.set(row.subject_type, ids);
    }

    let reopened = 0;

    for (const [subjectType, ids] of bySubjectType) {
      const stageId = STAGE_FOR_SUBJECT[subjectType];

      if (stageId == null) {
        // A claim subject the ledger has no stage for. Nothing to re-open,
        // and worth knowing about: it means a new claim producer landed
        // without a line in STAGE_FOR_SUBJECT.
        this.logger.warn('Unresolved claims on a subject type no stage links', {
          subjectType,
          subjects: ids.length,
        });
        continue;
      }

      reopened += await this.stateService.reopen(subjectType, stageId, ids);
    }

    if (reopened > 0) {
      this.logger.log('Re-opened person-link decisions for newly registered identifiers', {
        userId,
        subjects: rows.length,
        reopened,
      });
    }

    return reopened;
  }

  /**
   * Re-open each {@link MERGE_SURVIVOR_STAGES} decision about a live survivor
   * that was recorded before a merge into it (see the class note).
   *
   * Driven from `ci.entity_merges` — one row per merged-away source, far fewer
   * than the Persons — with the survivor and its ledger row probed by key.
   * The ledger is probed, and re-opened, under the `entity_type` the stage
   * declares, which is not the merge log's `'Person'` for every stage. The
   * applicability predicate sits in its own EXISTS over the source alone,
   * because it is written against that table's bare column names and
   * `entity_type` is on the merge log and the ledger too. A survivor that has
   * itself been merged away since fails the predicate; the later merge's own
   * row names the person that absorbed it, and that merge moved the claims on.
   *
   * CONTAINED per stage: new evidence not yet applied is the state the leg was
   * already in, so a failure here costs that stage its re-open until the next
   * tick — never the other stage, the identifier re-open above, or the user's
   * tick.
   */
  private async reopenForMergeSurvivors(userId: string, limit: number): Promise<number> {
    let reopened = 0;

    for (const stageId of MERGE_SURVIVOR_STAGES) {
      try {
        const stage = this.stageRegistry.get(stageId);
        const { schema, table, idColumn, userColumn, predicate } = stage.source;
        const applicability = predicate != null && predicate.trim().length > 0 ? predicate : 'TRUE';

        for (const ledgerType of stage.entityTypes) {
          const rows = await this.dataSource.query<Array<{ entity_id: string }>>(
            `SELECT DISTINCT m.target_entity_id AS entity_id
               FROM ci.entity_merges m
              WHERE m.owner_user_id = $1::uuid
                AND m.entity_type = $2
                AND (m.details -> 'counts') ? $6::text
                AND EXISTS (
                      SELECT 1
                        FROM "${schema}"."${table}" s
                       WHERE s."${idColumn}" = m.target_entity_id
                         AND s."${userColumn}" = m.owner_user_id
                         AND (${applicability}))
                AND EXISTS (
                      SELECT 1
                        FROM ci.pipeline_state p
                       WHERE p.entity_type = $7
                         AND p.entity_id = m.target_entity_id
                         AND p.stage = $3
                         AND p.status IN ('done', 'skipped')
                         AND p.stage_version > 0
                         AND p.updated_at < m.created_at + make_interval(secs => $4::float8))
              LIMIT $5::int`,
            [
              userId,
              MERGED_ENTITY_TYPE,
              stage.id,
              CLAIM_LEASE_SECONDS,
              limit,
              EVIDENCE_CARRIED_COUNT,
              ledgerType,
            ],
          );

          if (rows.length === 0) {
            continue;
          }

          const moved = await this.stateService.reopen(
            ledgerType,
            stage.id,
            rows.map((row) => String(row.entity_id)),
          );

          if (moved > 0) {
            this.logger.log('Re-opened decisions about people merged into since', {
              userId,
              stage: stage.id,
              survivors: rows.length,
              reopened: moved,
            });
          }

          reopened += moved;
        }
      } catch (err: unknown) {
        this.logger.error(
          `Could not re-open "${stageId}" decisions for merge survivors; they stand until the next tick`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    return reopened;
  }
}
