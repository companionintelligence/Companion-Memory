import {
  buildZeroResultAlerts,
  MAX_ZERO_RESULT_ALERTS_PER_RUN,
  QUERY_LOG_RETENTION_DAYS,
  type RetrievalQueryWindow,
  RetrievalQueryLogService,
  ZERO_RESULT_LOOKBACK_DAYS,
  ZERO_RESULT_MIN_QUERIES,
  ZERO_RESULT_RATE_THRESHOLD,
  zeroResultAlertKey,
} from '../RetrievalQueryLogService';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-26T03:40:50.000Z');

function makeWindow(overrides: Partial<RetrievalQueryWindow> = {}): RetrievalQueryWindow {
  const total = overrides.total ?? 100;
  const zeroResults = overrides.zeroResults ?? 60;

  return {
    userId: 'user-1',
    caller: 'search',
    total,
    zeroResults,
    zeroResultRate: zeroResults / total,
    meanResultCount: 1.2,
    meanLatencyMs: 44,
    ...overrides,
  };
}

function makeService(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  const del = jest.fn().mockResolvedValue({ affected: 7 });
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new RetrievalQueryLogService({ query, delete: del } as never, logger as never);

  return { service, query, del, logger };
}

describe('RetrievalQueryLogService.summarize', () => {
  it('reads exactly the lookback window, as a bind parameter', async () => {
    const { service, query } = makeService();

    await service.summarize(NOW);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toMatch(/FROM ci\.retrieval_query_log/);
    expect(params[0]).toEqual(new Date(NOW.getTime() - ZERO_RESULT_LOOKBACK_DAYS * DAY_MS));
  });

  it('groups by CALLER as well as user, because the callers have different honest rates', async () => {
    // `search_anchored` returns nothing BY DESIGN when no term in the question
    // is selective; a `search` that finds nothing usually means an index hole.
    // Averaged together, each hides the other.
    const { service, query } = makeService();

    await service.summarize(NOW);

    const [sql] = query.mock.calls[0] as [string];

    expect(sql).toMatch(/GROUP BY user_id, caller/);
  });

  it('converts the bigint counts Postgres returns as strings, and derives the rate', async () => {
    const { service } = makeService([
      {
        user_id: 'user-1',
        caller: 'search',
        total: '80',
        zero_results: '60',
        mean_result_count: '0.5',
        mean_latency_ms: '42.5',
      },
    ]);

    const windows = await service.summarize(NOW);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toStrictEqual({
      userId: 'user-1',
      caller: 'search',
      total: 80,
      zeroResults: 60,
      zeroResultRate: 0.75,
      meanResultCount: 0.5,
      meanLatencyMs: 42.5,
    });
  });

  it('reports a zero rate rather than NaN when a group somehow has no rows', async () => {
    const { service } = makeService([
      {
        user_id: 'user-1',
        caller: 'search',
        total: '0',
        zero_results: '0',
        mean_result_count: null,
        mean_latency_ms: null,
      },
    ]);

    const [window] = await service.summarize(NOW);

    expect(window.zeroResultRate).toBe(0);
    expect(window.meanResultCount).toBe(0);
    expect(window.meanLatencyMs).toBe(0);
  });
});

describe('RetrievalQueryLogService.prune', () => {
  it('deletes by age at the retention cutoff and reports the count', async () => {
    const { service, del } = makeService();

    await expect(service.prune(NOW)).resolves.toBe(7);

    const [criteria] = del.mock.calls[0] as [{ ts: { value: Date } }];

    expect(criteria.ts.value).toEqual(new Date(NOW.getTime() - QUERY_LOG_RETENTION_DAYS * DAY_MS));
  });

  it('is 365 days, matching the retrieval-health snapshots it sits beside', () => {
    expect(QUERY_LOG_RETENTION_DAYS).toBe(365);
  });
});

describe('RetrievalQueryLogService.capture', () => {
  it('prunes even when there is nothing to alert about', async () => {
    // The prune is why the cron runs this unconditionally: a query log with a
    // conditional retention step is an unbounded query log.
    const { service, del } = makeService();

    const run = await service.capture(NOW);

    expect(del).toHaveBeenCalledTimes(1);
    expect(run.alerts).toStrictEqual([]);
    expect(run.alerts).toHaveLength(0);
    expect(run.pruned).toBe(7);
  });
});

