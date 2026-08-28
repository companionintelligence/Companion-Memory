import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { ActionService } from '@ci/domains/intelligence';

import { type RaisableAlert, RetrievalHealthService } from '../services/RetrievalHealthService';
import { RetrievalQueryLogService } from '../services/RetrievalQueryLogService';

/**
 * 03:40:50 UTC daily.
 *
 * Nightly because the counts are whole-table COUNTs and the answer only has to
 * be a day fresh; 03:40 because the heavy nightly work already claims 02:30
 * (HBPE), 03:00 (HBPE bootstrap) and 03:05/03:15 (smart rotation), and this
 * should read a settled index rather than one mid-backfill. Second 50 because
 * twelve schedules already collide on second 0 and in-process timers all fire
 * into the same event loop and the same 25-connection pool — see
 * `common/schedule/__tests__/cronSecondOffsets.test.ts` for who holds what.
 */
export const RETRIEVAL_HEALTH_CRON = '50 40 3 * * *';

/**
 * Days a raised alert suppresses its own repeat, dismissed or not. A week
 * matches the baseline window: if the condition is still true at the next
 * week-over-week comparison, it is worth saying again.
 */
export const ALERT_REPEAT_DAYS = 7;

/**
 * The one job on this appliance whose output is knowledge rather than work.
 *
 * ~43 crons produce derived data and none of them check that the producer
 * produced. That is not a theoretical gap: the coverage holes PR #1605 fixed
 * (content 0/366,862 embedded, event 6.5%) were found by hand, months late,
 * because `EmbedCoverageTelemetryService` — which would have caught them on
 * day one — had exactly one caller, an HTTP route whose comment assumes a
 * metrics scraper polls it. No scraper exists on an appliance. This cron is
 * the scraper.
 *
 * Three deliberate splits:
 *
 *  1. MEASURING is unconditional; ALERTING is behind the `actions` feature
 *     flag. Turning cards off must not turn the measurement off, or the flag
 *     silently recreates the blind spot.
 *  2. The snapshot is PERSISTED (`ci.retrieval_health_snapshots`), not just
 *     logged. "Is content covered" is answerable from a log line; "did content
 *     stop being covered this week" is not, and that is the question worth
 *     paging on.
 *  3. It runs on the WORKER role. It is a sweep of whole-table counts, which
 *     is worker work, and running it in both processes would double the counts
 *     and double the cards.
 */
