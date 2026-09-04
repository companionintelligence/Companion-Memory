import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { OrphanCleanupService, type OrphanTypeResult } from '@ci/domains/search-ingress';

/**
 * 02:50:35 daily.
 *
 * Second 35, not second 0: twelve schedules already fire on second 0, and a
 * sweep that opens one anti-join per (index table x indexable type) is a poor
 * thing to stack on top of them. Nothing else on the appliance holds
 * 02:50, and the two neighbours in that minute (`AskExpiryCron`,
 * `MemoryCompactionCron`) sit on seconds 0 and 45.
 *
 * The hour is chosen to sit BEFORE `RetrievalHealthCron` (03:40:50), and that
 * ordering is load-bearing, not tidiness. Coverage is `embedded / total`, where
 * `embedded` counts `ci_search.embeddings` rows for the type — orphans included.
 * An orphan therefore inflates the numerator and not the denominator, so
 * measuring an unswept index reports a type as better covered than it is, and
 * the ratio clamps at 1. Sweeping first is what stops accumulated orphans from
 * masking the coverage hole the health cron exists to find.
 *
 * It also sits after `hbpeNightly` (02:30) with ~50 minutes of headroom before
 * the measurement, which is the slack a first-ever sweep on a large corpus gets
 * to use.
 */
export const ORPHAN_CLEANUP_CRON = '35 50 2 * * *';

/**
 * Rows deleted per statement. This is the sweep's lock footprint, so it is
 * stated here rather than inherited from the service default: the nightly run
 * is the one that executes against a live index with no operator watching.
 * 5000 is what `OrphanCleanupService` documents as safe online; the service
 * loops until a batch comes back short, so this bounds each statement, not the
 * total reclaimed.
 */
export const ORPHAN_CLEANUP_BATCH_SIZE = 5000;

/**
 * Per-statement ceiling for the nightly sweep, stated here for the same reason
 * the batch size is: this is the run with nobody watching.
 *
 * 120s matches `RetrievalHealthCron`'s measurement pass. The sweep is the
 * heavier of the two — one anti-join per (index table x indexable type), plus a
 * bounded DELETE loop for anything it finds — so it is the one that must not be
 * able to pin a connection out of the 25-connection pool indefinitely. Blowing
 * the ceiling throws, which the schedule wrapper records as an attempted-not-
 * succeeded tick; a hung sweep records nothing at all.
 */
export const ORPHAN_CLEANUP_STATEMENT_TIMEOUT_MS = 120_000;

/** Per-(table, type) tallies worth printing — a zero row is noise. */
function nonZero(results: OrphanTypeResult[]): Record<string, number> {
  const summary: Record<string, number> = {};

  for (const result of results) {
    if (result.deleted > 0) {
      summary[`${result.searchTable}:${result.entityType}`] = result.deleted;
    }
  }

  return summary;
}

/** What one nightly sweep reclaimed. */
export interface OrphanSweepSummary {
  /** Orphan index rows deleted. */
  deleted: number;
}

/**
 * Schedule for a sweep that already existed and that nothing ever ran.
 *
 * `OrphanCleanupService.cleanOrphans()` deletes `ci_search.embeddings` /
 * `ci_search.vectors` / `ci_search.index_skips` rows whose source row is gone.
 * It is bounded, batched, idempotent and driven by the shared
 * `ENTITY_SOURCE_MAP` — and its only callers were two manual HTTP routes on
 * `MaintenanceController`. Nobody clicks those, so search-index orphans
 * accumulated with no upper bound: dead rows that cost storage, dilute recall,
 * and (for `index_skips`) permanently suppress re-examination of an id that
 * has since been re-created.
 *
 * This class adds no cleanup logic of its own. It schedules the existing
 * service and reports what it did.
 *
 * **One pass, and it deletes.** An earlier revision ran a `dryRun` survey first
 * so the log carried a "would remove N" line ahead of the "removed M" line. It
 * bought nothing: nothing branched on the survey except whether to run the pass
 * that reports the same number more accurately, and it doubled the statement
 * count of the heaviest sweep on the appliance (an anti-join per index table x
 * indexable type, issued twice). The delete pass already returns a per-(table,
 * type) tally, so what is logged now is what was actually reclaimed rather than
 * what a count taken moments earlier predicted.
 *
 * No config flag gates the delete: it always deletes. A flag defaulting to on
 * would add a knob whose only reachable setting is the default, and observe-only
 * already exists — `POST /api/maintenance/search-index/cleanup-orphans` with
 * `{"dryRun": true}` is exactly that, on demand. A nightly job that counts
 * orphans and then leaves them is the failure this schedule exists to end.
 */
@Injectable()
export class OrphanCleanupCron {
  constructor(
    private readonly orphanCleanupService: OrphanCleanupService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OrphanCleanupCron.name);
  }

  /**
   * Deliberately does NOT catch.
   *
   * The `@ci/common/schedule` wrapper catches one frame out, logs the failure
   * under this schedule's name with the tick's traceId, and — critically —
   * skips `CronRunStore.recordSuccess`. Swallowing here would return normally,
   * the wrapper would stamp the tick a success, and a sweep that failed every
   * night would be indistinguishable on the Jobs dashboard from one that ran
   * clean. That is the exact silence this PR exists to remove.
   *
   * Runs on the worker: reclamation is worker work, and in a split deployment
   * only one process should be issuing these deletes.
   */
  // `exclusive`: the sweep has no guard of its own, and two of these deleting
  // the same batch is contention rather than progress.
  @Cron(ORPHAN_CLEANUP_CRON, { name: 'OrphanCleanupCron.sweepOnSchedule', role: 'worker', exclusive: true })
  async sweepOnSchedule(): Promise<void> {
    await this.sweepOnce();
  }

  /** Public so a test — or an operator — can sweep without waiting for 02:50. */
  async sweepOnce(): Promise<OrphanSweepSummary> {
    const swept = await this.orphanCleanupService.cleanOrphans({
      batchSize: ORPHAN_CLEANUP_BATCH_SIZE,
      statementTimeoutMs: ORPHAN_CLEANUP_STATEMENT_TIMEOUT_MS,
    });

    this.logger.log('Nightly orphan sweep complete', {
      deleted: swept.totalDeleted,
      byTable: nonZero(swept.results),
    });

    return { deleted: swept.totalDeleted };
  }
}
