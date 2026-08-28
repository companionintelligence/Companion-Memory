import type { FindOperator } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';

import { AgentMemoryRetentionService, STUCK_ALERT_KEY } from '../AgentMemoryRetentionService';

/**
 * Retention for `ci.agent_memories`.
 *
 * Three claims carry the whole policy and each is asserted here rather than
 * left to the docblock:
 *
 *  1. An UNPROCESSED fragment is never a deletion candidate. It is the only
 *     copy of text nothing has promoted into the graph, so this is enforced in
 *     the predicate itself (`processed_at < cutoff` is NULL-false), and the
 *     test reads the predicate rather than counting deletes on a fixture that
 *     happens to contain none.
 *  2. Every delete goes through `AgentMemoryService.remove`, which is the only
 *     thing that emits the event reaping the fragment's
 *     `ci_search.embeddings` row. A bulk DELETE would pass a "did it delete"
 *     test and silently orphan the index.
 *  3. The stuck-pipeline alert stays quiet while `agent.memory.compaction` is
 *     off, because with the compactor disabled "unprocessed" is what every
 *     fragment is supposed to be.
 */

const USER_A = '00000000-0000-0000-0000-0000000000aa';
const USER_B = '00000000-0000-0000-0000-0000000000bb';

const NOW = new Date('2026-08-26T02:20:33.000Z');
const DEFAULTS = { ...config.agent.memoryRetention };

/** SQL routing — the sweep issues two different raw queries. */
function isBacklogQuery(sql: string): boolean {
  return sql.includes('FROM ci.agent_memories');
}

interface HarnessOptions {
  expired?: Array<{ id: string }>;
  backlogAfterDelete?: number;
  stuck?: Array<{ userId: string; fragments: number; oldest: Date }>;
  alreadyAlerted?: string[];
  compactionEnabled?: boolean;
  actionsEnabled?: boolean;
}

function build(options: HarnessOptions = {}) {
  const {
    expired = [],
    backlogAfterDelete = 0,
    stuck = [],
    alreadyAlerted = [],
    compactionEnabled = true,
    actionsEnabled = true,
  } = options;

  const repository = {
    find: jest.fn(async (_options: unknown) => expired),
    count: jest.fn(async (_options: unknown) => backlogAfterDelete),
  };

  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });

      if (isBacklogQuery(sql)) {
        return stuck.map((row) => ({
          userId: row.userId,
          fragments: row.fragments,
          oldest: row.oldest,
        }));
      }

      // The ci.actions repeat probe: one row means "already told this user".
      return alreadyAlerted.includes(params[0] as string) ? [{ '?column?': 1 }] : [];
    }),
  };

  const agentMemoryService = { remove: jest.fn(async (_context: unknown, _id: string) => true) };
  const actionService = { create: jest.fn(async (_context: unknown, _dto: unknown) => ({})) };
  const featureService = {
    isFeatureEnabled: jest.fn(async (flag: string) =>
      flag === 'agent.memory.compaction' ? compactionEnabled : actionsEnabled,
    ),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const service = new AgentMemoryRetentionService(
    repository as never,
    dataSource as never,
    agentMemoryService as never,
    actionService as never,
    featureService as never,
    logger as never,
  );

  return { service, repository, dataSource, agentMemoryService, actionService, logger, queries };
}

/** The `processed_at` predicate the expiry SELECT was built with. */
function processedAtPredicate(repository: { find: jest.Mock }): FindOperator<Date> {
  const where = (repository.find.mock.calls[0][0] as { where: { processedAt: FindOperator<Date> } }).where;

  return where.processedAt;
}

afterEach(() => {
  Object.assign(config.agent.memoryRetention, DEFAULTS);
});

