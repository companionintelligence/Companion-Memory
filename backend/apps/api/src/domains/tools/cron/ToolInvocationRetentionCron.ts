import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import {
  TOOL_INVOCATION_RETENTION_DAYS,
  ToolInvocationLedgerService,
} from '../services/ToolInvocationLedgerService';

/**
 * 04:45:43, daily.
 *
 *  - **Inside the quiet hours**, after the nightly indexing (02:30 / 03:00 / 03:40) and after
 *    `DerivationCron` (04:40:25), so a bulk DELETE is not competing with a backfill for the pool.
 *  - **Minute 45 of hour 4** is unclaimed: `JobMetricsCollector.purgeOnSchedule` is 04:25:48 and
 *    `DerivationCron` is 04:40:25, the two nearest neighbours.
 *  - **Second 43** because everything left on second 0 fires into one event loop and one
 *    25-connection pool; 43 is named as free in `common/schedule/__tests__/cronSecondOffsets.test.ts`.
 */
export const TOOL_INVOCATION_RETENTION_CRON = '43 45 4 * * *';

/**
 * The bound that keeps `ci.tool_invocations` from becoming `ci.api_logs`.
 *
 * It ships in the same change as the table on purpose. `ci.api_logs` was a per-request log with a
 * `content JSONB` column, a GIN index over it, a compression policy — and no retention job at all;
 * migration `20260225011833_remove_api_log_table.sql` is what that costs. A per-tool-call table on
 * a chatty appliance accretes rows faster than anything a human deletes, and nothing else in the
 * system would ever remove one.
 *
 * `role: 'worker'`. A retention DELETE is queue-worker work, and under a split topology running it
 * in both processes would have two connections deleting the same rows.
 */
@Injectable()
export class ToolInvocationRetentionCron {
  constructor(
    private readonly ledger: ToolInvocationLedgerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ToolInvocationRetentionCron.name);
  }

  @Cron(TOOL_INVOCATION_RETENTION_CRON, {
    name: 'ToolInvocationRetentionCron.pruneOnSchedule',
    role: 'worker',
  })
  async pruneOnSchedule(): Promise<void> {
    const deleted = await this.ledger.prune();

    if (deleted > 0) {
      this.logger.log('Pruned expired tool invocations', {
        deleted,
        retentionDays: TOOL_INVOCATION_RETENTION_DAYS,
      });
    }
  }
}
