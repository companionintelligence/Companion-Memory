import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import { STAGE_IDS } from '../constants';

import { PipelineStateService } from './PipelineStateService';

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
 */
@Injectable()
export class IdentifierArrivalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stateService: PipelineStateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IdentifierArrivalService.name);
  }

  /**
   * Re-open every subject (bounded by `limit`) that carries an unresolved
   * claim an identifier registered since could now answer. Returns how many
   * ledger rows were re-opened.
   */
  async reopenForUser(userId: string, limit = IDENTIFIER_ARRIVAL_BATCH): Promise<number> {
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
}
