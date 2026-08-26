import type { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import { RETRIEVAL_POLICY_DEFAULTS, type RetrievalPolicyService } from '@ci/domains/retrieval-policy';

import { queryTokenCount } from '../../events';
import { SearchService } from '../SearchService';

/**
 * What `SearchService` says about a real query, and — far more importantly —
 * what it must never say.
 *
 * Before this, `SearchService` had no logger at all: a repo grep for `logger`
 * in it returned zero hits, so every search the appliance served was
 * unobserved. The fix cannot be "log the search": on a personal appliance the
 * QUESTION is at least as sensitive as the corpus, so the payload carries a
 * token count and nothing else about what was asked. These tests are the guard
 * on that line.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

/** The one string that must never reach the queue. Six whitespace tokens. */
const SECRET = 'divorce lawyer recommendation from Priya Sharma';

function makeService() {
  const query = jest.fn().mockResolvedValue([]);
  const dataSource = { query } as unknown as DataSource;
  const embeddingGenerationService = {
    generateEmbeddingString: jest.fn().mockResolvedValue('[0.1,0.2]'),
  } as unknown as EmbeddingGenerationService;
  const send = jest.fn().mockResolvedValue([]);
  const events = { send } as unknown as EventService;
  const retrievalPolicy = {
    get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS),
  } as unknown as RetrievalPolicyService;

  const service = new SearchService(dataSource, embeddingGenerationService, retrievalPolicy, events);

  return { service, query, send };
}

/** The payload of the Nth `send` call. */
function payloadOf(send: jest.Mock, index = 0): Record<string, unknown> {
  return (send.mock.calls[index] as [string, Record<string, unknown>])[1];
}

describe('queryTokenCount', () => {
  it('counts whitespace tokens, not characters or lexemes', () => {
    expect(queryTokenCount(SECRET)).toBe(6);
  });

  it('collapses runs of whitespace rather than counting empty tokens', () => {
    expect(queryTokenCount('  where   does  Jordan live \n')).toBe(4);
  });

  it('is 0 for an empty or whitespace-only query', () => {
    expect(queryTokenCount('')).toBe(0);
    expect(queryTokenCount('   \t\n ')).toBe(0);
  });
});