describe('buildZeroResultAlerts', () => {
  it('raises a card when a large share of real queries came back empty', () => {
    const alerts = buildZeroResultAlerts([makeWindow({ total: 100, zeroResults: 60 })]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].userId).toBe('user-1');
    expect(alerts[0].alert.reason).toBe('zero_result_rate');
    expect(alerts[0].alert.key).toBe(zeroResultAlertKey('search'));
    // The numbers behind the claim ride on the card, so it is checkable.
    expect(alerts[0].alert.detail).toMatchObject({
      caller: 'search',
      total: 100,
      zeroResults: 60,
      lookbackDays: ZERO_RESULT_LOOKBACK_DAYS,
    });
  });

  it("carries no entityType — the card is about a person's queries, not a type", () => {
    const [alert] = buildZeroResultAlerts([makeWindow()]);

    expect(alert.alert.entityType).toBeUndefined();
  });

  it('says nothing about a window under the minimum sample size, however bad the ratio', () => {
    // 3 of 4 empty is not a 75% failure rate; it is four searches.
    const alerts = buildZeroResultAlerts([
      makeWindow({ total: ZERO_RESULT_MIN_QUERIES - 1, zeroResults: ZERO_RESULT_MIN_QUERIES - 1 }),
    ]);

    expect(alerts).toStrictEqual([]);
    expect(alerts).toHaveLength(0);
  });

  it('alerts at exactly the minimum sample size, so the floor is inclusive', () => {
    const alerts = buildZeroResultAlerts([
      makeWindow({ total: ZERO_RESULT_MIN_QUERIES, zeroResults: ZERO_RESULT_MIN_QUERIES }),
    ]);

    expect(alerts).toHaveLength(1);
  });

  it('says nothing at exactly the rate threshold — a personal archive cannot answer everything', () => {
    const alerts = buildZeroResultAlerts([
      makeWindow({ total: 100, zeroResults: ZERO_RESULT_RATE_THRESHOLD * 100 }),
    ]);

    expect(alerts).toStrictEqual([]);
    expect(alerts).toHaveLength(0);
  });

  it('caps a wiped index at a handful of cards rather than one per caller', () => {
    const windows = ['search', 'search_prompt', 'search_messages', 'search_anchored', 'recall'].map(
      (caller) => makeWindow({ caller, total: 100, zeroResults: 100 }),
    );

    const alerts = buildZeroResultAlerts(windows);

    expect(alerts).toHaveLength(MAX_ZERO_RESULT_ALERTS_PER_RUN);
  });

  it('keeps the WORST windows when it truncates, not the first ones it saw', () => {
    const windows = [
      makeWindow({ caller: 'a', total: 100, zeroResults: 45 }),
      makeWindow({ caller: 'b', total: 100, zeroResults: 50 }),
      makeWindow({ caller: 'c', total: 100, zeroResults: 99 }),
      makeWindow({ caller: 'd', total: 100, zeroResults: 90 }),
      makeWindow({ caller: 'e', total: 100, zeroResults: 80 }),
    ];

    const alerts = buildZeroResultAlerts(windows);

    expect(alerts.map((entry) => entry.alert.detail.caller)).toStrictEqual(['c', 'd', 'e']);
  });

  it('keys the card per caller, so two callers do not dedupe each other away', () => {
    const alerts = buildZeroResultAlerts([
      makeWindow({ caller: 'search', total: 100, zeroResults: 90 }),
      makeWindow({ caller: 'recall', total: 100, zeroResults: 95 }),
    ]);

    expect(new Set(alerts.map((entry) => entry.alert.key)).size).toBe(2);
  });

  it('attributes each card to the user whose queries produced it', () => {
    const alerts = buildZeroResultAlerts([
      makeWindow({ userId: 'user-1', caller: 'search', total: 100, zeroResults: 95 }),
      makeWindow({ userId: 'user-2', caller: 'recall', total: 100, zeroResults: 90 }),
    ]);

    expect(alerts.map((entry) => entry.userId)).toStrictEqual(['user-1', 'user-2']);
  });
});
