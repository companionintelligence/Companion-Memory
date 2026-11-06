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

/**
 * How often the refresh is a FULL recompute. Between full passes it is
 * incremental — only the buckets a row was added to, edited in or deleted
 * from since the previous pass — which is what makes a quarter-hourly cadence
 * cost quarter-hourly work: eight full-table aggregates every fifteen minutes
 * were the appliance's biggest standing read. A full pass is still needed for
 * what an incremental one cannot see: a hard-deleted row leaves nothing to
 * find, and `communications` has no row timestamp to find anything by.
 */
export const ACTIVITY_FULL_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How far behind the previous pass's start the incremental window begins. A
 * row's `updated_at` is its transaction's start, so a long import commits rows
 * stamped before the pass that ran during it; this margin re-covers them. An
 * hour of buckets is cheap to count twice.
 */
export const ACTIVITY_CHANGE_MARGIN_MS = 60 * 60_000;

@Injectable()
export class ActivityRollupCron implements OnApplicationBootstrap {
  /** When the last pass that completed started; the next incremental pass covers changes since then. */
  private lastPassStartedAt: Date | null = null;

  /** When the last FULL pass that completed started. */
  private lastFullPassStartedAt: Date | null = null;

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
    const startedAt = this.now();
    const lastPass = this.lastPassStartedAt;
    const full =
      lastPass == null ||
      this.lastFullPassStartedAt == null ||
      startedAt.getTime() - this.lastFullPassStartedAt.getTime() >= ACTIVITY_FULL_REFRESH_INTERVAL_MS;

    try {
      await this.activityRollupService.refreshAll(
        full || lastPass == null
          ? {}
          : { changedSince: new Date(lastPass.getTime() - ACTIVITY_CHANGE_MARGIN_MS) },
      );

      // Advanced only on success: a failed pass leaves the window where it was,
      // so the next one covers what this one did not.
      this.lastPassStartedAt = startedAt;

      if (full) {
        this.lastFullPassStartedAt = startedAt;
      }
    } catch (err) {
      this.logger.error(
        'Activity rollup refresh failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /** The clock, overridable by a spec. */
  protected now(): Date {
    return new Date();
  }
}
