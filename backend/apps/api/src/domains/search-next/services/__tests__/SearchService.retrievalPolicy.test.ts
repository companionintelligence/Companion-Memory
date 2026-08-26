import type { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import {
  RETRIEVAL_POLICY_DEFAULTS,
  type RetrievalPolicy,
  type RetrievalPolicyService,
} from '@ci/domains/retrieval-policy';

import { SearchService } from '../SearchService';

/**
 * `SearchService` used to hard-code its four retrieval knobs. They now come
 * from `ci.retrieval_policy` through `RetrievalPolicyService`, which fails open
 * to the compiled-in baseline.
 *
 * Two halves are pinned here, and the first is the load-bearing one:
 *
 *   1. Under the fail-open baseline — an appliance whose policy table is empty
 *      or unreachable — the generated SQL is character-identical to what it was
 *      before the policy existed: `ts_rank('{0.1, 0.2, 0.4, 1.0}', …)`,
 *      `(1 + 0.5 * …)`, `LIMIT 25`, threshold 0.5.
 *   2. Under a promoted v2, every one of those four moves.
 *
 * The DataSource is stubbed, so no Postgres is required.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

const V2: RetrievalPolicy = {
  version: 2,
  tsRankWeights: { d: 0.05, c: 0.25, b: 0.5, a: 0.9 },
  embeddingBoostFactor: 0.8,
  semanticDistanceThreshold: 0.42,
  semanticMaxResults: 40,
  recallMessageResults: 15,
  recallMessageDistanceFloor: 0.35,
  recallSeedMode: 'hybrid',
  groundedSimilarityFloor: 0.75,
  anchoredDepthMultiplier: 3,
};

function makeService(policy: RetrievalPolicy = RETRIEVAL_POLICY_DEFAULTS) {
  const query = jest.fn().mockResolvedValue([]);
  const dataSource = { query } as unknown as DataSource;
  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue('[0.1,0.2]'),
  } as unknown as EmbeddingGenerationService;
  const retrievalPolicy = {
    get: jest.fn().mockResolvedValue(policy),
  } as unknown as RetrievalPolicyService;
  const events = { send: jest.fn().mockResolvedValue([]) } as unknown as EventService;

  return { service: new SearchService(dataSource, embeddingGenerationService, retrievalPolicy, events), query };
}

describe('SearchService under the fail-open baseline — SQL is unchanged', () => {
  it('keyword search still ranks with the exact literal that used to be inlined', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'dog breed info' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("ts_rank('{0.1, 0.2, 0.4, 1.0}', vector, q.tq)");
  });

  it('boosted search still multiplies by (1 + 0.5 * similarity)', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'where does Jordan currently live' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("ts_rank('{0.1, 0.2, 0.4, 1.0}', v.vector, q.tq)");
    expect(sql).toContain('(1 + 0.5 * COALESCE(1 - (e.embedding <=> $3::vector), 0))');
  });

  it('semantic search still runs at LIMIT 25 with a 0.5 distance floor', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic' });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT 25/);
    expect(params[2]).toBe(0.5);
  });

  it('prompt search still ranks with the baseline weights', async () => {
    const { service, query } = makeService();

    await service.searchPrompt(CONTEXT, { prompt: 'Have you been to Lisbon?' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("ts_rank('{0.1, 0.2, 0.4, 1.0}', v.vector, q.tq)");
  });
});

describe('SearchService under a promoted v2', () => {
  it('keyword search ranks with the promoted weights', async () => {
    const { service, query } = makeService(V2);

    await service.search(CONTEXT, { query: 'dog breed info' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("ts_rank('{0.05, 0.25, 0.5, 0.9}', vector, q.tq)");
    expect(sql).not.toContain('{0.1, 0.2, 0.4, 1.0}');
  });

  it('boosted search multiplies by the promoted boost', async () => {
    const { service, query } = makeService(V2);

    await service.search(CONTEXT, { query: 'where does Jordan currently live' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('(1 + 0.8 * COALESCE(1 - (e.embedding <=> $3::vector), 0))');
  });

  it('semantic search takes both its LIMIT and its distance floor from the policy', async () => {
    const { service, query } = makeService(V2);

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic' });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT 40/);
    expect(params[2]).toBe(0.42);
  });

  it('prompt search ranks with the promoted weights', async () => {
    const { service, query } = makeService(V2);

    await service.searchPrompt(CONTEXT, { prompt: 'Have you been to Lisbon?' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("ts_rank('{0.05, 0.25, 0.5, 0.9}', v.vector, q.tq)");
  });
});

describe('SearchService — the policy is a DEFAULT, not a cap', () => {
  it('an explicit distanceThreshold still overrides the policy', async () => {
    // `RecallService.groundedSeeds` passes a much tighter floor on purpose: a
    // policy that loosened the general bar must not loosen evidence retrieval.
    const { service, query } = makeService(V2);

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic', distanceThreshold: 0.3 });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(0.3);
  });

  it('an explicit maxResults still overrides the policy', async () => {
    const { service, query } = makeService(V2);

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic', maxResults: 7 });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/LIMIT 7/);
  });
});

describe('SearchService — a policy that would produce unsafe SQL', () => {
  it('falls back to the baseline literals rather than interpolating the bad value', async () => {
    // `RetrievalPolicyService` rejects this row before it reaches here, so this
    // is the second gate: the weights are written into the statement TEXT, and
    // "whatever the row held" must never become part of a statement.
    const { service, query } = makeService({
      ...RETRIEVAL_POLICY_DEFAULTS,
      version: 9,
      tsRankWeights: { d: 0.1, c: 0.2, b: 0.4, a: Number.NaN },
    });

    await service.search(CONTEXT, { query: 'dog breed info' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain("ts_rank('{0.1, 0.2, 0.4, 1.0}', vector, q.tq)");
    expect(sql).not.toContain('NaN');
  });
});
