import { ENTITY_SOURCE_MAP } from '@ci/domains/search-ingress';
import { INDEXABLE_ENTITIES } from '@ci/domains/search-next';

import {
  buildCoverage,
  buildIndexHealth,
  DEFAULT_COVERAGE_BUDGET_MS,
  DEFAULT_HEALTH_SWEEP_BUDGET_MS,
  EmbedCoverageTelemetryService,
  UNDER_COVERAGE_THRESHOLD,
} from './EmbedCoverageTelemetryService';

/**
 * Build a DataSource whose pinned query runner returns COUNT rows keyed on the
 * type being measured. `sourceCounts`/`embeddedCounts` map entity_type -> count.
 *
 * The service issues two shapes of COUNT query per type:
 *   - source total: `... FROM "<schema>"."<table>" [WHERE <disc> = $1]`
 *   - embedded:     `... FROM ci_search.embeddings WHERE entity_type = $1`
 * We disambiguate on whether the SQL targets `ci_search.embeddings`, and read
 * the type from either the (source) table name or the (embedded) bound param.
 *
 * `dataSource.query` throws: like the health sweep, the coverage sweep must run
 * on its own connection rather than spreading counts across the shared pool.
 */
function makeDataSource(
  sourceCounts: Record<string, number>,
  embeddedCounts: Record<string, number>,
  onCount?: (sql: string) => void,
) {
  const statements: string[] = [];

  // Map each source table (+discriminator value) back to the entity_type so the
  // source-count query can be resolved. Mirrors ENTITY_SOURCE_MAP.
  const runner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);

      if (sql.startsWith('SET ') || sql.startsWith('RESET ')) {
        return [];
      }

      onCount?.(sql);

      if (sql.includes('ci_search.embeddings')) {
        const entityType = params[0] as string;

        return [{ count: String(embeddedCounts[entityType] ?? 0) }];
      }

      // Source-total query. Identify the type from table + optional discriminator.
      const entityType = resolveSourceType(sql, params);

      return [{ count: String(sourceCounts[entityType] ?? 0) }];
    }),
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
    query: jest.fn(async () => {
      throw new Error('the coverage sweep must run on its own pinned connection');
    }),
  };

  return { dataSource, runner, statements };
}

/** Recover the entity_type a source-count SQL string is measuring. */
function resolveSourceType(sql: string, params: unknown[]): string {
  const disc = params[0] as string | undefined;
  if (sql.includes('"entities"')) {
    // Shared table: discriminator (Concept/Person/Location/File) selects the type.
    switch (disc) {
      case 'Concept':
        return 'concept';
      case 'Person':
        return 'person';
      case 'Location':
        return 'place';
      case 'File':
        return 'file';
      default:
        return 'unknown';
    }
  }

  if (sql.includes('"communications"')) {
    return 'communication';
  }

  if (sql.includes('"content"')) {
    return 'content';
  }

  if (sql.includes('"events"')) {
    return 'event';
  }

  if (sql.includes('"objects"')) {
    return 'item';
  }

  if (sql.includes('"agent_memories"')) {
    return 'message';
  }

  if (sql.includes('"notes"')) {
    return 'note';
  }

  if (sql.includes('"threads"')) {
    return 'thread';
  }

  if (sql.includes('"answers"')) {
    return 'answer';
  }

  if (sql.includes('"browser_activity"')) {
    return 'browser-activity';
  }

  return 'unknown';
}

function makeService(
  sourceCounts: Record<string, number>,
  embeddedCounts: Record<string, number>,
  onCount?: (sql: string) => void,
) {
  const { dataSource, runner, statements } = makeDataSource(sourceCounts, embeddedCounts, onCount);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new EmbedCoverageTelemetryService(dataSource as any, logger as any);

  return { service, dataSource, runner, statements, logger };
}

