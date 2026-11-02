import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { YieldGateRegistry } from '@ci/domains/events';

import { PYTHON_FUNCTION_QUEUES, SUMMARY_SERVICE_YIELD_GATE } from '../types';

/** How soon a model someone just added or pulled is noticed. */
export const WAITING_RECHECK_MS = 60_000;

/**
 * Only catches the summary service restarting into having no model, which is
 * rare. Asking this seldom keeps a healthy appliance's sidecar log quiet.
 */
export const OPEN_RECHECK_MS = 5 * 60_000;

/** Above the longest `/health` can take: its 3 s probe plus a 10 s model listing. */
const HEALTH_TIMEOUT_MS = 15_000;

/**
 * Runs the summary service may be holding before the queue stops handing it more.
 * Above its two workers, so they never sit idle. Low enough that the last run
 * handed over still starts well inside the queue's 30 minute expiry. The queue's
 * `localConcurrency: 1` makes this exact: it fetches one job per ask, where a batch
 * could otherwise overshoot by the size of the batch.
 */
export const MAX_RUNS_IN_FLIGHT = 4;

/**
 * Stands `py-fn-summary` aside while the summary service can't take its work.
 *
 * First, while it has no chat model, which is every Hub with no AI engine until
 * someone adds one or pulls a model. Failing those jobs instead would spend the
 * queue's retries within about ten minutes and dead-letter them. Completing them as
 * skipped would lose their window. Behind a closed gate they stay `created` with no
 * lease and no retry spent. They run in order the moment it opens, for as long as
 * the queue's retention keeps them (90 days). The answer comes from `/health` on
 * the summary service (`llm.model`), read in the background so a slow answer never
 * holds up a worker loop.
 *
 * Unlike other gates this one stays closed when it can't get an answer, because
 * the dispatch goes to the same address and would fail too. Open, a queue that has
 * built up a backlog would spend a retry on every job in it each time the API came
 * up before the summary service. A summary service that answers 2xx without
 * mentioning a model opens the gate.
 *
 * Second, while it already holds {@link MAX_RUNS_IN_FLIGHT} runs. A dispatch only
 * hands a run over and frees its worker slot, so nothing else limits how fast a
 * backlog leaves the queue. When a model arrives, everything that was waiting for
 * one would reach the service at once. What doesn't fit in its run queue gets a 429
 * that spends a retry.
 */
@Injectable()
export class SummaryServiceYieldGate {
  private waitingForModel = true;

  private nextCheckAt = 0;

  private checking = false;

  private unreachable = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SummaryServiceYieldGate.name);
    // At construction for the reason InteractiveChatYieldGate gives: the worker
    // loops start before any module's init hooks have finished.
    YieldGateRegistry.register(SUMMARY_SERVICE_YIELD_GATE, () => this.shouldYield());
  }

  async shouldYield(): Promise<boolean> {
    if (!this.checking && Date.now() >= this.nextCheckAt) {
      this.checking = true;
      void this.checkForModel().finally(() => {
        this.checking = false;
      });
    }

    if (this.waitingForModel) {
      return true;
    }

    return (await this.runsInFlight()) >= MAX_RUNS_IN_FLIGHT;
  }

  private async runsInFlight(): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT count(*)::int AS active FROM pgboss.job WHERE name = $1 AND state = 'active'`,
      [PYTHON_FUNCTION_QUEUES.summary],
    )) as Array<{ active: number }>;

    return rows[0]?.active ?? 0;
  }

  private async checkForModel(): Promise<void> {
    const url = `${config.services.summary.host.replace(/\/+$/, '')}/health`;
    let waiting = true;
    let unreachable = false;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as { llm?: { model?: unknown } };

      waiting = body.llm?.model === null;
    } catch (err) {
      unreachable = true;

      if (!this.unreachable) {
        this.logger.warn('Summary service did not answer; its queue waits until it does', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.unreachable = unreachable;
    this.waitingForModel = waiting;
    this.nextCheckAt = Date.now() + (waiting ? WAITING_RECHECK_MS : OPEN_RECHECK_MS);
  }
}
