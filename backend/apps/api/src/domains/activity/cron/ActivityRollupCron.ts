import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import { Cron } from '@ci/common/schedule';

import { ActivityRollupService } from '../services/ActivityRollupService';

// Second 25, not 0. `refreshAll()` is eight full-table aggregates and second 0
// is where every unoffset schedule on the appliance already lands; 10, 20, 30
// and 40 are the seconds other crons deliberately took. See
// common/schedule/__tests__/cronSecondOffsets.test.ts for who holds what.
export const ACTIVITY_ROLLUP_CRON = '25 */15 * * * *';

@Injectable()
export class ActivityRollupCron implements OnApplicationBootstrap {
  constructor(
    private readonly activityRollupService: ActivityRollupService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ActivityRollupCron.name);
  }

  /**
   * Kick one refresh at startup so a fresh install serves data before the
   * first quarter-hour tick. Fire-and-forget; boot must not wait on it.
   */
  onApplicationBootstrap() {
    // Web-role work: the boot refresh duplicated across a split topology is
    // waste, and the in-process `running` guard cannot see the other process.
    if (!serves('web')) {
      return;
    }

    void this.refreshRollup();
  }

  // `exclusive`: the decorator keeps a refresh from stacking on a slow one
  // and logs the skip and any failure. The boot-time call above goes through
  // the same decorated method, so it takes the same guard.
  @Cron(ACTIVITY_ROLLUP_CRON, { name: 'ActivityRollupCron.refreshRollup', exclusive: true })
  async refreshRollup() {
    await this.activityRollupService.refreshAll();
  }
}
