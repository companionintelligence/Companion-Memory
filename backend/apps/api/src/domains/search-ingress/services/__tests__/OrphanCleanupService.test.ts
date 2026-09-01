import type { DataSource } from 'typeorm';

import { INDEXABLE_ENTITIES } from '@ci/domains/search-next';

import {
  DEFAULT_ORPHAN_STATEMENT_TIMEOUT_MS,
  OrphanCleanupService,
  SEARCH_TABLES,
} from '../OrphanCleanupService';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** Normalise whitespace so SQL assertions are not indentation-sensitive. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * The sweep runs on ONE pinned connection, bracketed by SET/RESET
 * statement_timeout. Every assertion about which statements the sweep issues is
 * about what sits INSIDE that bracket.
 */
function sweepCalls(query: jest.Mock): Array<[string, string[]]> {
  return query.mock.calls.filter(([sql]: [string]) => !sql.includes('statement_timeout')) as Array<
    [string, string[]]
  >;
}

function makeService(query: jest.Mock) {
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = { createQueryRunner: () => runner, query } as unknown as DataSource;

  return { service: new OrphanCleanupService(dataSource, makeLogger() as never), runner };
}

describe('OrphanCleanupService.cleanOrphans', () => {
  it('builds a NOT EXISTS delete against the right source table/id for a single-type entity', async () => {
    // node-pg DELETE result shape: [rows, affectedCount]. Return 0 so each
    // (table,type) does exactly one statement and the loop exits.
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    await service.cleanOrphans({ entityTypes: ['event'], batchSize: 1000 });

    const calls = sweepCalls(query);

    // Three statements: embeddings, vectors, index_skips.
    expect(calls).toHaveLength(3);

    const [embSql, embParams] = calls[0];
    expect(flat(embSql)).toContain('DELETE FROM "ci_search"."embeddings"');
    expect(flat(embSql)).toContain('FROM "ci_search"."embeddings" s');
    expect(flat(embSql)).toContain('WHERE s.entity_type = $1');
    expect(flat(embSql)).toContain('NOT EXISTS (SELECT 1 FROM "ci"."events" src');
    expect(flat(embSql)).toContain('src."event_id" = s.entity_id');
    expect(flat(embSql)).toContain('LIMIT 1000');
    // No discriminator → only the entity_type param.
    expect(embParams).toEqual(['event']);
    // Surrogate-id tables address victims by their uuid PK.
    expect(flat(embSql)).toContain('SELECT s."id"');
    expect(flat(embSql)).toContain('WHERE t."id" = victims."id"');

    const [vecSql] = calls[1];
    expect(flat(vecSql)).toContain('DELETE FROM "ci_search"."vectors"');
    expect(flat(vecSql)).toContain('FROM "ci"."events" src');

    // index_skips has no surrogate id — victims are addressed by the composite
    // (entity_type, entity_id) PK.
    const [skipSql] = calls[2];
    expect(flat(skipSql)).toContain('DELETE FROM "ci_search"."index_skips"');
    expect(flat(skipSql)).toContain('SELECT s."entity_type", s."entity_id"');
    expect(flat(skipSql)).toContain(
      'WHERE t."entity_type" = victims."entity_type" AND t."entity_id" = victims."entity_id"',
    );
  });

  /**
   * The correlation carries NO cast, on either side, for any type.
   *
   * `entity_id` and every source id column are `uuid`, so `::text` on both sides
   * was free to remove — and expensive to keep: casting the source side makes
   * its primary key unusable, and the planner answers the anti-join by hashing
   * the whole source table. Measured on 400k `ci.events` rows against 238 index
   * rows: hash anti join over a full seq scan, 1,322 temp blocks written, ~150
   * ms; uncast, an index-only probe per index row, ~0.5 ms. The sweep issues
   * this shape once per (index table x indexable type), unattended.
   */
  it('correlates entity_id to the source primary key uncast, so the PK index is usable', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    await service.cleanOrphans({ batchSize: 100 });

    for (const [sql] of sweepCalls(query)) {
      expect(flat(sql)).not.toContain('::text');
      expect(flat(sql)).toMatch(/src\."[a-z_]+" = s\.entity_id\b/);
    }
  });

  it('adds the discriminator predicate + param for entities sharing ci.entities', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    await service.cleanOrphans({ entityTypes: ['person'], batchSize: 500 });

    const [sql, params] = sweepCalls(query)[0];
    expect(flat(sql)).toContain('FROM "ci"."entities" src');
    expect(flat(sql)).toContain('src."entity_id" = s.entity_id');
    expect(flat(sql)).toContain('src."entity_type" = $2');
    // entity_type filter ($1) + discriminator value ($2 = 'Person').
    expect(params).toEqual(['person', 'Person']);
  });

  it('uses the right discriminator value per shared-table type', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    await service.cleanOrphans({ entityTypes: ['place', 'person', 'concept'], batchSize: 500 });

    // 3 types x 3 tables = 9 statements; collect the discriminator (last) param.
    const discriminators = sweepCalls(query).map((c) => c[1][1]);
    expect(discriminators).toEqual([
      'Location',
      'Person',
      'Concept',
      'Location',
      'Person',
      'Concept',
      'Location',
      'Person',
      'Concept',
    ]);
  });

  /**
   * `file` is NOT one of them, however plausible `ci.entities` /
   * `entity_type = 'File'` looks: that row is the file's GRAPH NODE, whose
   * `entity_id` is a different uuid from the `ci.files.id` every writer indexes.
   * Sweeping against it matched nothing and deleted the whole `file` index
   * nightly. See `__tests__/entitySourceMap.spec.ts`.
   */
  it('sweeps file against ci.files with no discriminator param', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    await service.cleanOrphans({ entityTypes: ['file'], batchSize: 500 });

    for (const [sql, params] of sweepCalls(query)) {
      expect(flat(sql)).toContain('FROM "ci"."files" src');
      expect(flat(sql)).toContain('src."id" = s.entity_id');
      expect(flat(sql)).not.toContain('"ci"."entities"');
      // Only the entity_type filter — no discriminator value.
      expect(params).toEqual(['file']);
    }
  });

  it('loops in batches until a statement deletes fewer than batchSize rows', async () => {
    // For the FIRST (embeddings) statement: 5, 5, 2 (stops). Then vectors and
    // index_skips: 0 each.
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined) // SET statement_timeout
      .mockResolvedValueOnce([[], 5])
      .mockResolvedValueOnce([[], 5])
      .mockResolvedValueOnce([[], 2])
      .mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    const result = await service.cleanOrphans({ entityTypes: ['note'], batchSize: 5 });

    // 3 calls for embeddings (5+5+2), 1 each for vectors and index_skips (0).
    expect(sweepCalls(query)).toHaveLength(5);

    const noteEmbeddings = result.results.find(
      (r) => r.searchTable === 'ci_search.embeddings' && r.entityType === 'note',
    );
    expect(noteEmbeddings?.deleted).toBe(12);
    expect(result.totalDeleted).toBe(12);
    expect(result.dryRun).toBe(false);
  });

  it('dry run counts via COUNT(*) and never issues a DELETE', async () => {
    const query = jest.fn().mockResolvedValue([{ count: 7 }]);
    const { service } = makeService(query);

    const result = await service.cleanOrphans({ entityTypes: ['event'], dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.totalDeleted).toBe(21); // 7 embeddings + 7 vectors + 7 index_skips
    for (const [sql] of sweepCalls(query)) {
      expect(flat(sql)).toContain('SELECT COUNT(*)::int AS count');
      expect(flat(sql)).not.toContain('DELETE');
    }
  });

  it('rejects a non-positive batchSize', async () => {
    const query = jest.fn();
    const { service } = makeService(query);

    await expect(service.cleanOrphans({ batchSize: 0 })).rejects.toThrow(/batchSize/);
    expect(query).not.toHaveBeenCalled();
  });

  it('defaults to sweeping every indexable type across every index table', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    const result = await service.cleanOrphans();

    // Every INDEXABLE_ENTITIES type × embeddings/vectors/index_skips.
    const expected = INDEXABLE_ENTITIES.length * SEARCH_TABLES.length;
    expect(result.results).toHaveLength(expected);
    expect(sweepCalls(query)).toHaveLength(expected);
  });
});

