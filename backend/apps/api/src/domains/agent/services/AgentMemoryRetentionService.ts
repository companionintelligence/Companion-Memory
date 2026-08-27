import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { ActionService } from '@ci/domains/intelligence';

import { AgentMemoryEntity } from '../entities/AgentMemoryEntity';

import { AgentMemoryService } from './AgentMemoryService';

/** `metadata->>'key'` the stuck-pipeline card is deduped on. */
export const STUCK_ALERT_KEY = 'agent_memory_stuck';

/** One user's unprocessed backlog, as the group-by returns it. */
interface StuckBacklog {
  readonly userId: string;
  readonly fragments: number;
  readonly oldest: Date;
}

/** What one nightly sweep did. */
export interface AgentMemoryRetentionResult {
  /** False when `agent.memoryRetention.enabled` is off; every other field is then 0. */
  readonly enabled: boolean;
  /** Processed fragments destroyed, embeddings included. */
  readonly deleted: number;
  /** Expired fragments still over the window after the batch cap — a backlog draining across nights. */
  readonly backlog: number;
  /** Users holding fragments older than `stuckAfterDays` that nothing has processed. */
  readonly stuckUsers: number;
  /** Total unprocessed-and-overdue fragments across those users. */
  readonly stuckFragments: number;
  /** Stuck-pipeline cards written to `ci.actions` this sweep. */
  readonly alertsRaised: number;
}

