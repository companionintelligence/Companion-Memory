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
 * Nightly (02:30) and ensure_bootstrap (boot+30s / 03:00) share one worker and
 * one pipeline. Distinct keys let both sit `active` after a missed callback.
 * Manual Predict keeps `fn:nightly:<user>:manual` and is not this path.
 */
function hbpePipelineSingleton(
  target: PythonFunctionTarget,
  functionName: string,
  userId: string,
  windowKey: string,
): string {
  if (target === 'hbpe' && (functionName === 'nightly' || functionName === 'ensure_bootstrap')) {
    return `fn:hbpe:${userId}:${windowKey}`;
  }

  return `fn:${functionName}:${userId}:${windowKey}`;
}

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
 * `dossierRefresh` (rotation's `summaries` work type dispatches both as
 * independent products). Their singleton keys do NOT collide — this class
 * scopes by time window (`fn:<name>:<user>:<hourKey>`) and rotation scopes by
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

    // Narrower audience than every onboarded user, on two counts: has this
    // user any dossier input at all, and is any of it NEWER than the dossier
    // already stored. See listUsersWithStaleDossier — without the second half
    // this cron ran a full LLM pass per user per hour over inputs that had not
    // moved, which is the shipped-config behaviour because `smart.rotation`
    // (the only other dossier scheduler, and the only one that had a freshness
    // gate) is false in config/default.json.
    await this.fanOut('summary', 'dossier_refresh', hourKey(), { lookback_days: DOSSIER_LOOKBACK_DAYS }, () =>
      this.listUsersWithStaleDossier(DOSSIER_LOOKBACK_DAYS),
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
          singletonKey: hbpePipelineSingleton(target, functionName, userId, windowKey),
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
   * Onboarded users `dossier_refresh` has something NEW to build from.
   *
   * ═══ TWO CONDITIONS, FOR TWO DIFFERENT WASTED DISPATCHES ═══
   *
   * The first is input existence: `dossier_refresh` reads the last
   * `lookbackDays` of hourly/daily summaries and has nothing to build without
   * them. Hourly summaries run at :05 and this cron at :12, so an appliance in
   * a quiet hour used to enqueue a job per user per hour whose only possible
   * outcome was "No summaries found for dossier generation" — 19 dead letters
   * on the QA box before the Python side downgraded that to a skip.
   *
   * The second is input freshness, and it is the expensive one. Past that
   * skip, `dossier_refresh` regenerates unconditionally: a full LLM pass over
   * 30 days of daily plus 24 hours of hourly summaries, once an hour, whether
   * or not a single summary was written in between. On a corpus that stopped
   * moving that is 24 identical rebuilds a day on the GPU the hourly digest
   * contends for.
   *
   * The freshness half is the same question `SmartRotationListener`'s
   * `hasSummaryNewerThanDossier` asks per user — was a summary STORED after
   * the dossier was BUILT — asked here set-wise for a fan-out. That listener
   * only runs when `smart.rotation` is enabled, and it is `false` in
   * `config/default.json` with no production override, so on the configuration
   * that actually ships this cron is the only dossier scheduler there is; a
   * gate that lives only in the listener is a gate nobody runs.
   *
   * ═══ WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT ═══
   *
   * The build time comes from the dossier payload's own `lastUpdatedAt`, which
   * `store_dossier_activity` stamps when it writes `ci.entities.dossier` — not
   * `entities.updated_at`, which every unrelated entity write (imports, merges,
   * enrichment) bumps and which would therefore read as "the dossier is
   * current" and suppress a rebuild that is genuinely owed. The stamp is naive
   * UTC (`datetime.utcnow().isoformat()`), hence the `AT TIME ZONE 'UTC'` on
   * the summary side rather than a session TimeZone the API pool does not pin.
   *
   * Only `hourly` and `daily` mark it stale, because those are the two period
   * types `fetch_summaries_for_dossier_activity` reads. An `insight` row shares
   * the table and is written hourly by `insights_generation`; counting one as
   * dossier input would put the hourly rebuild straight back.
   *
   * `created_at`, not `GREATEST(created_at, updated_at)`: a window
   * re-summarized in place keeps its `created_at`, so a rewrite waits for the
   * next new hour — a bounded miss on the quiet side — while `updated_at`
   * moves for `seen`/`dismissed` flips that are not new input at all.
   *
   * ═══ BOTH HALVES FAIL OPEN ═══
   *
   * The existence half is deliberately a superset of what the function
   * consumes (it takes daily summaries over the whole lookback but hourly ones
   * only from the last 24h), and the freshness half treats every unknown as
   * stale: no self entity, the `'{}'` default dossier, or a `lastUpdatedAt`
   * that will not parse (hence `DEFAULT NULL ON ERROR` rather than a bare cast,
   * which would throw and take the whole fan-out down). Over-selecting costs
   * one dispatch that returns skipped; under-selecting would silently stop
   * dossiers from ever refreshing again.
   */
  private async listUsersWithStaleDossier(lookbackDays: number): Promise<string[]> {
    type Row = { id: string };

    const rows = (await this.dataSource.query(
      `SELECT u.id
         FROM ci.users u
         -- Same resolution order as the sidecar's get_entity_id_activity: the
         -- users row first, the oldest owned Person second. Resolving it
         -- differently would gate on a different entity than the one
         -- dossier_refresh writes to, and the gate would never close.
         LEFT JOIN LATERAL (
           SELECT JSON_VALUE(e.dossier, '$.lastUpdatedAt' RETURNING timestamp DEFAULT NULL ON ERROR) AS built_at
             FROM ci.entities e
            WHERE e.entity_id = COALESCE(
                    u.entity_id,
                    (SELECT p.entity_id
                       FROM ci.entities p
                      WHERE p.owner_user_id = u.id
                        AND p.entity_type = 'Person'
                      ORDER BY p.created_at
                      LIMIT 1)
                  )
         ) built ON TRUE
        WHERE u.onboarded = true
          AND EXISTS (
                SELECT 1
                  FROM ci.summaries s
                 WHERE s.user_id = u.id
                   AND s.period_type IN ('hourly', 'daily')
                   AND s.period_start >= now() - make_interval(days => $1)
              )
          AND (
                built.built_at IS NULL
                OR EXISTS (
                     SELECT 1
                       FROM ci.summaries fresh
                      WHERE fresh.user_id = u.id
                        AND fresh.period_type IN ('hourly', 'daily')
                        AND fresh.created_at AT TIME ZONE 'UTC' > built.built_at
                   )
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
