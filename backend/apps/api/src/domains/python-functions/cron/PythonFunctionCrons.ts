import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import { Cron } from '@ci/common/schedule';

import { PythonFunctionService } from '../services/PythonFunctionService';
import type { PythonFunctionTarget } from '../types';

/** Window the dossier prompt reads back over. Mirrors the Python default. */
const DOSSIER_LOOKBACK_DAYS = 30;

/**
 * The scheduler half of the Temporal replacement. These crons replicate the
 * former Temporal Schedules (summary system_schedules.py + HBPE schedule.py):
 * each tick enumerates onboarded users and enqueues ONE pg-boss job per user,
 * deduplicated by a window-scoped singleton key — so a slow run never stacks a
 * second copy of the same user+window, and per-user failures retry
 * independently instead of failing a whole fan-out batch.
 *
 * Cron layout (UTC, matching the old Temporal cadence — nightly HBPE at 02:30
 * deliberately lands after daily summaries at 00:10 and dossier refresh at :12):
 * - hourly summaries  :05 every hour
 * - daily summaries   00:10
 * - weekly summaries  00:15 Monday
 * - monthly summaries 00:20 on the 1st
 * - dossier refresh   :12 every hour
 * - insights          :30 every 3 hours
 * - actions           :45 every hour
 * - HBPE nightly      02:30
 * - HBPE bootstrap    app start + 03:00 daily sweep (no-op for warm users)
 *
 * Per-user window resolution (timezones) and personalization stay inside the
 * Python functions — the cron only sends the user id and a reference instant.
 *
 * Three of these crons stand down when `smart.rotation` is on, because
 * SmartRotationListener dispatches the same Python functions on its own cadence:
 * `insights` (rotation's `insights` work type) and `hourlySummaries` /
 * `dossierRefresh` (rotation's `summaries` work type picks one of the two by
 * staleness). Their singleton keys do NOT collide — this class scopes by
 * time window (`fn:<name>:<user>:<hourKey>`) and rotation scopes by
 * `fn:<name>:<user>:rotation` — so without the guard pg-boss treats them as
 * distinct jobs and both run. These are LLM-bound and take minutes per run.
 *
 * The rest stay unconditional: daily/weekly/monthly summaries, actions, and the
 * HBPE jobs have no smart-rotation equivalent, so gating them would simply stop
 * the work. This mirrors FeedQueueCron and AnswerInferenceCron, which already
 * return early under the same flag.
 */
