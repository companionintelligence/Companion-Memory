import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { DEVICE_RECORD_VERSION, entityDeviceRecordSql, entityTimeSql } from '@ci/domains/search-next';

/**
 * Every 10 minutes, at second 58 of minutes 7, 17, 27...
 *
 * Second 58 because the five-second grid is full and `cronSecondOffsets.test.ts`
 * names 58 as the next free second; minute 7 keeps it off the 5-minute marks the
 * pipeline tick and memory compaction hold. Ten minutes because on a current
 * corpus a tick finds nothing and costs one index probe; it only does real work
 * for a while after a deploy that bumps {@link DEVICE_RECORD_VERSION}.
 */
export const MOBILE_SEARCH_DOCUMENT_DETAIL_CRON = '58 7/10 * * * *';

/**
 * Documents rewritten per statement. Each row is one primary-key lookup into
 * its source table (measured ~0.015 ms/row on the dev corpus), so a batch is a
 * fraction of a second and its row locks are short; a version bump over 600k
 * documents converges in a few dozen batches.
 */
export const MOBILE_SEARCH_DOCUMENT_DETAIL_BATCH_SIZE = 5000;

/** Batches per tick: bounds one tick's work so it cannot run into the next. */
export const MOBILE_SEARCH_DOCUMENT_DETAIL_MAX_BATCHES = 40;

/** What one run did. */
export interface DetailRefreshSummary {
  /** Documents re-derived. */
  updated: number;
  /** Batches run; equal to the cap means more remain for the next tick. */
  batches: number;
}

/**
 * Brings every device record up to the current {@link DEVICE_RECORD_VERSION}.
 *
 * The shared index statement (`buildVectorUpsertStatement`) writes `related_id`,
 * `detail` and `occurred_at` for every row it touches, so new and re-indexed
 * rows are always current. This cron covers the rest: the corpus that existed
 * when the columns were added (migration 20261021203300, `detail_version` 0),
 * and every row after a later change to the record recipe or to a type's time
 * rule bumps the version. It rewrites only those three columns, from the same
 * SQL, without touching the tsvector — no re-embedding, no pipeline ledger
 * churn.
 *
 * Each batch touches `updated_at` too, because that is what makes PowerSync
 * replicate the row to phones. A version bump therefore re-sends every document,
 * once; that is the price of changing what a record carries.
 *
 * Not a one-off data-fix migration: it runs on every install and converges to a
 * no-op, and the version is the knob that re-runs it.
 *
 * Deliberately does not catch: the `@ci/common/schedule` wrapper logs a failure
 * under this schedule's name and skips the success stamp, so a run that fails
 * every tick shows on the Jobs dashboard. `exclusive`, because two ticks would
 * pick the same batch.
 */
@Injectable()
export class MobileSearchDocumentDetailCron {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MobileSearchDocumentDetailCron.name);
  }

  @Cron(MOBILE_SEARCH_DOCUMENT_DETAIL_CRON, {
    name: 'MobileSearchDocumentDetailCron.refreshOnSchedule',
    role: 'worker',
    exclusive: true,
  })
  async refreshOnSchedule(): Promise<void> {
    const summary = await this.refreshOnce();

    if (summary.updated > 0) {
      this.logger.log('Device records refreshed', { ...summary, version: DEVICE_RECORD_VERSION });
    }
  }

  /** Public so a test — or an operator — can converge without waiting for the schedule. */
  async refreshOnce(
    batchSize: number = MOBILE_SEARCH_DOCUMENT_DETAIL_BATCH_SIZE,
    maxBatches: number = MOBILE_SEARCH_DOCUMENT_DETAIL_MAX_BATCHES,
  ): Promise<DetailRefreshSummary> {
    let updated = 0;
    let batches = 0;

    while (batches < maxBatches) {
      const rows: Array<{ count: string }> = await this.dataSource.query(refreshBatchSql(), [
        DEVICE_RECORD_VERSION,
        batchSize,
      ]);
      const count = Number(rows[0]?.count ?? 0);

      batches += 1;
      updated += count;

      if (count < batchSize) {
        break;
      }
    }

    return { updated, batches };
  }
}

/**
 * One batch: the next rows below the version (served by the
 * `(detail_version, id)` index), re-derived and stamped. `FOR UPDATE SKIP
 * LOCKED` so a row a live index write holds is left for the next batch rather
 * than waited on.
 *
 * Exported for the test.
 */
export function refreshBatchSql(): string {
  return `
    WITH batch AS (
      SELECT id FROM ci_search.mobile_search_documents
       WHERE detail_version < $1
       ORDER BY detail_version, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
    ),
    derived AS (
      SELECT src.id, rec.related_id, rec.detail, ${entityTimeSql('src')} AS occurred_at
        FROM batch
        JOIN ci_search.mobile_search_documents src ON src.id = batch.id
        LEFT JOIN LATERAL (${entityDeviceRecordSql('src')}) rec ON true
    ),
    refreshed AS (
      UPDATE ci_search.mobile_search_documents d
         SET related_id = derived.related_id,
             detail = derived.detail,
             occurred_at = derived.occurred_at,
             detail_version = $1,
             updated_at = now()
        FROM derived
       WHERE d.id = derived.id
      RETURNING 1
    )
    SELECT count(*)::text AS count FROM refreshed`;
}
