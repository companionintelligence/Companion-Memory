import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import {
  AgentMemoryRetentionService,
  type AgentMemoryRetentionResult,
} from '../services/AgentMemoryRetentionService';

/**
 * 02:20:33 daily.
 *
 * Daily because the windows are measured in days: a missed night costs one more
 * night of rows and nothing else, and the sweep holds no cursor to lose.
 *
 * The HOUR is load-bearing, not tidiness. This sweep's deletes reap their
 * `ci_search.embeddings` rows through an event on the `search-index` queue, so
 * a lost or failed event leaves an orphaned embedding — a hit `searchMessages`
 * still returns and `findByIds` can no longer resolve. `OrphanCleanupCron` runs
 * at 02:50:35 and deletes exactly that, so running half an hour ahead of it
 * means the same night sweeps up after anything the event path dropped, rather
 * than leaving it for the next 24 hours of recall.
 *
 * Second 33, not second 0: twelve schedules already fire on second 0 of their
 * minute into one event loop and one 25-connection pool, and 33 is one of the
 * seconds `common/schedule/__tests__/cronSecondOffsets.test.ts` records as
 * unclaimed. Nothing else on the appliance holds 02:20.
 */
export const AGENT_MEMORY_RETENTION_CRON = '33 20 2 * * *';

/**
 * Schedules {@link AgentMemoryRetentionService}.
 *
 * `role: 'worker'` — this is a bounded delete sweep plus one whole-table
 * aggregate, which is worker work, and registering it in both processes of a
 * split deployment would double the deletes and double the cards.
 *
 * The `@Cron` NAME is not decoration: `@ci/common/schedule`'s decorator falls
 * back to `Class.method` for the `ci.cron_runs` key, but `@nestjs/schedule`
 * assigns an unnamed job a random UUID in the SchedulerRegistry, so an unnamed
 * cron is un-addressable across restarts and cannot be deduped.
 */
@Injectable()
export class AgentMemoryRetentionCron {
  constructor(
    private readonly retention: AgentMemoryRetentionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentMemoryRetentionCron.name);
  }

  /**
   * Swallows everything.
   *
   * The next sweep is a day away and retries from the same predicate — this job
   * holds no cursor and no partial state, so a lost tick costs one day of rows.
   * An unhandled rejection out of a cron is a strictly worse outcome.
   *
   * Sentence first, error second: `LoggerService.resolveArgs` takes arg1 as the
   * pino `msg` and serializes an Error in arg2 under `err`. The other way round
   * puts raw error text in `msg` and buries the sentence in `data.message`, so
   * this cron's failures would not grep with any other cron's.
   */
  // `exclusive`: the sweep holds no guard of its own, so a run that outlives a
  // day would otherwise be joined by the next one on the same predicate.
  @Cron(AGENT_MEMORY_RETENTION_CRON, {
    name: 'AgentMemoryRetentionCron.runOnSchedule',
    role: 'worker',
    exclusive: true,
  })
  async runOnSchedule(): Promise<void> {
    try {
      await this.sweepOnce();
    } catch (err: unknown) {
      this.logger.error(
        'Agent-memory retention sweep failed; will retry on the next sweep',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /** Public so a test — or an operator through a REPL — can sweep without waiting a day. */
  async sweepOnce(now?: Date): Promise<AgentMemoryRetentionResult> {
    return this.retention.sweep(now);
  }
}
