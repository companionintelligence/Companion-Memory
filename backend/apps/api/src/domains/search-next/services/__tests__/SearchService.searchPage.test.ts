import type { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import { RETRIEVAL_POLICY_DEFAULTS, type RetrievalPolicyService } from '@ci/domains/retrieval-policy';

import { SearchService } from '../SearchService';

/**
 * `searchPage` is `search()` plus the size of the match set, and `count()` is
 * that size alone. These pin the contract a chat tool builds a NUMBER on: the
 * lexical modes report an exact `totalMatches` from `count(*) OVER ()`, the
 * vector modes report `null` and flag a full page as truncated, and a count is
 * the same predicate as the page with no LIMIT on it. Stubbed DataSource, no
 * Postgres — the SQL half lives in the scoping integration spec.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

function row(id: string, totalMatches?: number) {
  return {
    entity_id: id,
    entity_type: 'file',
    score: '0.5',
    // pg returns bigint as text, which is what a real row carries.
    ...(totalMatches != null ? { total_matches: String(totalMatches) } : {}),
  };
}

function makeService(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  const dataSource = { query } as unknown as DataSource;
  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue('[0.1,0.2]'),
  } as unknown as EmbeddingGenerationService;
  const retrievalPolicy = {
    get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS),
  } as unknown as RetrievalPolicyService;
  const send = jest.fn().mockResolvedValue([]);
  const events = { send } as unknown as EventService;

  const service = new SearchService(dataSource, embeddingGenerationService, retrievalPolicy, events);

  return { service, query, send };
}

describe('SearchService.searchPage — counted pages', () => {
  it('keyword: reports the window count as totalMatches and flags a cut page', async () => {
    const { service, query } = makeService([row('a', 342), row('b', 342)]);

    const page = await service.searchPage(CONTEXT, { query: 'rabbit', maxResults: 2 });

    expect(page.modeTaken).toBe('keyword');
    expect(page.items).toEqual([
      { id: 'a', type: 'file' },
      { id: 'b', type: 'file' },
    ]);
    expect(page.totalMatches).toBe(342);
    expect(page.truncated).toBe(true);
    expect(page.limit).toBe(2);

    // The count rides on the same statement as the page — one query, not two.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('count(*) OVER () AS total_matches');
  });

  it('keyword: a page that is the whole match set is not truncated', async () => {
    const { service } = makeService([row('a', 2), row('b', 2)]);

    const page = await service.searchPage(CONTEXT, { query: 'rabbit', maxResults: 25 });

    expect(page.totalMatches).toBe(2);
    expect(page.truncated).toBe(false);
  });

  it('keyword: no rows means zero matches, not a NaN', async () => {
    const { service } = makeService([]);

    const page = await service.searchPage(CONTEXT, { query: 'rabbit' });

    expect(page.items).toEqual([]);
    expect(page.totalMatches).toBe(0);
    expect(page.truncated).toBe(false);
  });

  it('keyword: rows without the count column fall back to the page size (never NaN)', async () => {
    const { service } = makeService([row('a'), row('b')]);

    const page = await service.searchPage(CONTEXT, { query: 'rabbit' });

    expect(page.totalMatches).toBe(2);
    expect(page.truncated).toBe(false);
  });

  it('boosted: also carries the exact window count', async () => {
    const { service, query } = makeService([row('a', 7)]);

    // 4-7 words, no special chars → boosted.
    const page = await service.searchPage(CONTEXT, {
      query: 'where does Jordan currently live',
      maxResults: 1,
    });

    expect(page.modeTaken).toBe('boosted');
    expect(page.totalMatches).toBe(7);
    expect(page.truncated).toBe(true);
    expect(query.mock.calls[0][0]).toContain('count(*) OVER () AS total_matches');
  });

  it('semantic: cannot count, so totalMatches is null and a full page is truncated', async () => {
    const { service } = makeService([row('a'), row('b')]);

    const page = await service.searchPage(CONTEXT, { query: 'anything', mode: 'semantic', maxResults: 2 });

    expect(page.modeTaken).toBe('semantic');
    expect(page.totalMatches).toBeNull();
    expect(page.truncated).toBe(true);
    expect(page.limit).toBe(2);
  });

  it('semantic: a short page is not truncated, and the default limit is the policy k', async () => {
    const { service } = makeService([row('a')]);

    const page = await service.searchPage(CONTEXT, { query: 'anything', mode: 'semantic' });

    expect(page.totalMatches).toBeNull();
    expect(page.truncated).toBe(false);
    expect(page.limit).toBe(RETRIEVAL_POLICY_DEFAULTS.semanticMaxResults);
  });

  it('hybrid: a fused union has no honest count; a full page is truncated', async () => {
    // Both legs read the same stub: two rows each, fused into two, sliced to 2.
    const { service } = makeService([row('a'), row('b')]);

    const page = await service.searchPage(CONTEXT, { query: 'anything', mode: 'hybrid', maxResults: 2 });

    expect(page.modeTaken).toBe('hybrid');
    expect(page.totalMatches).toBeNull();
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it('search() is searchPage() with the count dropped — same rows, same order', async () => {
    const { service } = makeService([row('b', 9), row('a', 9)]);

    const items = await service.search(CONTEXT, { query: 'rabbit' });

    expect(items).toEqual([
      { id: 'b', type: 'file' },
      { id: 'a', type: 'file' },
    ]);
  });
});

describe('SearchService.count — the match set with no cap on it', () => {
  it('runs a count(*) over the keyword predicate with no LIMIT and no ranking', async () => {
    const { service, query } = makeService([{ total_matches: '342' }]);

    const total = await service.count(CONTEXT, { query: 'rabbit', includeTypes: ['file'] });

    expect(total).toBe(342);
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];

    expect(sql).toContain('count(*) AS total_matches');
    expect(sql).not.toMatch(/LIMIT/i);
    expect(sql).not.toContain('ts_rank');
    // Same OR-rewritten tsquery the keyword page searches on, so the two agree.
    expect(sql).toContain("replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery");
    expect(params).toEqual(['user-1', 'rabbit', ['file']]);
  });

  it('no query counts the whole scope: no tsquery, type filter bound as $2', async () => {
    const { service, query, send } = makeService([{ total_matches: '23592' }]);

    const total = await service.count(CONTEXT, { includeTypes: ['file'] });

    expect(total).toBe(23_592);

    const [sql, params] = query.mock.calls[0];

    expect(sql).toContain('count(*) AS total_matches');
    expect(sql).not.toContain('tsquery');
    expect(sql).toContain('= ANY($2)');
    expect(params).toEqual(['user-1', ['file']]);
    expect(send.mock.calls[0][1]).toMatchObject({
      caller: 'search_count',
      modeTaken: 'scope',
      queryTokenCount: 0,
    });
  });

  it('a blank query is no query', async () => {
    const { service, query } = makeService([{ total_matches: '1' }]);

    await service.count(CONTEXT, { query: '   ', includeTypes: ['file'] });

    expect(query.mock.calls[0][0]).not.toContain('tsquery');
    expect(query.mock.calls[0][1]).toEqual(['user-1', ['file']]);
  });

  it('no row at all is zero', async () => {
    const { service } = makeService([]);

    expect(await service.count(CONTEXT, { query: 'rabbit' })).toBe(0);
  });

  it('applies the same default type exclusions as a page when no scope is named', async () => {
    const { service, query } = makeService([{ total_matches: '1' }]);

    await service.count(CONTEXT, { query: 'rabbit' });

    const [sql, params] = query.mock.calls[0];

    // The dispatcher excludes types nobody asked for (see applyDefaultTypeExclusions);
    // a count that skipped that would report rows the page never shows.
    expect(sql).toContain('!= ALL($3)');
    expect(Array.isArray(params[2])).toBe(true);
  });

  it('records a search_count telemetry row whose resultCount is the count itself', async () => {
    const { service, send } = makeService([{ total_matches: '12' }]);

    await service.count(CONTEXT, { query: 'rabbit' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({
      caller: 'search_count',
      modeTaken: 'keyword',
      resultCount: 12,
      topScore: null,
    });
  });
});