describe('buildCoverage', () => {
  it('computes ratio embedded/total; a partially-covered type does not alarm but IS under threshold', () => {
    // 6.5% covered: not a total hole (alarm false), but well under the 90% target.
    expect(buildCoverage(42376, 2743)).toEqual({
      total: 42376,
      embedded: 2743,
      ratio: 2743 / 42376,
      alarm: false,
      underThreshold: true,
    });
  });

  it('reports ratio 0 and NO alarm/underThreshold for an empty type (no divide-by-zero)', () => {
    expect(buildCoverage(0, 0)).toEqual({
      total: 0,
      embedded: 0,
      ratio: 0,
      alarm: false,
      underThreshold: false,
    });
  });

  it('alarms AND flags underThreshold when there ARE source rows but zero embeddings (gap G2)', () => {
    expect(buildCoverage(366862, 0)).toEqual({
      total: 366862,
      embedded: 0,
      ratio: 0,
      alarm: true,
      underThreshold: true,
    });
  });

  it('does not flag a well-covered type (ratio >= threshold)', () => {
    const coverage = buildCoverage(1000, 950); // 95% >= 90%
    expect(coverage.alarm).toBe(false);
    expect(coverage.underThreshold).toBe(false);
  });

  it('flags underThreshold just below the threshold and not just above it', () => {
    expect(buildCoverage(1000, 899).underThreshold).toBe(true); // 89.9% < 90%
    expect(buildCoverage(1000, 900).underThreshold).toBe(false); // exactly 90% is covered
  });

  it('honours a custom threshold', () => {
    // 50% coverage: under a 0.9 target, but fine under a 0.4 target.
    expect(buildCoverage(100, 50, 0.9).underThreshold).toBe(true);
    expect(buildCoverage(100, 50, 0.4).underThreshold).toBe(false);
  });

  it('exports a sane default threshold', () => {
    expect(UNDER_COVERAGE_THRESHOLD).toBeGreaterThan(0);
    expect(UNDER_COVERAGE_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('clamps ratio to [0, 1] even if embedded transiently exceeds total', () => {
    // A backfill in flight can momentarily embed more rows than the source count
    // snapshot; the ratio must not report > 1.
    expect(buildCoverage(10, 12).ratio).toBe(1);
    expect(buildCoverage(10, 12).underThreshold).toBe(false);
  });
});

describe('EmbedCoverageTelemetryService', () => {
  it('produces a per-type report with ratios in [0, 1] and flags zero-coverage types', async () => {
    const { service } = makeService(
      { content: 366862, event: 42376, communication: 767000 },
      { content: 0, event: 2743, communication: 767000 },
    );

    const report = await service.computeCoverage(['content', 'event', 'communication']);

    expect(report.perType.content).toEqual({
      total: 366862,
      embedded: 0,
      ratio: 0,
      alarm: true,
      underThreshold: true,
    });
    expect(report.perType.event.ratio).toBeCloseTo(0.0647, 3);
    expect(report.perType.communication.ratio).toBe(1);

    for (const coverage of Object.values(report.perType)) {
      expect(coverage.ratio).toBeGreaterThanOrEqual(0);
      expect(coverage.ratio).toBeLessThanOrEqual(1);
    }

    // Only content tripped the zero-coverage alarm...
    expect(report.alarms).toEqual(['content']);
    // ...but both content (0%) and event (6.5%) are under the coverage target,
    // while the fully-covered communication type is not.
    expect(report.underThreshold.sort()).toEqual(['content', 'event']);
    expect(typeof report.computedAt).toBe('string');
  });

  it('defaults to every indexable type when none are requested', async () => {
    const { service } = makeService({}, {});

    const report = await service.computeCoverage();

    // All 13 indexable types measured; empty corpus => every ratio 0, no alarms.
    expect(Object.keys(report.perType)).toEqual(
      expect.arrayContaining(['content', 'event', 'communication', 'person', 'place', 'concept', 'file']),
    );
    expect(report.alarms).toEqual([]);
  });

  it('logs a warning when any type trips the zero-coverage alarm', async () => {
    const { service, logger } = makeService({ content: 100 }, { content: 0 });

    await service.computeCoverage(['content']);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Embed-coverage alarm'), {
      alarms: ['content'],
    });
  });

  it('logs a separate below-target warning for partially-covered (non-zero) types', async () => {
    // 40% covered: not a zero-hole, so it must NOT show up in the alarm warning,
    // but it IS under the 90% target and should be surfaced separately.
    const { service, logger } = makeService({ content: 100 }, { content: 40 });

    const report = await service.computeCoverage(['content']);

    expect(report.alarms).toEqual([]);
    expect(report.underThreshold).toEqual(['content']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('below target'), {
      underThreshold: ['content'],
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Embed-coverage alarm'),
      expect.anything(),
    );
  });

  it('runs on ONE pinned connection under a statement timeout, and resets it', async () => {
    const { service, dataSource, runner, statements } = makeService({ content: 10 }, { content: 10 });

    await service.computeCoverage(['content'], { statementTimeoutMs: 5000 });

    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(statements[0]).toBe('SET statement_timeout = 5000');
    expect(statements).toContain('RESET statement_timeout');
    expect(runner.release).toHaveBeenCalledTimes(1);
    // Never the shared pool helper: two concurrent counts per type out of the
    // 25-connection pool is what this endpoint used to do.
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  /**
   * Same reasoning as the health sweep, one degree sharper: this one answers an
   * HTTP request, so an unbounded run holds a pooled connection on behalf of a
   * caller who is no longer there. A single slow COUNT must not be able to take
   * the rest of the sweep with it, and the run must abandon rather than return
   * the types it managed — a partial snapshot reads as a coverage collapse.
   */
  it('abandons the sweep once the wall-clock budget is spent, mid-run', async () => {
    const nowSpy = jest.spyOn(Date, 'now');

    try {
      let clock = 1_000_000;
      nowSpy.mockImplementation(() => clock);

      const counted: string[] = [];
      const { service, runner, statements } = makeService(
        { content: 10, event: 10, communication: 10 },
        { content: 10, event: 10, communication: 10 },
        (sql) => {
          counted.push(sql);
          // Each count burns 400ms of the 1000ms budget.
          clock += 400;
        },
      );

      await expect(
        service.computeCoverage(['content', 'event', 'communication'], { budgetMs: 1000 }),
      ).rejects.toThrow(/wall-clock budget spent after 1\/3 types/);

      // content's two counts fit (0/400ms in) and so does event's first (800ms);
      // event's second is refused at 1200ms rather than issued and paid for.
      expect(counted).toHaveLength(3);
      // The connection still goes back clean — the budget bounds the hold, it is
      // not a way to leak one.
      expect(statements).toContain('RESET statement_timeout');
      expect(runner.release).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('defaults to a budget an HTTP caller could still be waiting on', () => {
    expect(DEFAULT_COVERAGE_BUDGET_MS).toBeGreaterThan(0);
    expect(DEFAULT_COVERAGE_BUDGET_MS).toBeLessThan(DEFAULT_HEALTH_SWEEP_BUDGET_MS);
  });

  /**
   * `file`'s source total must apply `backfillPredicate`, not just
   * `discriminator` (it has none) — otherwise the denominator includes the
   * derived PREVIEW variants and soft-deleted rows the pipeline/backfill
   * deliberately never index, capping the ratio below a reachable 100%.
   */
  it("applies the source map's backfillPredicate to the file total, excluding PREVIEW/soft-deleted rows", async () => {
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    // ci.files holds 10 rows: 6 ORIGINAL+live (indexable) and 4 PREVIEW/soft-deleted
    // (must be excluded by backfillPredicate). All 6 indexable rows are embedded.
    const runner = {
      connect: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SET ') || sql.startsWith('RESET ')) {
          return [];
        }

        if (sql.includes('ci_search.embeddings')) {
          return [{ count: '6' }];
        }

        // Source-total query for `file`: assert the backfill predicate is
        // actually part of the WHERE clause, then answer as a real DB would
        // with it applied (6 of the 10 rows survive the filter).
        expect(sql).toContain('"ci"."files"');
        expect(sql).toContain(ENTITY_SOURCE_MAP.file.backfillPredicate);

        return [{ count: '6' }];
      }),
    };

    const dataSource = {
      createQueryRunner: jest.fn(() => runner),
      query: jest.fn(async () => {
        throw new Error('the coverage sweep must run on its own pinned connection');
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new EmbedCoverageTelemetryService(dataSource as any, logger as any);

    const report = await service.computeCoverage(['file']);

    expect(report.perType.file).toEqual({
      total: 6,
      embedded: 6,
      ratio: 1,
      alarm: false,
      underThreshold: false,
    });
  });
});

/**
 * A DataSource whose `createQueryRunner()` answers all three COUNT shapes the
 * both-tables sweep issues, and records the session statements it ran, so the
 * timeout guard and the runner lifecycle are observable.
 */
function makeHealthDataSource(
  sourceCounts: Record<string, number>,
  embeddedCounts: Record<string, number>,
  vectorCounts: Record<string, number>,
  onCount?: (sql: string) => void,
) {
  const statements: string[] = [];

  const runner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);

      if (sql.startsWith('SET ') || sql.startsWith('RESET ')) {
        return [];
      }

      onCount?.(sql);

      if (sql.includes('ci_search.embeddings')) {
        return [{ count: String(embeddedCounts[params[0] as string] ?? 0) }];
      }

      if (sql.includes('ci_search.vectors')) {
        return [{ count: String(vectorCounts[params[0] as string] ?? 0) }];
      }

      return [{ count: String(sourceCounts[resolveSourceType(sql, params)] ?? 0) }];
    }),
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
    query: jest.fn(async () => {
      throw new Error('the health sweep must run on its own pinned connection');
    }),
  };

  return { dataSource, runner, statements };
}

function makeHealthService(
  sourceCounts: Record<string, number>,
  embeddedCounts: Record<string, number>,
  vectorCounts: Record<string, number>,
  onCount?: (sql: string) => void,
) {
  const { dataSource, runner, statements } = makeHealthDataSource(
    sourceCounts,
    embeddedCounts,
    vectorCounts,
    onCount,
  );
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new EmbedCoverageTelemetryService(dataSource as any, logger as any);

  return { service, dataSource, runner, statements, logger };
}

describe('buildIndexHealth', () => {
  /**
   * The whole reason this exists. `ci_search.vectors` is the search CANDIDATE
   * source; `ci_search.embeddings` only re-ranks. A type whose embeddings are
   * complete and whose vectors are absent scores a perfect embed ratio, trips
   * no coverage alarm, and answers no search — and because the backfill sweep
   * anti-joins on embeddings, it will never self-heal. If this case does not
   * raise a flag of its own, the report is confidently wrong.
   */
  it('flags a type that is 100% embedded but has NO vectors (reads healthy, invisible to search)', () => {
    const health = buildIndexHealth(366862, 366862, 0);

    expect(health.ratio).toBe(1);
    expect(health.alarm).toBe(false);
    expect(health.underThreshold).toBe(false);

    expect(health.vectored).toBe(0);
    expect(health.vectorRatio).toBe(0);
    expect(health.vectorAlarm).toBe(true);
    expect(health.divergence).toBe(1);
    expect(health.divergent).toBe(true);
  });

  it('does not flag an empty type on either side', () => {
    const health = buildIndexHealth(0, 0, 0);

    expect(health.vectorAlarm).toBe(false);
    expect(health.divergent).toBe(false);
    expect(health.divergence).toBe(0);
  });

  it('tolerates in-flight skew between the two tables but flags a real gap', () => {
    // 1% behind: one listener mid-write, not a hole.
    expect(buildIndexHealth(1000, 1000, 990).divergent).toBe(false);
    // 20% behind: a fifth of the type cannot be found.
    expect(buildIndexHealth(1000, 1000, 800).divergent).toBe(true);
  });

  it('is symmetric — vectors ahead of embeddings diverges too', () => {
    const health = buildIndexHealth(1000, 500, 1000);

    expect(health.divergence).toBeCloseTo(0.5, 6);
    expect(health.divergent).toBe(true);
    expect(health.vectorAlarm).toBe(false);
  });

  it('keeps every buildCoverage rule on the embedding side', () => {
    expect(buildIndexHealth(42376, 2743, 42376)).toMatchObject({
      total: 42376,
      embedded: 2743,
      ratio: 2743 / 42376,
      alarm: false,
      underThreshold: true,
    });
  });
});

describe('EmbedCoverageTelemetryService.computeIndexHealth', () => {
  it('counts BOTH index tables per type and reports the vector hole separately', async () => {
    const { service } = makeHealthService(
      { content: 366862, event: 42376 },
      { content: 366862, event: 42376 },
      { content: 0, event: 42376 },
    );

    const report = await service.computeIndexHealth(['content', 'event']);

    expect(report.perType.content.embedded).toBe(366862);
    expect(report.perType.content.vectored).toBe(0);
    // Nothing on the embedding side is wrong, which is exactly the trap.
    expect(report.alarms).toEqual([]);
    expect(report.underThreshold).toEqual([]);
    // ...and the vector side is the alarm.
    expect(report.vectorAlarms).toEqual(['content']);
    expect(report.divergent).toEqual(['content']);
  });

  it('measures every indexable type by default', async () => {
    const { service } = makeHealthService({}, {}, {});

    const report = await service.computeIndexHealth();

    expect(Object.keys(report.perType)).toHaveLength(INDEXABLE_ENTITIES.length);
  });

  it('runs on ONE pinned connection under a statement timeout, and resets it', async () => {
    const { service, dataSource, runner, statements } = makeHealthService(
      { content: 10 },
      { content: 10 },
      { content: 10 },
    );

    await service.computeIndexHealth(['content'], { statementTimeoutMs: 5000 });

    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(statements[0]).toBe('SET statement_timeout = 5000');
    expect(statements).toContain('RESET statement_timeout');
    expect(runner.release).toHaveBeenCalledTimes(1);
    // Never the shared pool helper: that is what would spread the sweep across
    // connections instead of pinning it to one.
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('releases the connection even when a count throws', async () => {
    const { service, runner } = makeHealthService({ content: 10 }, {}, {}, (sql) => {
      if (sql.includes('ci_search.vectors')) {
        throw new Error('canceling statement due to statement timeout');
      }
    });

    await expect(service.computeIndexHealth(['content'])).rejects.toThrow(/statement timeout/);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  /**
   * The per-statement timeout bounds ONE count, not the run: 54 counts each
   * finishing just inside a 120s timeout would hold a pooled connection for
   * ~1.8 hours. The wall-clock budget is what actually caps the hold, so it
   * has to be checked before issuing the next count and has to abandon the run
   * rather than return the types it managed to measure — a partial snapshot
   * reads as a coverage collapse.
   */
  it('abandons the sweep once the wall-clock budget is spent, mid-run', async () => {
    const nowSpy = jest.spyOn(Date, 'now');

    try {
      let clock = 1_000_000;
      nowSpy.mockImplementation(() => clock);

      const counted: string[] = [];
      const { service, runner, statements } = makeHealthService(
        { content: 10, event: 10, communication: 10 },
        { content: 10, event: 10, communication: 10 },
        { content: 10, event: 10, communication: 10 },
        (sql) => {
          counted.push(sql);
          // Each count burns 400ms of the 1000ms budget.
          clock += 400;
        },
      );

      await expect(
        service.computeIndexHealth(['content', 'event', 'communication'], { budgetMs: 1000 }),
      ).rejects.toThrow(/wall-clock budget spent after 1\/3 types/);

      // content's three counts fit (0/400/800ms in); event's first is refused
      // at 1200ms rather than issued and paid for.
      expect(counted).toHaveLength(3);
      // The connection still goes back clean — the budget is a bound on the
      // hold, not a way to leak one.
      expect(statements).toContain('RESET statement_timeout');
      expect(runner.release).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('completes normally when the sweep fits inside its budget', async () => {
    const { service } = makeHealthService({ content: 10 }, { content: 10 }, { content: 10 });

    const report = await service.computeIndexHealth(['content'], { budgetMs: 60_000 });

    expect(report.perType.content.total).toBe(10);
  });

  it('defaults the budget well above the real cost of a sweep', () => {
    expect(DEFAULT_HEALTH_SWEEP_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('warns about the invisible-to-search types by name', async () => {
    const { service, logger } = makeHealthService({ content: 100 }, { content: 100 }, { content: 0 });

    await service.computeIndexHealth(['content']);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('NO search vectors'), {
      vectorAlarms: ['content'],
    });
  });
});