/**
 * An unattended sweep must not be able to pin a connection for as long as one
 * bad plan takes. The ceiling is a SESSION setting, so it only means anything on
 * a connection the sweep owns for its whole run — hence the pinned runner, and
 * hence the RESET before it goes back to the pool.
 */
describe('OrphanCleanupService.cleanOrphans statement timeout', () => {
  it('pins one connection and bounds every statement on it', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service, runner } = makeService(query);

    await service.cleanOrphans({ entityTypes: ['event'] });

    expect(runner.connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(`SET statement_timeout = ${DEFAULT_ORPHAN_STATEMENT_TIMEOUT_MS}`);
    expect(query.mock.calls.at(-1)?.[0]).toBe('RESET statement_timeout');
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('honours a caller-supplied ceiling', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { service } = makeService(query);

    await service.cleanOrphans({ entityTypes: ['event'], statementTimeoutMs: 5_000 });

    expect(query.mock.calls[0][0]).toBe('SET statement_timeout = 5000');
  });

  it('resets and releases even when a statement throws', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined) // SET statement_timeout
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'))
      .mockResolvedValue(undefined);
    const { service, runner } = makeService(query);

    await expect(service.cleanOrphans({ entityTypes: ['event'] })).rejects.toThrow(/statement timeout/);

    expect(query.mock.calls.at(-1)?.[0]).toBe('RESET statement_timeout');
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});

describe('OrphanCleanupService.truncateSearchIndex', () => {
  it('truncates every ci_search index table', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    const result = await service.truncateSearchIndex();

    expect(query).toHaveBeenCalledTimes(3);
    expect(flat(query.mock.calls[0][0])).toBe('TRUNCATE TABLE "ci_search"."embeddings"');
    expect(flat(query.mock.calls[1][0])).toBe('TRUNCATE TABLE "ci_search"."vectors"');
    expect(flat(query.mock.calls[2][0])).toBe('TRUNCATE TABLE "ci_search"."index_skips"');
    expect(result.truncated).toEqual(['ci_search.embeddings', 'ci_search.vectors', 'ci_search.index_skips']);
  });
});
