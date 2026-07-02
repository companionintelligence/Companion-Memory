import { buildCoverage, EmbedCoverageTelemetryService } from './EmbedCoverageTelemetryService';

/**
 * Build a DataSource whose `query` returns COUNT rows keyed on the type being
 * measured. `sourceCounts`/`embeddedCounts` map entity_type -> count.
 *
 * The service issues two shapes of COUNT query per type:
 *   - source total: `... FROM "<schema>"."<table>" [WHERE <disc> = $1]`
 *   - embedded:     `... FROM ci_search.embeddings WHERE entity_type = $1`
 * We disambiguate on whether the SQL targets `ci_search.embeddings`, and read
 * the type from either the (source) table name or the (embedded) bound param.
 */
function makeDataSource(
  sourceCounts: Record<string, number>,
  embeddedCounts: Record<string, number>,
) {
  // Map each source table (+discriminator value) back to the entity_type so the
  // source-count query can be resolved. Mirrors ENTITY_SOURCE_MAP.
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('ci_search.embeddings')) {
      const entityType = params[0] as string;

      return [{ count: String(embeddedCounts[entityType] ?? 0) }];
    }

    // Source-total query. Identify the type from table + optional discriminator.
    const entityType = resolveSourceType(sql, params);

    return [{ count: String(sourceCounts[entityType] ?? 0) }];
  });

  return { query } as const;
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

  if (sql.includes('"communications"')) {return 'communication';}

  if (sql.includes('"content"')) {return 'content';}

  if (sql.includes('"events"')) {return 'event';}

  if (sql.includes('"inventory"')) {return 'item';}

  if (sql.includes('"agent_memories"')) {return 'message';}

  if (sql.includes('"notes"')) {return 'note';}

  if (sql.includes('"threads"')) {return 'thread';}

  if (sql.includes('"answers"')) {return 'answer';}

  if (sql.includes('"browser_activity"')) {return 'browser-activity';}

  return 'unknown';
}

function makeService(
  sourceCounts: Record<string, number>,
  embeddedCounts: Record<string, number>,
) {
  const ds = makeDataSource(sourceCounts, embeddedCounts);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new EmbedCoverageTelemetryService(ds as any, logger as any);

  return { service, ds, logger };
}

describe('buildCoverage', () => {
  it('computes ratio embedded/total and never alarms on a covered type', () => {
    expect(buildCoverage(42376, 2743)).toEqual({
      total: 42376,
      embedded: 2743,
      ratio: 2743 / 42376,
      alarm: false,
    });
  });

  it('reports ratio 0 and NO alarm for an empty type (no divide-by-zero)', () => {
    expect(buildCoverage(0, 0)).toEqual({ total: 0, embedded: 0, ratio: 0, alarm: false });
  });

  it('alarms only when there ARE source rows but zero embeddings (gap G2)', () => {
    expect(buildCoverage(366862, 0)).toEqual({
      total: 366862,
      embedded: 0,
      ratio: 0,
      alarm: true,
    });
  });

  it('clamps ratio to [0, 1] even if embedded transiently exceeds total', () => {
    // A backfill in flight can momentarily embed more rows than the source count
    // snapshot; the ratio must not report > 1.
    expect(buildCoverage(10, 12).ratio).toBe(1);
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
    });
    expect(report.perType.event.ratio).toBeCloseTo(0.0647, 3);
    expect(report.perType.communication.ratio).toBe(1);

    for (const coverage of Object.values(report.perType)) {
      expect(coverage.ratio).toBeGreaterThanOrEqual(0);
      expect(coverage.ratio).toBeLessThanOrEqual(1);
    }

    // Only content tripped the zero-coverage alarm.
    expect(report.alarms).toEqual(['content']);
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

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Embed-coverage alarm'),
      { alarms: ['content'] },
    );
  });
});