describe('AgentMemoryRetentionService expiry', () => {
  it('only ever considers rows with processed_at STRICTLY BELOW the cutoff, so NULL never matches', async () => {
    const { service, repository } = build();

    await service.sweep(NOW);

    const predicate = processedAtPredicate(repository);

    // `lessThan` is the whole safety mechanism: Postgres evaluates
    // `NULL < timestamp` to NULL, not true, so an unprocessed fragment cannot
    // be selected however old it is. Any other operator (IsNull, Not, a raw
    // `<=` over a coalesce) would break that.
    expect(predicate.type).toBe('lessThan');
    expect(predicate.value).toEqual(new Date('2025-08-26T02:20:33.000Z'));
  });

  it('measures the cutoff from processedDays, oldest first, capped at deleteBatchSize', async () => {
    Object.assign(config.agent.memoryRetention, { processedDays: 30, deleteBatchSize: 7 });

    const { service, repository } = build();

    await service.sweep(NOW);

    expect(processedAtPredicate(repository).value).toEqual(new Date('2026-07-27T02:20:33.000Z'));
    expect(repository.find.mock.calls[0][0]).toMatchObject({
      order: { processedAt: 'ASC' },
      take: 7,
    });
  });

  it('deletes through AgentMemoryService.remove so the search embedding is reaped with the row', async () => {
    const { service, agentMemoryService } = build({
      expired: [{ id: 'frag-1' }, { id: 'frag-2' }, { id: 'frag-3' }],
    });

    const result = await service.sweep(NOW);

    expect(agentMemoryService.remove.mock.calls).toHaveLength(3);
    expect(agentMemoryService.remove.mock.calls.map((call) => call[1])).toStrictEqual([
      'frag-1',
      'frag-2',
      'frag-3',
    ]);
    // SYSTEM_USER, not an owner: the sweep runs across every user's fragments.
    expect(agentMemoryService.remove.mock.calls[0][0]).toEqual({ userId: SYSTEM_USER });
    expect(result.deleted).toBe(3);
  });

  it('counts only rows that were really there, and keeps going when one fails', async () => {
    const { service, agentMemoryService, logger } = build({
      expired: [{ id: 'gone' }, { id: 'boom' }, { id: 'fine' }],
    });

    agentMemoryService.remove
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce(true);

    const result = await service.sweep(NOW);

    expect(result.deleted).toBe(1);
    expect(agentMemoryService.remove.mock.calls).toHaveLength(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports the backlog left over the window after the batch cap', async () => {
    const { service } = build({ expired: [{ id: 'frag-1' }], backlogAfterDelete: 4_312 });

    await expect(service.sweep(NOW)).resolves.toMatchObject({ deleted: 1, backlog: 4_312 });
  });

  it('deletes nothing and reads nothing when retention is disabled', async () => {
    Object.assign(config.agent.memoryRetention, { enabled: false });

    const { service, repository, dataSource, agentMemoryService } = build({
      expired: [{ id: 'frag-1' }],
      stuck: [{ userId: USER_A, fragments: 9, oldest: new Date('2026-01-01T00:00:00.000Z') }],
    });

    await expect(service.sweep(NOW)).resolves.toStrictEqual({
      enabled: false,
      deleted: 0,
      backlog: 0,
      stuckUsers: 0,
      stuckFragments: 0,
      alertsRaised: 0,
    });
    expect(repository.find).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(agentMemoryService.remove).not.toHaveBeenCalled();
  });
});

describe('AgentMemoryRetentionService stuck-pipeline signal', () => {
  const backlogs = [
    { userId: USER_A, fragments: 812, oldest: new Date('2026-07-01T09:00:00.000Z') },
    { userId: USER_B, fragments: 4, oldest: new Date('2026-08-01T09:00:00.000Z') },
  ];

  it('stays silent while agent.memory.compaction is off — unprocessed is then the steady state', async () => {
    const { service, dataSource, actionService, logger, queries } = build({
      stuck: backlogs,
      compactionEnabled: false,
    });

    const result = await service.sweep(NOW);

    expect(queries.filter((query) => isBacklogQuery(query.sql))).toHaveLength(0);
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(actionService.create).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stuckUsers: 0, stuckFragments: 0, alertsRaised: 0 });
  });

  it('asks only for unprocessed rows older than stuckAfterDays', async () => {
    Object.assign(config.agent.memoryRetention, { stuckAfterDays: 3 });

    const { service, queries } = build({ stuck: backlogs });

    await service.sweep(NOW);

    const backlogQuery = queries.find((query) => isBacklogQuery(query.sql));

    expect(backlogQuery?.sql).toContain('processed_at IS NULL');
    expect(backlogQuery?.params).toStrictEqual([new Date('2026-08-23T02:20:33.000Z')]);
  });

  it('raises one deduped card per user and totals the backlog', async () => {
    const { service, actionService } = build({ stuck: backlogs });

    const result = await service.sweep(NOW);

    expect(result).toMatchObject({ stuckUsers: 2, stuckFragments: 816, alertsRaised: 2 });
    expect(actionService.create.mock.calls).toHaveLength(2);

    const [context, dto] = actionService.create.mock.calls[0] as [
      { userId: string },
      { source: string; metadata: Record<string, unknown> },
    ];

    expect(context.userId).toBe(USER_A);
    // 'legacy', not 'anomaly'/'suggestion': those share a three-a-day cap that
    // an infrastructure alert must not spend.
    expect(dto.source).toBe('legacy');
    expect(dto.metadata).toMatchObject({ key: STUCK_ALERT_KEY, fragments: 812 });
  });

  it('does not re-tell a user inside the repeat window', async () => {
    const { service, actionService } = build({ stuck: backlogs, alreadyAlerted: [USER_A] });

    const result = await service.sweep(NOW);

    // Both users are still counted as stuck; only the card is suppressed.
    expect(result).toMatchObject({ stuckUsers: 2, alertsRaised: 1 });
    expect(actionService.create.mock.calls).toHaveLength(1);
    expect((actionService.create.mock.calls[0][0] as { userId: string }).userId).toBe(USER_B);
  });

  it('still measures and warns when feed cards are switched off', async () => {
    const { service, actionService, logger } = build({ stuck: backlogs, actionsEnabled: false });

    const result = await service.sweep(NOW);

    expect(result).toMatchObject({ stuckUsers: 2, stuckFragments: 816, alertsRaised: 0 });
    expect(actionService.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('says nothing when nothing is overdue', async () => {
    const { service, actionService, logger } = build({ stuck: [] });

    await expect(service.sweep(NOW)).resolves.toMatchObject({ stuckUsers: 0, alertsRaised: 0 });
    expect(actionService.create).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