@Injectable()
export class PythonFunctionCrons implements OnApplicationBootstrap {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly pythonFunctionService: PythonFunctionService,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
  ) {
    this.logger.setContext(PythonFunctionCrons.name);
  }

  /** True when SmartRotationListener owns this work type's cadence. */
  private async cededToSmartRotation(functionName: string): Promise<boolean> {
    if (!(await this.featureService.isFeatureEnabled('smart.rotation'))) {
      return false;
    }

    this.logger.log('Skipping fan-out — smart.rotation owns this cadence', { functionName });

    return true;
  }

  /** Sweep cold users into bootstrap shortly after the API comes up. */
  onApplicationBootstrap(): void {
    // Web-role work: the delayed HBPE bootstrap sweep fanned out twice is
    // duplicate jobs, not resilience.
    if (!serves('web')) {
      return;
    }

    // Fire-and-forget: pg-boss may still be initialising its queues during
    // bootstrap, and a failed sweep is retried by the daily cron anyway.
    setTimeout(() => {
      this.ensureHbpeBootstrap().catch((err) => {
        this.logger.warn('HBPE bootstrap sweep at startup failed', { err });
      });
    }, 30_000);
  }

  @Cron('0 5 * * * *', { name: 'PythonFunctionCrons.hourlySummaries' })
  async hourlySummaries(): Promise<void> {
    if (await this.cededToSmartRotation('hourly_summary')) {
      return;
    }

    await this.fanOut('summary', 'hourly_summary', hourKey());
  }

  @Cron('0 10 0 * * *', { name: 'PythonFunctionCrons.dailySummaries' })
  async dailySummaries(): Promise<void> {
    await this.fanOut('summary', 'daily_summary', dayKey(), { reference_time: new Date().toISOString() });
  }

  @Cron('0 15 0 * * 1', { name: 'PythonFunctionCrons.weeklySummaries' })
  async weeklySummaries(): Promise<void> {
    await this.fanOut('summary', 'weekly_summary', dayKey(), { reference_time: new Date().toISOString() });
  }

  @Cron('0 20 0 1 * *', { name: 'PythonFunctionCrons.monthlySummaries' })
  async monthlySummaries(): Promise<void> {
    await this.fanOut('summary', 'monthly_summary', dayKey(), { reference_time: new Date().toISOString() });
  }

  @Cron('0 12 * * * *', { name: 'PythonFunctionCrons.dossierRefresh' })
  async dossierRefresh(): Promise<void> {
    if (await this.cededToSmartRotation('dossier_refresh')) {
      return;
    }

    // Narrower audience than every onboarded user: dossier_refresh reads the
    // last `DOSSIER_LOOKBACK_DAYS` of hourly/daily summaries and has nothing
    // to build without them. Hourly summaries run at :05 and this at :12, so
    // an appliance in a quiet hour used to enqueue a job per user per hour
    // that could only end in "No summaries found for dossier generation".
    // The Python side now reports that as a skip rather than raising, so this
    // gate is an optimisation, not the fix — it stops the pointless dispatch.
    await this.fanOut('summary', 'dossier_refresh', hourKey(), { lookback_days: DOSSIER_LOOKBACK_DAYS }, () =>
      this.listUsersWithDossierInput(DOSSIER_LOOKBACK_DAYS),
    );
  }

  @Cron('0 30 */3 * * *', { name: 'PythonFunctionCrons.insights' })
  async insights(): Promise<void> {
    if (await this.cededToSmartRotation('insights_generation')) {
      return;
    }

    await this.fanOut('summary', 'insights_generation', hourKey(), { lookback_hours: 72 });
  }

  @Cron('0 45 * * * *', { name: 'PythonFunctionCrons.actions' })
  async actions(): Promise<void> {
    await this.fanOut('summary', 'actions_generation', hourKey(), { lookback_days: 7 });
  }

  @Cron('0 30 2 * * *', { name: 'PythonFunctionCrons.hbpeNightly' })
  async hbpeNightly(): Promise<void> {
    await this.fanOut('hbpe', 'nightly', dayKey());
  }

  @Cron('0 0 3 * * *', { name: 'PythonFunctionCrons.hbpeBootstrapSweep' })
  async hbpeBootstrapSweep(): Promise<void> {
    await this.ensureHbpeBootstrap();
  }

  private async ensureHbpeBootstrap(): Promise<void> {
    await this.fanOut('hbpe', 'ensure_bootstrap', dayKey());
  }

  private async fanOut(
    target: PythonFunctionTarget,
    functionName: string,
    windowKey: string,
    args: Record<string, unknown> = {},
    // Defaults to every onboarded user. A function with a hard input
    // precondition passes a narrower audience so the cron does not enqueue
    // work that can only no-op (see dossierRefresh).
    audience: () => Promise<string[]> = () => this.listOnboardedUserIds(),
  ): Promise<void> {
    const userIds = await audience();

    if (userIds.length === 0) {
      return;
    }

    let enqueued = 0;

    for (const userId of userIds) {
      try {
        const didEnqueue = await this.pythonFunctionService.dispatch(target, functionName, userId, args, {
          singletonKey: `fn:${functionName}:${userId}:${windowKey}`,
        });

        if (didEnqueue) {
          enqueued += 1;
        }
      } catch (err) {
        this.logger.error(
          `Failed to enqueue ${functionName} for user ${userId}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.log('Python function fan-out enqueued', {
      target,
      functionName,
      users: userIds.length,
      enqueued,
    });
  }

  /** Same population the Temporal system workflows fanned out over. */
  private async listOnboardedUserIds(): Promise<string[]> {
    type Row = { id: string };

    const rows = (await this.dataSource.query('SELECT id FROM ci.users WHERE onboarded = true')) as Row[];

    return rows.map((row) => String(row.id));
  }

  /**
   * Onboarded users with at least one summary `dossier_refresh` could read.
   *
   * Deliberately a superset of what the function actually consumes (it takes
   * daily summaries over the whole lookback but hourly ones only from the
   * last 24h): the gate must never withhold a user the function would have
   * had input for. Over-selecting costs one dispatch that returns skipped;
   * under-selecting would silently stop dossiers from ever refreshing.
   */
  private async listUsersWithDossierInput(lookbackDays: number): Promise<string[]> {
    type Row = { id: string };

    const rows = (await this.dataSource.query(
      `SELECT u.id
         FROM ci.users u
        WHERE u.onboarded = true
          AND EXISTS (
                SELECT 1
                  FROM ci.summaries s
                 WHERE s.user_id = u.id
                   AND s.period_type IN ('hourly', 'daily')
                   AND s.period_start >= now() - make_interval(days => $1)
              )`,
      [lookbackDays],
    )) as Row[];

    return rows.map((row) => String(row.id));
  }
}

/** Window key for hourly-cadence work: dedupes within the current UTC hour. */
function hourKey(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

/** Window key for daily-cadence work: dedupes within the current UTC day. */
function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
