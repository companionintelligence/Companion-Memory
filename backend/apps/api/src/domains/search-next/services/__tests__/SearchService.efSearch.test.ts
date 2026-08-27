import type { DataSource, QueryRunner } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import { RETRIEVAL_POLICY_DEFAULTS, type RetrievalPolicyService } from '@ci/domains/retrieval-policy';

import {
  HNSW_DEFAULT_EF_SEARCH,
  HNSW_MAX_EF_SEARCH,
  SEMANTIC_MAX_RESULTS,
  SearchService,
  requiredEfSearch,
} from '../SearchService';

/**
 * The semantic leg's `LIMIT` versus the HNSW candidate budget that has to
 * produce the rows it limits.
 *
 * `hybridSearch` asks its semantic leg for `maxResults * 2` = 50 rows, while
 * `hnsw.ef_search` is at pgvector's default of 40 everywhere on this appliance
 * (nothing sets it; `RecallProbeService`'s `SET LOCAL` dies with its own
 * transaction). An HNSW scan returns at most `ef_search` candidates and the
 * `user_id` / type / distance predicates then discard some of THOSE, so the leg
 * could not fill its own LIMIT even against a corpus with nothing to filter.
 *
 * ── What a unit test can and cannot prove here ────────────────────────────
 *
 * Without a database this pins the CONTRACT, not the recall: that the number of
 * rows the statement asks for and the candidate budget the connection is told
 * to keep are derived from one another instead of being two constants that
 * happen to agree. Whether widening the list actually returns more rows for a
 * given corpus is a measurement, and `ci.recall_probe_results` (migration
 * `20260821223302`) is the thing that makes it — not this file.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

type Harness = {
  service: SearchService;
  /** Statements issued on the pool (no transaction). */
  poolQueries: string[];
  /** Statements issued on the dedicated runner, in order. */
  runnerQueries: string[];
  runner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
  };
  createQueryRunner: jest.Mock;
};

function makeService(): Harness {
  const poolQueries: string[] = [];
  const runnerQueries: string[] = [];

  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) => {
      runnerQueries.push(sql);

      return [];
    }),
  };

  const createQueryRunner = jest.fn(() => runner as unknown as QueryRunner);

  const dataSource = {
    query: jest.fn(async (sql: string) => {
      poolQueries.push(sql);

      return [];
    }),
    createQueryRunner,
  } as unknown as DataSource;

  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue('[0.1,0.2]'),
  } as unknown as EmbeddingGenerationService;

  // Compiled-in baseline policy — this file's assertions are about ef_search
  // coherence, unaffected by RetrievalPolicyService's own tests elsewhere.
  const retrievalPolicy = {
    get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS),
  } as unknown as RetrievalPolicyService;
  const events = { send: jest.fn().mockResolvedValue([]) } as unknown as EventService;

  return {
    service: new SearchService(dataSource, embeddingGenerationService, retrievalPolicy, events),
    poolQueries,
    runnerQueries,
    runner,
    createQueryRunner,
  };
}

/** The semantic statement is the one against `ci_search.embeddings` alone. */
function findSemanticStatement(statements: string[]): string {
  const matches = statements.filter(
    (sql) => sql.includes('ci_search.embeddings') && !sql.includes('ci_search.vectors'),
  );

  expect(matches).toHaveLength(1);

  return matches[0] as string;
}

function limitOf(sql: string): number {
  const match = /LIMIT\s+(\d+)/i.exec(sql);

  expect(match).not.toBeNull();

  return Number((match as RegExpExecArray)[1]);
}

function efSearchOf(statements: string[]): number {
  const matches = statements
    .map((sql) => /SET\s+LOCAL\s+hnsw\.ef_search\s*=\s*(\d+)/i.exec(sql))
    .filter((match): match is RegExpExecArray => match !== null);

  expect(matches).toHaveLength(1);

  return Number((matches[0] as RegExpExecArray)[1]);
}

describe('requiredEfSearch', () => {
  it('never returns less than the budget the index already has', () => {
    expect(requiredEfSearch(1)).toBe(HNSW_DEFAULT_EF_SEARCH);
    expect(requiredEfSearch(25)).toBe(HNSW_DEFAULT_EF_SEARCH);
    expect(requiredEfSearch(HNSW_DEFAULT_EF_SEARCH)).toBe(HNSW_DEFAULT_EF_SEARCH);
  });

  it('rises to meet a k the default budget cannot produce', () => {
    // 50 is hybridSearch's own semantic-leg request at the default maxResults.
    expect(requiredEfSearch(HNSW_DEFAULT_EF_SEARCH + 1)).toBe(HNSW_DEFAULT_EF_SEARCH + 1);
    expect(requiredEfSearch(50)).toBe(50);
    expect(requiredEfSearch(200)).toBe(200);
  });

  it('stops at pgvector’s ceiling rather than issuing a SET that raises', () => {
    // `hnsw.ef_search` is capped at 1000; a larger value is rejected by the
    // server, which would turn an over-large request into a failed search
    // instead of a short one.
    expect(requiredEfSearch(HNSW_MAX_EF_SEARCH + 1)).toBe(HNSW_MAX_EF_SEARCH);
    expect(requiredEfSearch(1_000_000)).toBe(HNSW_MAX_EF_SEARCH);
  });

  it('is integral, so the value interpolated into SET LOCAL never carries a fraction', () => {
    expect(requiredEfSearch(50.9)).toBe(50);
    expect(Number.isInteger(requiredEfSearch(75.5))).toBe(true);
  });
});