describe('SearchService — retrieval.query telemetry', () => {
  it('emits fire-and-forget onto the telemetry queue, the way tool.invoked does', async () => {
    const { service, send } = makeService();

    await service.search(CONTEXT, { query: 'short query' });

    const [name, , options] = send.mock.calls[0] as [string, unknown, unknown];

    expect(name).toBe('retrieval.query');
    expect(options).toStrictEqual({ queue: 'telemetry' });
  });

  it('records the mode auto RESOLVED to, never the literal string "auto"', async () => {
    const { service, send } = makeService();

    // 8+ words, no special characters: auto routes this to semantic. Recorded
    // as 'auto' the column would be unreadable — auto is the default, so it is
    // most calls, and the three strategies it picks between behave differently.
    await service.search(CONTEXT, {
      query: 'can you tell me approximately where I was living last year',
    });

    expect(payloadOf(send).modeTaken).toBe('semantic');
    expect(payloadOf(send).caller).toBe('search');
  });

  it('records the same call as keyword when the heuristic picks keyword', async () => {
    const { service, send } = makeService();

    await service.search(CONTEXT, { query: 'dog breed info' });

    expect(payloadOf(send).modeTaken).toBe('keyword');
  });

  it('never puts the query text — or anything reversible to it — on the queue', async () => {
    const { service, query, send } = makeService();

    // searchAnchored needs a selective lexeme to get past its short-circuit.
    query.mockImplementation((sql: string) =>
      /tsvector_to_array/.test(sql) ? Promise.resolve([{ lexeme: 'divorc', df: '3' }]) : Promise.resolve([]),
    );

    await service.search(CONTEXT, { query: SECRET, mode: 'keyword' });
    await service.searchPrompt(CONTEXT, { prompt: SECRET });
    await service.searchMessages(CONTEXT, SECRET);
    await service.searchAnchored(CONTEXT, SECRET);

    expect(send).toHaveBeenCalledTimes(4);

    for (const [, payload] of send.mock.calls as [string, Record<string, unknown>][]) {
      // Serialised whole rather than checked field by field: a field added
      // later that carried the text would slip straight past an assertion that
      // only names the fields known today.
      const serialised = JSON.stringify(payload);

      expect(serialised).not.toContain('divorce');
      expect(serialised).not.toContain('Priya');
      expect(serialised).not.toContain('lawyer');
      expect(payload).not.toHaveProperty('query');
      expect(payload).not.toHaveProperty('prompt');
      // The SIZE survives; the text does not.
      expect(payload.queryTokenCount).toBe(6);
    }
  });

  it('records the EFFECTIVE type filter, including the exclusions the service injects', async () => {
    const { service, send } = makeService();

    // The caller named neither filter, so applyDefaultTypeExclusions substitutes
    // message+position — which means every default search is a FILTERED search,
    // and the filters sit outside the HNSW ORDER BY. Recording the caller's
    // (empty) request instead would hide exactly that.
    await service.search(CONTEXT, { query: 'short query' });

    expect(payloadOf(send).excludeTypes).toStrictEqual(['message', 'position']);
    expect(payloadOf(send).includeTypes).toBeNull();
  });

  it("records an explicit includeTypes as the caller's, with no exclusions", async () => {
    const { service, send } = makeService();

    await service.search(CONTEXT, { query: 'short query', includeTypes: ['person'] });

    expect(payloadOf(send).includeTypes).toStrictEqual(['person']);
    expect(payloadOf(send).excludeTypes).toBeNull();
  });

  it('records a zero-result search as zero, with a null top score', async () => {
    const { service, send } = makeService();

    await service.search(CONTEXT, { query: 'short query' });

    expect(payloadOf(send).resultCount).toBe(0);
    expect(payloadOf(send).topScore).toBeNull();
  });

  it('records the BEST score in the result set, not the first row it happens to see', async () => {
    const { service, query, send } = makeService();
    query.mockResolvedValue([
      { entity_id: 'e1', entity_type: 'person', score: '0.4' },
      { entity_id: 'e2', entity_type: 'person', score: '0.9' },
    ]);

    await service.search(CONTEXT, { query: 'short query' });

    expect(payloadOf(send).resultCount).toBe(2);
    expect(payloadOf(send).topScore).toBe(0.9);
  });

  it("records searchAnchored's no-anchor short-circuit — the empty answer it returns BY DESIGN", async () => {
    // "What city do you live in?" has no selective term on the reference
    // corpus (city 3,848 rows, live 8,302), so the method returns nothing and
    // runs no second query. Correct, and until now completely invisible.
    const { service, query, send } = makeService();

    query.mockResolvedValue([
      { lexeme: 'citi', df: '3848' },
      { lexeme: 'live', df: '8302' },
    ]);

    const results = await service.searchAnchored(CONTEXT, 'What city do you live in?');

    expect(results).toStrictEqual([]);
    expect(results).toHaveLength(0);
    expect(payloadOf(send).caller).toBe('search_anchored');
    expect(payloadOf(send).modeTaken).toBe('no_anchor');
    expect(payloadOf(send).resultCount).toBe(0);
  });

  it('records an anchored search that DID run with a null top score', async () => {
    // The statement selects no score at all — it orders by embedding distance
    // and returns identifiers — so there is none to claim.
    const { service, query, send } = makeService();

    query.mockImplementation((sql: string) =>
      /tsvector_to_array/.test(sql)
        ? Promise.resolve([{ lexeme: 'cuisin', df: '58' }])
        : Promise.resolve([{ entity_id: 'e1', entity_type: 'browser-activity' }]),
    );

    await service.searchAnchored(CONTEXT, 'What is your favorite cuisine?');

    expect(payloadOf(send).modeTaken).toBe('anchored');
    expect(payloadOf(send).resultCount).toBe(1);
    expect(payloadOf(send).topScore).toBeNull();
  });

  it("records searchPrompt's no-groups short-circuit as a zero-result retrieval", async () => {
    const { service, send } = makeService();

    // Punctuation only: buildPromptQuery yields no groups, so the method
    // returns without querying. That is the shape a failing ask executor takes,
    // which makes it the one an operator most wants counted.
    const result = await service.searchPrompt(CONTEXT, { prompt: '???' });

    expect(result.items).toStrictEqual([]);
    expect(result.items).toHaveLength(0);
    expect(payloadOf(send).caller).toBe('search_prompt');
    expect(payloadOf(send).resultCount).toBe(0);
  });

  it('records searchPrompt by PAGE size, not by its saturated total-match count', async () => {
    const { service, query, send } = makeService();

    query.mockResolvedValue([{ entity_id: 'e1', entity_type: 'person', score: '0.7', total_matches: '297' }]);

    await service.searchPrompt(CONTEXT, { prompt: 'have you seen David Miller' });

    // Every other caller records what it handed back; a zero-result rate
    // computed over a mixture of page sizes and match totals means nothing.
    expect(payloadOf(send).resultCount).toBe(1);
    expect(payloadOf(send).topScore).toBe(0.7);
  });

  it('records searchMessages as an INCLUDE of the type every other path excludes', async () => {
    const { service, send } = makeService();

    await service.searchMessages(CONTEXT, 'anything at all');

    expect(payloadOf(send).caller).toBe('search_messages');
    expect(payloadOf(send).includeTypes).toStrictEqual(['message']);
    expect(payloadOf(send).excludeTypes).toBeNull();
  });

  it('returns the results even when the telemetry emit rejects', async () => {
    const { service, query, send } = makeService();
    send.mockRejectedValue(new Error('pg-boss is down'));
    query.mockResolvedValue([{ entity_id: 'e1', entity_type: 'person', score: '0.9' }]);

    // A search that already has its answer must not fail — or wait — because a
    // telemetry row could not be enqueued.
    await expect(service.search(CONTEXT, { query: 'short query' })).resolves.toStrictEqual([
      { id: 'e1', type: 'person' },
    ]);
  });

  it('does not await the emit — a hanging queue cannot hang a search', async () => {
    const { service, send } = makeService();
    // A send that never settles. If `search` awaited it, this would time out.
    send.mockReturnValue(new Promise(() => {}));

    await expect(service.search(CONTEXT, { query: 'short query' })).resolves.toStrictEqual([]);
  });
});