const EMPTY_RESULT: AgentMemoryRetentionResult = {
  enabled: false,
  deleted: 0,
  backlog: 0,
  stuckUsers: 0,
  stuckFragments: 0,
  alertsRaised: 0,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Retention for `ci.agent_memories`.
 *
 * The table has existed since `20260601000001_create_agent_memories.sql` and
 * been effectively empty, because nothing wrote to it. That is changing, and a
 * producer without retention is how an appliance grows an unbounded table of
 * its owner's private conversation distillate.
 *
 * **Two lifecycle halves, two policies — because they hold different things.**
 *
 * A fragment with `processed_at` stamped has already been through
 * `MemoryCompactionService`: its entities and relationships are in the
 * knowledge graph, which is the durable representation and the one every other
 * reader consults. The raw text is a second copy. A fragment with
 * `processed_at IS NULL` has been through nothing — the text IS the only copy —
 * so no age makes deleting it a retention decision rather than data loss. Age
 * on an unprocessed fragment means the pipeline is stuck, and the answer to a
 * stuck pipeline is to say so, not to delete the evidence. Hence: expiry on the
 * processed half, an alert on the other.
 *
 * **Deleting a processed fragment is not free, and this is the honest cost.**
 * `RecallService`'s message channel vector-searches these fragments and unions
 * their raw text into the recall block alongside the graph lines, deliberately,
 * because the compactor's serialisation is lossy — the graph line says "Priya
 * Sharma — lives in Phoenix" where the fragment also said she moved from Eugene
 * last spring. That channel reads BOTH halves: it goes through
 * `SearchService.searchMessages` → `AgentMemoryService.findByIds`, and neither
 * hop filters on `processed_at`. So expiring processed fragments does change
 * recall — it shortens the raw-text window to `processedDays` while leaving the
 * graph untouched. That is why the default is a year rather than something
 * tighter, and why it is configurable.
 *
 * **Deletion goes through `AgentMemoryService.remove`, one row at a time.**
 * A bulk `DELETE` would be far cheaper and would be a bug: fragments have no
 * DB-level FK into `ci_search.embeddings`, so the embedding is reaped by the
 * `AgentMemoryRemovedEvent` that `remove` emits and by nothing else. Deleting
 * rows underneath the index leaves `searchMessages` returning ids that
 * `findByIds` can no longer resolve — hits that silently produce no line, the
 * recall channel quietly degrading with no error anywhere. The per-row path is
 * bounded by `deleteBatchSize` instead.
 *
 * **The sweep is safe while the producer is off.** `agent.memory.compaction`
 * defaults to false; with it off nothing ever stamps `processed_at`, so the
 * expiry predicate matches nothing and this sweep deletes nothing. The stuck
 * alert is gated on the same flag for the mirror-image reason: with compaction
 * disabled, unprocessed IS the steady state, and reporting it as a stuck
 * pipeline would be nagging every user about a feature they have not enabled.
 */
@Injectable()
export class AgentMemoryRetentionService {
  private readonly systemContext: ServiceContext = { userId: SYSTEM_USER };

  constructor(
    @InjectRepository(AgentMemoryEntity)
    private readonly repository: Repository<AgentMemoryEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly actionService: ActionService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentMemoryRetentionService.name);
  }

  async sweep(now: Date = new Date()): Promise<AgentMemoryRetentionResult> {
    const settings = config.agent.memoryRetention;

    if (!settings.enabled) {
      this.logger.debug('Agent-memory retention disabled; nothing swept');

      return EMPTY_RESULT;
    }

    const { deleted, backlog } = await this.expireProcessed(now, settings);
    const { stuckUsers, stuckFragments, alertsRaised } = await this.reportStuck(now, settings);

    return { enabled: true, deleted, backlog, stuckUsers, stuckFragments, alertsRaised };
  }

  // ---------------------------------------------------------------------------
  // Expiry — the processed half
  // ---------------------------------------------------------------------------

  private async expireProcessed(
    now: Date,
    settings: { processedDays: number; deleteBatchSize: number },
  ): Promise<{ deleted: number; backlog: number }> {
    const cutoff = new Date(now.getTime() - settings.processedDays * MS_PER_DAY);

    // `processed_at < cutoff` excludes unprocessed rows by three-valued logic —
    // NULL is never less than anything — so the "never delete an unprocessed
    // fragment" rule is enforced by the predicate itself rather than by a
    // separate guard that a later edit could drop. Oldest first so a backlog
    // drains in a defined order across nights.
    const expired = await this.repository.find({
      where: { processedAt: LessThan(cutoff) },
      order: { processedAt: 'ASC' },
      take: settings.deleteBatchSize,
      select: { id: true },
    });

    let deleted = 0;

    for (const fragment of expired) {
      try {
        if (await this.agentMemoryService.remove(this.systemContext, fragment.id)) {
          deleted += 1;
        }
      } catch (err) {
        // One unreapable fragment must not cost the rest of the batch. It is
        // still expired, so the next sweep picks it up again.
        this.logger.error('Failed to expire agent-memory fragment', {
          memoryId: fragment.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const backlog = await this.repository.count({ where: { processedAt: LessThan(cutoff) } });

    if (deleted > 0 || backlog > 0) {
      this.logger.log('Agent-memory retention sweep complete', {
        cutoff: cutoff.toISOString(),
        deleted,
        backlog,
      });
    }

    return { deleted, backlog };
  }

  // ---------------------------------------------------------------------------
  // Stuck pipeline — the unprocessed half
  // ---------------------------------------------------------------------------

  private async reportStuck(
    now: Date,
    settings: { stuckAfterDays: number; stuckAlertRepeatDays: number },
  ): Promise<{ stuckUsers: number; stuckFragments: number; alertsRaised: number }> {
    // With the compactor off, "unprocessed" is what every fragment is supposed
    // to be. Alerting here would report the appliance's own configuration as a
    // fault, to every user, every night.
    if (!(await this.featureService.isFeatureEnabled('agent.memory.compaction'))) {
      return { stuckUsers: 0, stuckFragments: 0, alertsRaised: 0 };
    }

    const cutoff = new Date(now.getTime() - settings.stuckAfterDays * MS_PER_DAY);
    const backlogs = await this.findStuckBacklogs(cutoff);

    const stuckUsers = backlogs.length;
    const stuckFragments = backlogs.reduce((total, backlog) => total + backlog.fragments, 0);

    if (stuckUsers === 0) {
      return { stuckUsers: 0, stuckFragments: 0, alertsRaised: 0 };
    }

    // The warning is unconditional; only the CARD is behind the flag. Turning
    // feed cards off must not turn the observation off, or the flag recreates
    // the blind spot this method exists to close — the same split
    // `RetrievalHealthCron` makes between measuring and alerting.
    this.logger.warn('Agent-memory compaction backlog is overdue', {
      stuckUsers,
      stuckFragments,
      olderThan: cutoff.toISOString(),
    });

    if (!(await this.featureService.isFeatureEnabled('actions'))) {
      return { stuckUsers, stuckFragments, alertsRaised: 0 };
    }

    let alertsRaised = 0;

    for (const backlog of backlogs) {
      try {
        if (await this.hasRecentAlert(backlog.userId, settings.stuckAlertRepeatDays)) {
          continue;
        }

        await this.actionService.create(toServiceContext({ userId: backlog.userId }), {
          title: 'Agent memory is not being processed',
          text:
            `${backlog.fragments} memory fragment${backlog.fragments === 1 ? '' : 's'} have been ` +
            `waiting since ${backlog.oldest.toISOString().slice(0, 10)} without being added to your ` +
            'knowledge graph. Nothing has been lost — the raw text is still here — but memory ' +
            'compaction has stopped keeping up.',
          // NOT 'anomaly'/'suggestion': those two share a cap of three cards a
          // local day (ActionService.countDerivedOnLocalDay), and an
          // infrastructure alert must not spend the budget the Brief's
          // anomaly and suggestion engines are counting on.
          source: 'legacy',
          metadata: {
            key: STUCK_ALERT_KEY,
            kind: 'agent_memory_retention',
            fragments: backlog.fragments,
            oldestAt: backlog.oldest.toISOString(),
          },
        });

        alertsRaised += 1;
      } catch (err) {
        // One user's failed card must not cost the others theirs.
        this.logger.error('Failed to raise agent-memory stuck alert', {
          userId: backlog.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { stuckUsers, stuckFragments, alertsRaised };
  }

  /**
   * Users whose unprocessed fragments predate the cutoff.
   *
   * Raw SQL rather than the repository because this is an aggregate over the
   * whole table and the aggregate is the answer — pulling every unprocessed row
   * into the process to count them in JS would be reading the very backlog the
   * query exists to bound. Served by `idx_agent_memories_unprocessed`.
   */
  private async findStuckBacklogs(cutoff: Date): Promise<StuckBacklog[]> {
    const rows = (await this.dataSource.query(
      `SELECT user_id            AS "userId",
              COUNT(*)::int      AS fragments,
              MIN(created_at)    AS oldest
         FROM ci.agent_memories
        WHERE processed_at IS NULL
          AND created_at < $1
        GROUP BY user_id
        ORDER BY COUNT(*) DESC`,
      [cutoff],
    )) as Array<{ userId: string; fragments: number; oldest: Date | string }>;

    return rows.map((row) => ({
      userId: row.userId,
      fragments: Number(row.fragments),
      oldest: row.oldest instanceof Date ? row.oldest : new Date(row.oldest),
    }));
  }

  /** True when this user was already told inside the repeat window, dismissed or not. */
  private async hasRecentAlert(userId: string, repeatDays: number): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT 1
         FROM ci.actions
        WHERE user_id = $1
          AND metadata->>'key' = $2
          AND created_at >= now() - make_interval(days => $3)
        LIMIT 1`,
      [userId, STUCK_ALERT_KEY, repeatDays],
    )) as unknown[];

    return rows.length > 0;
  }
}
