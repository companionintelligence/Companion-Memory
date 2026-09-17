import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { RecallProbeService } from '../services/RecallProbeService';

/**
 * 05:20:13, Sundays.
 *
 * Three constraints picked this string:
 *
 *  - **Inside the enrichment window.** `config/default.json` opens it at 01:00
 *    for 300 minutes, so 05:20 is inside it by default. That is where a job
 *    that runs sequential scans over the whole embedding table belongs: the
 *    window exists precisely because contention for the disk and for Ollama
 *    cannot be measured from inside this process and so has to be bounded by a
 *    clock instead. It is late in the window on purpose — the nightly indexing
 *    at 02:30/03:00/03:40 and `DerivationCron` at 04:40 should have finished,
 *    so the probe reads a settled index rather than one mid-backfill.
 *  - **Weekly.** Recall moves when the corpus moves, and the corpus does not
 *    move meaningfully inside a day. Nightly would cost seven sequential scans
 *    of the same table to answer the same question seven times.
 *  - **Second 13.** Twelve schedules already fire on second 0 into one event
 *    loop and one 25-connection pool. The five-second grid is full (see
 *    `common/schedule/__tests__/cronSecondOffsets.test.ts`, whose own note
 *    names 3, 13, 23, 33, 43, 53 and 58 as the next free ones); 13 is
 *    unclaimed, and no other schedule fires at minute 20 of hour 5 anyway —
 *    `AccountPurgeCron` is hourly at second 0, and `EntityPromotionCron` runs on
 *    even hours only.
 */
export const RECALL_PROBE_CRON = '13 20 5 * * 0';

/**
 * The measuring half of search: what recall the HNSW index actually delivers,
 * and what it would deliver at a wider `ef_search`.
 *
 * A one-line delegate on purpose — everything interesting, including every
 * bound on what this costs, is in {@link RecallProbeService}.
 *
 * `role: 'worker'`. The probe is a sweep of sequential scans, which is worker
 * work, and under a split topology running it in both processes would double
 * the scans and write two contradictory measurements of the same week.
 *
 * Nothing here is gated on a feature flag and nothing consults the trust dial:
 * the probe raises no cards, writes no user data, and changes no setting. It
 * measures, and it persists what it measured. The `ef_search` decision the
 * table exists to inform stays a human one — a job that read its own numbers
 * and retuned the index would be exactly the auto-mutation this appliance
 * refuses everywhere else.
 */
@Injectable()
export class RecallProbeCron {
  constructor(
    private readonly recallProbeService: RecallProbeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RecallProbeCron.name);
  }

  // `exclusive`: the probe has no guard of its own, and two overlapping runs
  // would double the sequential scans and write two measurements of one week.
  @Cron(RECALL_PROBE_CRON, { name: 'RecallProbeCron.probeRecall', role: 'worker', exclusive: true })
  async probeRecall(): Promise<void> {
    const run = await this.recallProbeService.probe();

    if (run.rows.length === 0) {
      this.logger.warn('Recall probe measured nothing', {
        runId: run.runId,
        userId: run.userId,
        tooSmall: run.tooSmall,
      });
    }
  }
}
