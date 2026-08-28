import type { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import { RETRIEVAL_POLICY_DEFAULTS, type RetrievalPolicyService } from '@ci/domains/retrieval-policy';

import { SearchService, SEMANTIC_DISTANCE_THRESHOLD } from '../SearchService';

/**
 * `search()` is the actual public entry point every caller goes through —
 * SearchResolver, MCP tools, RecallService. It has zero direct coverage: the
 * only existing spec (SearchService.searchMessages.test.ts) exercises the
 * separate naive-RAG message channel, not this dispatcher. These pin the
 * mode-selection contract (`resolveAutoMode`'s word-count/special-char heuristic)
 * and the default type-exclusion behind it, using a stubbed DataSource so no
 * Postgres is required — the SQL/tenancy half of SearchService lives in
 * SearchService.scoping.integration.spec.ts against a real one.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

function makeService() {
  const query = jest.fn().mockResolvedValue([]);
  const dataSource = { query } as unknown as DataSource;
  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue('[0.1,0.2]'),
  } as unknown as EmbeddingGenerationService;

  // The policy these tests run under is the compiled-in baseline — the same
  // object `RetrievalPolicyService` returns when `ci.retrieval_policy` is empty
  // or unreachable. Every assertion below is therefore an assertion about
  // TODAY's behaviour, unchanged by the policy table existing.
  const retrievalPolicy = {
    get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS),
  } as unknown as RetrievalPolicyService;

  const send = jest.fn().mockResolvedValue([]);
  const events = { send } as unknown as EventService;

  const service = new SearchService(dataSource, embeddingGenerationService, retrievalPolicy, events);

  return { service, query, embeddingGenerationService, retrievalPolicy, send };
}

describe('SearchService.search — mode dispatch', () => {
  it('an explicit mode is honored verbatim, bypassing auto-detection', async () => {
    const { service, embeddingGenerationService } = makeService();

    // 'urgent' is a single word — auto would route this to keyword
    // (no embedding call). An explicit 'semantic' must still call the
    // embedding service; the mode argument overrides the heuristic entirely.
    await service.search(CONTEXT, { query: 'urgent', mode: 'semantic' });

    expect(embeddingGenerationService.generateEmbeddingString).toHaveBeenCalledTimes(1);
  });

  it('auto: a short query (<=3 words) routes to keyword — no embedding call', async () => {
    const { service, embeddingGenerationService } = makeService();

    await service.search(CONTEXT, { query: 'dog breed info' });

    expect(embeddingGenerationService.generateEmbeddingString).not.toHaveBeenCalled();
  });

  it('auto: special characters route to keyword regardless of word count', async () => {
    const { service, embeddingGenerationService } = makeService();

    // An email-shaped query is exactly the case the heuristic calls out
    // (IDs/emails) — must stay fast (keyword-only), not spend an embedding
    // call, even though the surrounding sentence has 4+ words.
    await service.search(CONTEXT, { query: 'notes about jane.smith@example.com account' });

    expect(embeddingGenerationService.generateEmbeddingString).not.toHaveBeenCalled();
  });

  it('auto: a medium query (4-7 words, no special chars) routes to boosted keyword', async () => {
    const { service, query, embeddingGenerationService } = makeService();

    await service.search(CONTEXT, { query: 'where does Jordan currently live' });

    expect(embeddingGenerationService.generateEmbeddingString).toHaveBeenCalledTimes(1);
    // boostedKeywordSearch's distinguishing shape: it joins ci_search.vectors
    // AND ci_search.embeddings (semanticSearch touches only embeddings).
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/ci_search\.vectors/);
    expect(sql).toMatch(/ci_search\.embeddings/);
  });

  it('auto: a long natural-language query (>=8 words) routes to semantic only', async () => {
    const { service, query, embeddingGenerationService } = makeService();

    await service.search(CONTEXT, {
      query: 'can you tell me approximately where I was living around this time last year',
    });

    expect(embeddingGenerationService.generateEmbeddingString).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/ci_search\.embeddings/);
    expect(sql).not.toMatch(/ci_search\.vectors/);
  });

  it('defaults exclude message and position types when the caller specifies neither', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'short query' }); // keyword path

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    // buildTypeFilter's exclude-list param is appended last for keywordSearch.
    expect(params[params.length - 1]).toEqual(['message', 'position']);
  });

  it('an explicit includeTypes is never overridden by the default exclusion', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'short query', includeTypes: ['person'] });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/entity_type = ANY/);
    expect(params[params.length - 1]).toEqual(['person']);
  });

  it('search() strips scores off the result before returning to callers', async () => {
    const { service, query } = makeService();
    query.mockResolvedValue([{ entity_id: 'e1', entity_type: 'person', score: '0.9' }]);

    const results = await service.search(CONTEXT, { query: 'short query' });

    expect(results).toEqual([{ id: 'e1', type: 'person' }]);
    expect(results[0]).not.toHaveProperty('score');
  });
});

describe('SearchService.search — distanceThreshold', () => {
  it('defaults to SEMANTIC_DISTANCE_THRESHOLD when the caller passes none', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic' });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(SEMANTIC_DISTANCE_THRESHOLD);
  });

  it('an explicit threshold reaches the statement as the bind parameter', async () => {
    // Evidence retrieval needs a tighter bar than plain search: on the reference
    // corpus, a 0.5 floor let "Much more to follow." through as the answer to
    // "What sports do you follow?".
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'anything at all', mode: 'semantic', distanceThreshold: 0.3 });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(0.3);
  });
});

describe('SearchService.searchAnchored', () => {
  /**
   * @param dfs document frequency per lexeme, as the first (anchor-selection)
   *   query would report it.
   */
  function makeAnchoredService(dfs: { lexeme: string; df: number }[]) {
    const built = makeService();

    built.query.mockImplementation((sql: string) => {
      if (/tsvector_to_array/.test(sql)) {
        return Promise.resolve(dfs.map((row) => ({ lexeme: row.lexeme, df: String(row.df) })));
      }

      return Promise.resolve([{ entity_id: 'e1', entity_type: 'browser-activity' }]);
    });

    return built;
  }

  it('anchors on the RAREST eligible lexeme, not the first or the most frequent', async () => {
    const { service, query } = makeAnchoredService([
      { lexeme: 'favorit', df: 426 },
      { lexeme: 'cuisin', df: 58 },
    ]);

    await service.searchAnchored(CONTEXT, 'What is your favorite cuisine?');

    const [, params] = query.mock.calls[1] as [string, unknown[]];
    expect(params[1]).toBe('cuisin');
  });

  it('returns NOTHING — and runs no second query — when every term is too common', async () => {
    // "What city do you live in?" on the reference corpus: city 3,848 rows,
    // live 8,302. Anchoring on either returns Suffragette City and Midnight
    // City. No selective term means no lexical channel, not a loose one.
    const { service, query, embeddingGenerationService } = makeAnchoredService([
      { lexeme: 'citi', df: 3848 },
      { lexeme: 'live', df: 8302 },
    ]);

    const results = await service.searchAnchored(CONTEXT, 'What city do you live in?');

    expect(results).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    // No anchor means no retrieval, so the embedding call must not be spent.
    expect(embeddingGenerationService.generateEmbeddingString).not.toHaveBeenCalled();
  });

  it('ignores a lexeme the corpus does not contain at all', async () => {
    // df 0 sorts rarest, but anchoring on it matches nothing — it is a dead end,
    // not the most selective term.
    const { service, query } = makeAnchoredService([
      { lexeme: 'zerbcorpoli', df: 0 },
      { lexeme: 'cuisin', df: 58 },
    ]);

    await service.searchAnchored(CONTEXT, 'zerbcorpolis cuisine');

    const [, params] = query.mock.calls[1] as [string, unknown[]];
    expect(params[1]).toBe('cuisin');
  });

  it('honours a caller-supplied anchor ceiling', async () => {
    const { service, query } = makeAnchoredService([{ lexeme: 'sport', df: 265 }]);

    const results = await service.searchAnchored(CONTEXT, 'What sports do you follow?', {
      maxAnchorMatches: 100,
    });

    expect(results).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('orders by embedding distance, not ts_rank — length bias is the bug it fixes', async () => {
    // ts_rank with no length normalisation rewards repetition, which is how a
    // 6,000-char page whose body says "follow" nine times outranked a title
    // saying "Sports" once.
    const { service, query } = makeAnchoredService([{ lexeme: 'sport', df: 265 }]);

    await service.searchAnchored(CONTEXT, 'What sports do you follow?');

    const [sql] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY \(e\.embedding <=> \$3::vector\) ASC NULLS LAST/);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*ts_rank/);
  });

  it('keeps a matching row that has no embedding, sorted last rather than dropped', async () => {
    const { service, query } = makeAnchoredService([{ lexeme: 'cuisin', df: 58 }]);

    await service.searchAnchored(CONTEXT, 'What is your favorite cuisine?');

    const [sql] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/LEFT JOIN\s+ci_search\.embeddings/);
    expect(sql).toMatch(/NULLS LAST/);
  });

  it('never concatenates the lexeme into SQL — it crosses as a bind parameter', async () => {
    const { service, query } = makeAnchoredService([{ lexeme: "o'brien", df: 3 }]);

    await service.searchAnchored(CONTEXT, "O'Brien");

    const [sql, params] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).not.toContain("o'brien");
    expect(params[1]).toBe("o'brien");
    // 'simple', not 'english': $2 is already a stem the english stemmer emitted,
    // and re-stemming a stem is not a guaranteed fixed point.
    expect(sql).toMatch(/plainto_tsquery\('simple', \$2\)/);
  });

  it('bounds the document-frequency count at the ceiling instead of counting the corpus', async () => {
    const { service, query } = makeAnchoredService([{ lexeme: 'cuisin', df: 58 }]);

    await service.searchAnchored(CONTEXT, 'What is your favorite cuisine?', { maxAnchorMatches: 1000 });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$3/);
    // ceiling + 1, so "exactly at the ceiling" is distinguishable from "over".
    expect(params[2]).toBe(1001);
  });
});