describe('SearchService.buildSemanticSearchPlan', () => {
  it('reports the LIMIT it actually wrote, so the budget is derived from the statement', () => {
    const { service } = makeService();

    // The two numbers that have to agree are the plan's own LIMIT and the
    // candidate budget computed from it. Reporting `maxResults` on the plan is
    // what makes that one number instead of two independent computations of the
    // caller's option plus the same default written out twice.
    const explicit = service.buildSemanticSearchPlan('user-1', '[0.1,0.2]', { maxResults: 50 });

    expect(explicit.maxResults).toBe(50);
    expect(limitOf(explicit.sql)).toBe(explicit.maxResults);

    const defaulted = service.buildSemanticSearchPlan('user-1', '[0.1,0.2]');

    expect(defaulted.maxResults).toBe(SEMANTIC_MAX_RESULTS);
    expect(limitOf(defaulted.sql)).toBe(defaulted.maxResults);
  });

  it('the budget derived from a plan is never smaller than that plan’s LIMIT', () => {
    const { service } = makeService();

    for (const maxResults of [1, 25, 40, 41, 50, 100, 200]) {
      const plan = service.buildSemanticSearchPlan('user-1', '[0.1,0.2]', { maxResults });

      expect(requiredEfSearch(plan.maxResults)).toBeGreaterThanOrEqual(limitOf(plan.sql));
    }
  });
});

describe('SearchService semantic leg — LIMIT vs hnsw.ef_search', () => {
  it('hybrid: the semantic leg is given a candidate budget at least as large as its own LIMIT', async () => {
    const { service, runnerQueries } = makeService();

    await service.search(CONTEXT, { query: 'where did I eat last summer', mode: 'hybrid' });

    const semantic = findSemanticStatement(runnerQueries);

    // This is the whole defect: 50 requested against a 40-row candidate list.
    expect(limitOf(semantic)).toBe(50);
    expect(efSearchOf(runnerQueries)).toBeGreaterThanOrEqual(limitOf(semantic));
  });

  it('hybrid: the SET is LOCAL and inside a committed transaction, so it cannot outlive the statement', async () => {
    const { service, runner, runnerQueries } = makeService();

    await service.search(CONTEXT, { query: 'where did I eat last summer', mode: 'hybrid' });

    // Ordering matters: a SET LOCAL issued before START TRANSACTION is a no-op
    // that warns, and one issued after COMMIT leaks onto the pooled connection.
    expect(runner.startTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);

    const setIndex = runnerQueries.findIndex((sql) => /hnsw\.ef_search/i.test(sql));
    const semanticIndex = runnerQueries.indexOf(findSemanticStatement(runnerQueries));

    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeLessThan(semanticIndex);
    expect(runnerQueries[setIndex]).toMatch(/SET\s+LOCAL/i);
  });

  it('hybrid: the SET LOCAL carries a bare integer, never caller text', async () => {
    const { service, runnerQueries } = makeService();

    // `maxResults` reaches SQL by interpolation (SET takes no bind params), so
    // the value that lands there must come from requiredEfSearch, not the caller.
    await service.search(CONTEXT, {
      query: 'where did I eat last summer',
      mode: 'hybrid',
      maxResults: 60.7,
    });

    const set = runnerQueries.find((sql) => /hnsw\.ef_search/i.test(sql)) as string;

    expect(set).toBe('SET LOCAL hnsw.ef_search = 121');
  });

  it('hybrid: still ORDERs by the raw distance operator, so the HNSW index still serves it', async () => {
    const { service, runnerQueries } = makeService();

    await service.search(CONTEXT, { query: 'where did I eat last summer', mode: 'hybrid' });

    const semantic = findSemanticStatement(runnerQueries);

    // Widening the candidate list must not change the plan shape: HNSW only
    // accelerates `ORDER BY col <=> const ASC LIMIT k`.
    expect(semantic).toMatch(/ORDER BY embedding <=> \$2\s*\n\s*LIMIT/);
    expect(semantic).not.toMatch(/ORDER BY score DESC/);
  });

  it('semantic at the default maxResults asks for fewer rows than the budget, and is left alone', async () => {
    const { service, poolQueries, runnerQueries, createQueryRunner } = makeService();

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic' });

    // 25 <= 40: the default budget already covers it, so no transaction is
    // opened and no planner setting is touched. Paths that were never
    // incoherent must not start paying for a transaction.
    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(runnerQueries).toHaveLength(0);
    expect(limitOf(findSemanticStatement(poolQueries))).toBeLessThanOrEqual(HNSW_DEFAULT_EF_SEARCH);
  });

  it('semantic: a caller asking for more rows than the budget gets the budget raised to match', async () => {
    const { service, runnerQueries } = makeService();

    // DatabaseSearchTool permits maxResults up to 100 — over the budget on its
    // own, before hybrid doubles anything.
    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic', maxResults: 100 });

    const semantic = findSemanticStatement(runnerQueries);

    expect(limitOf(semantic)).toBe(100);
    expect(efSearchOf(runnerQueries)).toBe(100);
  });

  it('a failing statement rolls back and releases, so no connection is stranded mid-transaction', async () => {
    const { service, runner, createQueryRunner } = makeService();

    runner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('ci_search.embeddings')) {
        throw new Error('boom');
      }

      return [];
    });

    await expect(
      service.search(CONTEXT, { query: 'anything at all', mode: 'semantic', maxResults: 100 }),
    ).rejects.toThrow('boom');

    expect(createQueryRunner).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('the keyword leg is untouched: no transaction, no planner setting', async () => {
    const { service, poolQueries, createQueryRunner } = makeService();

    // GIN full-text has no candidate-list budget, so over-fetching from it was
    // never incoherent and must not acquire a dedicated connection.
    await service.search(CONTEXT, { query: 'mochi', mode: 'keyword', maxResults: 100 });

    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(poolQueries.some((sql) => sql.includes('ci_search.vectors'))).toBe(true);
  });
});