@Injectable()
export class RetrievalHealthCron {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly retrievalHealthService: RetrievalHealthService,
    private readonly retrievalQueryLogService: RetrievalQueryLogService,
    private readonly actionService: ActionService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RetrievalHealthCron.name);
  }

  @Cron(RETRIEVAL_HEALTH_CRON, { name: 'RetrievalHealthCron.captureRetrievalHealth', role: 'worker' })
  async captureRetrievalHealth(): Promise<void> {
    const run = await this.retrievalHealthService.capture();

    // The second measurement, run unconditionally alongside the first for the
    // same reason: it rolls up and PRUNES ci.retrieval_query_log, so skipping
    // it when there is nothing to alert about would leave the table unbounded.
    // It answers the question coverage cannot — what the appliance actually
    // returned to real questions — so it is a peer of the coverage run, not a
    // branch of it.
    const queryRun = await this.retrievalQueryLogService.capture();

    if (run.alerts.length === 0 && queryRun.alerts.length === 0) {
      return;
    }

    if (!(await this.featureService.isFeatureEnabled('actions'))) {
      // Measurement still landed in ci.retrieval_health_snapshots and
      // ci.retrieval_query_log; only the feed cards are suppressed.
      this.logger.warn('Retrieval-health alerts suppressed: actions feature disabled', {
        runId: run.runId,
        alerts: [...run.alerts, ...queryRun.alerts.map((entry) => entry.alert)].map((alert) => alert.key),
      });

      return;
    }

    await this.raiseAlerts(run.alerts);

    // Per-USER, not fanned out. A zero-result rate is measured from one
    // person's own queries, so raising it against every onboarded account would
    // tell four other people about a hole only the fifth one hit.
    for (const { userId, alert } of queryRun.alerts) {
      await this.raiseAlert(userId, alert);
    }
  }

  /**
   * One card per (user, alert), NOT gated by the trust dial.
   *
   * The dial rates inferences the appliance draws ABOUT the user — how sure it
   * is, and how much latitude it has to act on that. An alert here is neither:
   * it is a whole-table COUNT reporting that the machine's own index is broken,
   * a fact about the appliance with nothing to be less than certain about. So
   * there is no honest confidence to feed the dial, and asking it anyway is how
   * this method used to carry a `decideAction(…, { confidence: 1 })` call whose
   * `skip` branch no trust mode could reach — a gate that could not refuse, and
   * a docblock claiming it could.
   *
   * Placement is still the dial's call, one hop downstream: `ActionService`
   * emits `ActionCreatedEvent`, and `FeedQueuePopulationListener` runs the
   * feed_action decision before inserting into `ci.feed_queue`. That is the
   * boundary that actually is "a write into somebody's feed". A user who wants
   * no cards at all has the `actions` flag above.
   *
   * The repeat probe is this method's own gate: a nightly cron re-raising the
   * same card every night is how a feed becomes noise, so one (type, reason)
   * yields at most one card per {@link ALERT_REPEAT_DAYS}. The probe
   * deliberately ignores `dismissed`: keying on undismissed rows only would put
   * the card straight back the night after the user cleared it, which is
   * nagging. Ignoring dismissal in the other direction — never repeating —
   * would let a still-broken index go quiet, so the alert does come back, a
   * week later, while it is still true.
   */
  private async raiseAlerts(alerts: RaisableAlert[]): Promise<void> {
    const userIds = await this.listOnboardedUserIds();

    for (const userId of userIds) {
      for (const alert of alerts) {
        await this.raiseAlert(userId, alert);
      }
    }
  }

  /** One card, for one user, deduped on `metadata->>'key'`. Never throws. */
  private async raiseAlert(userId: string, alert: RaisableAlert): Promise<void> {
    try {
      if (await this.hasRecentAlert(userId, alert.key)) {
        return;
      }

      await this.actionService.create(toServiceContext({ userId }), {
        title: alert.title,
        text: alert.text,
        // NOT 'anomaly'/'suggestion': those two share a cap of three cards
        // per local day (ActionService.countDerivedOnLocalDay), and an
        // infrastructure alert must not spend the budget the Brief's
        // anomaly and suggestion engines are counting on.
        source: 'legacy',
        metadata: {
          key: alert.key,
          kind: 'retrieval_health',
          reason: alert.reason,
          // Omitted rather than null for the zero-result-rate card, which is
          // about a user's queries and not about any one entity type.
          ...(alert.entityType == null ? {} : { entityType: alert.entityType }),
          ...alert.detail,
        },
      });

      this.logger.warn('Raised retrieval-health alert', {
        userId,
        key: alert.key,
        reason: alert.reason,
        entityType: alert.entityType,
      });
    } catch (error) {
      // One user's failed card must not cost the others theirs.
      this.logger.error('Failed to raise retrieval-health alert', {
        userId,
        key: alert.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** True when this user was already told about this alert inside the repeat window. */
  private async hasRecentAlert(userId: string, key: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT 1
         FROM ci.actions
        WHERE user_id = $1
          AND metadata->>'key' = $2
          AND created_at >= now() - make_interval(days => $3)
        LIMIT 1`,
      [userId, key, ALERT_REPEAT_DAYS],
    )) as unknown[];

    return rows.length > 0;
  }

  /** Same population every other fan-out cron uses. */
  private async listOnboardedUserIds(): Promise<string[]> {
    const rows = (await this.dataSource.query('SELECT id FROM ci.users WHERE onboarded = true')) as Array<{
      id: string;
    }>;

    return rows.map((row) => String(row.id));
  }
}
