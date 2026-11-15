import type { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import type { RetrievalPolicyService } from '@ci/domains/retrieval-policy';

import { SearchService } from '../SearchService';

const USER = '0190c3f2-0000-7000-8000-000000000001';
const FLAG = 'SEARCH_TRAINED_RERANK';
const CONTEXT = { userId: USER } as unknown as UserServiceContext;

const A = '0190c3f2-0000-7000-8000-00000000000a';
const B = '0190c3f2-0000-7000-8000-00000000000b';
const C = '0190c3f2-0000-7000-8000-00000000000c';
const D = '0190c3f2-0000-7000-8000-00000000000d';
const E = '0190c3f2-0000-7000-8000-00000000000e';

type Hit = { id: string; type: string; score: number };

/**
 * Semantic ranks A, B, C, D and keyword ranks C, A, E. The RRF order (k = 60) is
 * A, C, B, E, D, so the head of three is A, C, B.
 */
const SEMANTIC: Hit[] = [A, B, C, D].map((id, i) => ({ id, type: 'communication', score: 0.9 - i * 0.1 }));
const KEYWORD: Hit[] = [C, A, E].map((id, i) => ({ id, type: 'communication', score: 1 - i * 0.1 }));

/** Passage text is projected for A, B and C only. E and D have none, so they keep their RRF place. */
const TEXTED = [A, B, C];

function reply(scores: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      user_id: USER,
      results: Object.entries(scores).map(([id, score]) => ({
        id: `communication:${id}`,
        score,
        is_relevant: score >= 0.5,
        relevance_probability: score,
        temporal_freshness: 1,
        calibrated: true,
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function build(
  options: {
    semantic?: Hit[];
    keyword?: Hit[];
    texted?: readonly string[];
    readStalls?: boolean;
    readError?: Error;
  } = {},
) {
  const texted = new Set(options.texted ?? TEXTED);
  const manager = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('set_config')) {
        return [];
      }

      if (options.readError) {
        throw options.readError;
      }

      return (params[2] as string[])
        .filter((id) => texted.has(id))
        .map((id) => ({
          entity_type: 'communication',
          id,
          title: 'Coffee with Sam',
          body: 'Tuesday at nine',
        }));
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (run: (m: typeof manager) => Promise<unknown>) =>
      options.readStalls ? new Promise<never>(() => undefined) : run(manager),
    ),
  };
  const service = new SearchService(
    dataSource as unknown as DataSource,
    {} as unknown as EmbeddingGenerationService,
    {} as unknown as RetrievalPolicyService,
    { send: jest.fn(async () => []) } as unknown as EventService,
  );

  const legs = service as unknown as {
    semanticSearch: (...args: unknown[]) => Promise<unknown>;
    keywordSearch: (...args: unknown[]) => Promise<unknown>;
  };

  jest.spyOn(legs, 'semanticSearch').mockResolvedValue({
    results: options.semantic ?? SEMANTIC,
    totalMatches: null,
    limit: 50,
  });
  jest.spyOn(legs, 'keywordSearch').mockResolvedValue({
    results: options.keyword ?? KEYWORD,
    totalMatches: null,
    limit: 50,
  });

  return { service, dataSource, manager };
}

async function topResults(service: SearchService, maxResults: number): Promise<string[]> {
  const page = await service.searchPage(CONTEXT, {
    query: 'coffee with Sam',
    mode: 'hybrid',
    fusionMode: 'rrf',
    maxResults,
  });

  return page.items.map((item) => item.id);
}

const topThree = (service: SearchService) => topResults(service, 3);

describe('SearchService RRF rerank (SEARCH_TRAINED_RERANK)', () => {
  const previous = process.env[FLAG];

  afterEach(() => {
    jest.restoreAllMocks();

    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  });

  it('keeps the RRF order, and reads and sends nothing, while the flag is off', async () => {
    delete process.env[FLAG];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { service, dataSource } = build();

    expect(await topThree(service)).toEqual([A, C, B]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('posts the head to /decision/rerank and combines the scores with the RRF order when on', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(reply({ [A]: 0.1, [C]: 0.5, [B]: 0.9 }));
    const { service } = build();

    // Five candidates in the head. orderScore 1, 0.75, 0.5, 0.25, 0 for A, C, B, E, D.
    // final: A = 0.05 + 0.5 = 0.55, C = 0.25 + 0.375 = 0.625, B = 0.45 + 0.25 = 0.70.
    expect(await topThree(service)).toEqual([B, C, A]);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toContain(`/decision/rerank?user_id=${USER}`);
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'coffee with Sam',
      passages: [A, C, B].map((id) => ({
        id: `communication:${id}`,
        text: 'Coffee with Sam\nTuesday at nine',
      })),
    });
  });

  it('keeps the RRF order when the sidecar fails', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    const { service } = build();

    expect(await topThree(service)).toEqual([A, C, B]);
  });

  it('keeps the RRF order when the sidecar stalls past its 800 ms budget', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { service } = build();
    const started = Date.now();

    expect(await topThree(service)).toEqual([A, C, B]);

    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(3000);
  });

  it('keeps the RRF order, and sends nothing, when the passage text cannot be read', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { service } = build({
      readError: new Error('relation "ci_search.mobile_search_documents" does not exist'),
    });

    expect(await topThree(service)).toEqual([A, C, B]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the RRF order, and sends nothing, when the passage read stalls', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { service } = build({ readStalls: true });
    const started = Date.now();

    expect(await topThree(service)).toEqual([A, C, B]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds the passage read in the database too, with a statement timeout for its transaction', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ [A]: 0.1, [C]: 0.5, [B]: 0.9 }));
    const { service, manager } = build();

    await topThree(service);

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set_config('statement_timeout'"),
      ['200ms'],
    );
  });

  it('re-scores at most 50 candidates and leaves the rest of the list in RRF order', async () => {
    process.env[FLAG] = 'true';
    const ids = Array.from(
      { length: 55 },
      (_, i) => `0190c3f2-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const semantic: Hit[] = ids.map((id, i) => ({ id, type: 'communication', score: 1 - i / 100 }));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { passages } = JSON.parse(String(init?.body)) as { passages: Array<{ id: string }> };

      return new Response(
        JSON.stringify({
          user_id: USER,
          results: passages.map((passage) => ({
            id: passage.id,
            score: 0.5,
            is_relevant: true,
            relevance_probability: 0.5,
            temporal_freshness: 1,
            calibrated: true,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const { service } = build({ semantic, keyword: [], texted: ids });

    const order = await topResults(service, 55);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      passages: unknown[];
    };

    expect(sent.passages).toHaveLength(50);
    expect(order.slice(50)).toEqual(ids.slice(50));
  });
});
