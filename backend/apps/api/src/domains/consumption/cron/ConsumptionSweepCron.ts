import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { PostgresConsumptionStore } from '../PostgresConsumptionStore';

/**
 * Hourly, at :15:20.
 *
 * `ci.consumption_windows` and `ci.consumed_nonces` are keyed by short-lived
 * state — the longest window either rate limiter uses is `WINDOW_MS = 60_000`
 * (see `AskRateLimitService` / `PeerRateLimitService`), and the longest a nonce
 * stays claimable is `MAX_SIGNATURE_LIFETIME_MS = 300_000` (`PeerSignatureService`).
 * An hourly sweep is a wide margin over both, so nothing live is ever at risk of
 * being reaped, and the tables never grow past roughly an hour's worth of rows.
 *
 * Off second 0 and off the top of the hour on purpose: everything else on the
 * appliance that fires every hour or every minute contends for second 0, and
 * this sweep is two single-index scoped deletes that do not need to join them.
 */
export const CONSUMPTION_SWEEP_CRON = '20 15 * * * *';

/**
 * How idle a `ci.consumption_windows` row must be before it is reaped.
 *
 * Must exceed the longest `windowMs` any caller passes to `takeWindow` — a
 * window is reaped by IDLENESS (`updated_at`), not by content, so reaping
 * sooner than the longest live window would delete state still being counted
 * against. One hour is a 60x margin over the 60-second windows in use today.
 */
export const CONSUMPTION_SWEEP_OLDER_THAN_MS = 3_600_000;

/** What one sweep reclaimed. */
export interface ConsumptionSweepSummary {
  /** `ci.consumption_windows` rows deleted. */
  windows: number;
  /** `ci.consumed_nonces` rows deleted. */
  nonces: number;
}

/**
 * Drives {@link PostgresConsumptionStore.sweep} on a schedule.
 *
 * The store shipped a reaper and the migration that backs it cut two indexes
 * explicitly to serve this sweep, but nothing ever called it: both tables grew
 * without bound. This class adds no cleanup logic of its own — it schedules
 * the existing method and reports what it reclaimed.
 *
 * `role: 'worker'`, matching the appliance's other reaper crons
 * (`OrphanCleanupCron`, `AgentMemoryRetentionCron`, `ImportRetentionCron`):
 * reclamation is worker work, and in a split deployment only one process
 * should be issuing these deletes.
 *
 * The @Cron NAME is not decoration: `@ci/common/schedule`'s decorator falls
 * back to `Class.method` for the `ci.cron_runs` key, but `@nestjs/schedule`
 * assigns an unnamed job a random UUID in the SchedulerRegistry, so an unnamed
 * cron is un-addressable across restarts and cannot be deduped.
 */
@Injectable()
export class ConsumptionSweepCron {
  private running = false;

  constructor(
    private readonly store: PostgresConsumptionStore,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConsumptionSweepCron.name);
  }

  @Cron(CONSUMPTION_SWEEP_CRON, { name: 'ConsumptionSweepCron.sweepOnSchedule', role: 'worker' })
  async sweepOnSchedule(): Promise<void> {
    // A slow sweep must not stack: two overlapping runs would contend on the
    // same rows and buy nothing, since whatever this run leaves behind is
    // still idle an hour from now.
    if (this.running) {
      this.logger.warn('Skipping consumption-store sweep; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      const swept = await this.sweepOnce();

      this.logger.log('Consumption-store sweep complete', { windows: swept.windows, nonces: swept.nonces });
    } catch (err) {
      this.logger.error(
        'Consumption-store sweep failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.running = false;
    }
  }

  /** Public so a test — or an operator — can sweep without waiting an hour. */
  async sweepOnce(now: Date = new Date()): Promise<ConsumptionSweepSummary> {
    return this.store.sweep(now, CONSUMPTION_SWEEP_OLDER_THAN_MS);
  }
}
