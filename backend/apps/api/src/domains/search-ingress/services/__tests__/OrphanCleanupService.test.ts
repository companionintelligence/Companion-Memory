import type { DataSource } from 'typeorm';

import { OrphanCleanupService } from '../OrphanCleanupService';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** Normalise whitespace so SQL assertions are not indentation-sensitive. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('OrphanCleanupService.cleanOrphans', () => {
  it('builds a NOT EXISTS delete against the right source table/id for a single-type entity', async () => {
    // node-pg DELETE result shape: [rows, affectedCount]. Return 0 so each
    // (table,type) does exactly one statement and the loop exits.
    const query = jest.fn().mockResolvedValue([[], 0]);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    await service.cleanOrphans({ entityTypes: ['event'], batchSize: 1000 });

    // Two statements: one for embeddings, one for vectors.
    expect(query).toHaveBeenCalledTimes(2);

    const [embSql, embParams] = query.mock.calls[0];
    expect(flat(embSql)).toContain('DELETE FROM "ci_search"."embeddings"');
    expect(flat(embSql)).toContain('FROM "ci_search"."embeddings" s');
    expect(flat(embSql)).toContain('WHERE s.entity_type = $1');
    expect(flat(embSql)).toContain('NOT EXISTS (SELECT 1 FROM "ci"."events" src');
    expect(flat(embSql)).toContain('src."event_id"::text = s.entity_id::text');
    expect(flat(embSql)).toContain('LIMIT 1000');
    // No discriminator → only the entity_type param.
    expect(embParams).toEqual(['event']);

    const [vecSql] = query.mock.calls[1];
    expect(flat(vecSql)).toContain('DELETE FROM "ci_search"."vectors"');
    expect(flat(vecSql)).toContain('FROM "ci"."events" src');
  });

  it('adds the discriminator predicate + param for entities sharing ci.entities', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    await service.cleanOrphans({ entityTypes: ['person'], batchSize: 500 });

    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain('FROM "ci"."entities" src');
    expect(flat(sql)).toContain('src."entity_id"::text = s.entity_id::text');
    expect(flat(sql)).toContain('src."entity_type" = $2');
    // entity_type filter ($1) + discriminator value ($2 = 'Person').
    expect(params).toEqual(['person', 'Person']);
  });

  it('uses the right discriminator value per shared-table type', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    await service.cleanOrphans({ entityTypes: ['place', 'file', 'concept'], batchSize: 500 });

    // 3 types x 2 tables = 6 statements; collect the discriminator (last) param.
    const discriminators = query.mock.calls.map((c) => c[1][1]);
    expect(discriminators).toEqual(['Location', 'File', 'Concept', 'Location', 'File', 'Concept']);
  });

  it('loops in batches until a statement deletes fewer than batchSize rows', async () => {
    // For the FIRST (embeddings) statement: 5, 5, 2 (stops). Then vectors: 0.
    const query = jest
      .fn()
      .mockResolvedValueOnce([[], 5])
      .mockResolvedValueOnce([[], 5])
      .mockResolvedValueOnce([[], 2])
      .mockResolvedValueOnce([[], 0]);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    const result = await service.cleanOrphans({ entityTypes: ['note'], batchSize: 5 });

    // 3 calls for embeddings (5+5+2), 1 call for vectors (0).
    expect(query).toHaveBeenCalledTimes(4);

    const noteEmbeddings = result.results.find(
      (r) => r.searchTable === 'ci_search.embeddings' && r.entityType === 'note',
    );
    expect(noteEmbeddings?.deleted).toBe(12);
    expect(result.totalDeleted).toBe(12);
    expect(result.dryRun).toBe(false);
  });

  it('dry run counts via COUNT(*) and never issues a DELETE', async () => {
    const query = jest.fn().mockResolvedValue([{ count: 7 }]);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    const result = await service.cleanOrphans({ entityTypes: ['event'], dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.totalDeleted).toBe(14); // 7 embeddings + 7 vectors
    for (const [sql] of query.mock.calls) {
      expect(flat(sql)).toContain('SELECT COUNT(*)::int AS count');
      expect(flat(sql)).not.toContain('DELETE');
    }
  });

  it('rejects a non-positive batchSize', async () => {
    const query = jest.fn();
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    await expect(service.cleanOrphans({ batchSize: 0 })).rejects.toThrow(/batchSize/);
    expect(query).not.toHaveBeenCalled();
  });

  it('defaults to sweeping every indexable type across both index tables', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    const result = await service.cleanOrphans();

    // 13 indexable types x 2 tables.
    expect(result.results).toHaveLength(26);
    expect(query).toHaveBeenCalledTimes(26);
  });
});

describe('OrphanCleanupService.truncateSearchIndex', () => {
  it('truncates both ci_search index tables', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = new OrphanCleanupService({ query } as unknown as DataSource, makeLogger() as never);

    const result = await service.truncateSearchIndex();

    expect(query).toHaveBeenCalledTimes(2);
    expect(flat(query.mock.calls[0][0])).toBe('TRUNCATE TABLE "ci_search"."embeddings"');
    expect(flat(query.mock.calls[1][0])).toBe('TRUNCATE TABLE "ci_search"."vectors"');
    expect(result.truncated).toEqual(['ci_search.embeddings', 'ci_search.vectors']);
  });
});
