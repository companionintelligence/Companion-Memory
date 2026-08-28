import { PersonalizationService } from '../../services/PersonalizationService';
import { FeedQueuePopulationListener } from '../FeedQueuePopulationListener';

const USER = '00000000-0000-0000-0000-0000000000aa';
const ACTION_ID = '00000000-0000-0000-0000-0000000000bb';
const SUMMARY_ID = '00000000-0000-0000-0000-0000000000cc';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeDataSource(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  return {
    dataSource: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });

        return rows;
      }),
    },
    calls,
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function insertCalls(ds: ReturnType<typeof makeDataSource>) {
  return ds.calls.filter((call) => call.sql.includes('INSERT INTO ci.feed_queue'));
}

describe('FeedQueuePopulationListener.enqueueAction', () => {
  it('enqueues the action when the profile decision is auto', async () => {
    const ds = makeDataSource();
    const logger = makeLogger();
    // hands_off auto-promotes feed_action at confidence 0.8 (threshold 0.7).
    const personalizationService = {
      getProfile: jest.fn(async () => PersonalizationService.profileForTrustMode('hands_off')),
    };

    const listener = new FeedQueuePopulationListener(
      ds.dataSource as never,
      personalizationService as never,
      logger as never,
    );

    await listener.enqueueAction({ actionId: ACTION_ID, userId: USER });

    expect(personalizationService.getProfile).toHaveBeenCalledWith(USER);
    const inserts = insertCalls(ds);
    expect(inserts).toHaveLength(1);
    const { sql, params } = inserts[0];
    expect(sql).toContain("'action'");
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toHaveLength(3);
    expect(params[0]).toMatch(UUID_RE);
    expect(params[1]).toBe(USER);
    expect(params[2]).toBe(ACTION_ID);
  });

  it('does not enqueue when the profile decision is skip', async () => {
    const ds = makeDataSource();
    const logger = makeLogger();
    // cautious never auto-promotes feed_action (threshold 1) -> skip.
    const personalizationService = {
      getProfile: jest.fn(async () => PersonalizationService.profileForTrustMode('cautious')),
    };

    const listener = new FeedQueuePopulationListener(
      ds.dataSource as never,
      personalizationService as never,
      logger as never,
    );

    await listener.enqueueAction({ actionId: ACTION_ID, userId: USER });

    expect(insertCalls(ds)).toHaveLength(0);
  });
});

describe('FeedQueuePopulationListener.enqueueSummary', () => {
  it('enqueues the summary under its owner when found and not dismissed', async () => {
    const ds = makeDataSource([{ user_id: USER, dismissed: false }]);
    const logger = makeLogger();
    const personalizationService = { getProfile: jest.fn() };

    const listener = new FeedQueuePopulationListener(
      ds.dataSource as never,
      personalizationService as never,
      logger as never,
    );

    await listener.enqueueSummary({ summaryId: SUMMARY_ID });

    const inserts = insertCalls(ds);
    expect(inserts).toHaveLength(1);
    const { sql, params } = inserts[0];
    expect(sql).toContain("'summary'");
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toHaveLength(3);
    expect(params[0]).toMatch(UUID_RE);
    expect(params[1]).toBe(USER);
    expect(params[2]).toBe(SUMMARY_ID);
  });

  it('skips and warns when the summary row is missing', async () => {
    const ds = makeDataSource([]);
    const logger = makeLogger();
    const personalizationService = { getProfile: jest.fn() };

    const listener = new FeedQueuePopulationListener(
      ds.dataSource as never,
      personalizationService as never,
      logger as never,
    );

    await listener.enqueueSummary({ summaryId: SUMMARY_ID });

    expect(insertCalls(ds)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('Summary not found for feed queue population', {
      summaryId: SUMMARY_ID,
    });
  });

  it('skips without warning when the summary was dismissed', async () => {
    const ds = makeDataSource([{ user_id: USER, dismissed: true }]);
    const logger = makeLogger();
    const personalizationService = { getProfile: jest.fn() };

    const listener = new FeedQueuePopulationListener(
      ds.dataSource as never,
      personalizationService as never,
      logger as never,
    );

    await listener.enqueueSummary({ summaryId: SUMMARY_ID });

    expect(insertCalls(ds)).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
