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

/**
 * Semantic ranks A, B, C, D and keyword ranks C, A, E. The RRF order (k = 60) is
 * A, C, B, E, D, so the head of three is A, C, B.
 */
const SEMANTIC = [A, B, C, D].map((id, i) => ({ id, type: 'communication', score: 0.9 - i * 0.1 }));
const KEYWORD = [C, A, E].map((id, i) => ({ id, type: 'communication', score: 1 - i * 0.1 }));

const PASSAGE_ROWS = [A, C, B].map((id) => ({
  entity_type: 'communication',
  id,
  title: 'Coffee with Sam',
  body: 'Tuesday at nine',
}));

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

function build(options: { passageError?: Error } = {}) {
  const dataSource = {
    query: jest.fn(async () => {
      if (options.passageError) {
        throw options.passageError;
      }

      return PASSAGE_ROWS;
    }),
  };
  const events = { send: jest.fn(async () => []) };
  const service = new SearchService(
    dataSource as unknown as DataSource,
    {} as unknown as EmbeddingGenerationService,
    {} as unknown as RetrievalPolicyService,
    events as unknown as EventService,
  );

  type Leg = {
    results: Array<{ id: string; type: string; score: number }>;
    totalMatches: null;
    limit: number;
  };
  const legs = service as unknown as Record<
    'semanticSearch' | 'keywordSearch',
    (...args: unknown[]) => Promise<Leg>
  >;

  jest.spyOn(legs, 'semanticSearch').mockResolvedValue({ results: SEMANTIC, totalMatches: null, limit: 50 });
  jest.spyOn(legs, 'keywordSearch').mockResolvedValue({ results: KEYWORD, totalMatches: null, limit: 50 });

  return { service, dataSource };
}

async function topThree(service: SearchService): Promise<string[]> {
  const page = await service.searchPage(CONTEXT, {
    query: 'coffee with Sam',
    mode: 'hybrid',
    fusionMode: 'rrf',
    maxResults: 3,
  });

  return page.items.map((item) => item.id);
}

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

  it('keeps the RRF order and makes no request while the flag is off', async () => {
    delete process.env[FLAG];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { service, dataSource } = build();

    expect(await topThree(service)).toEqual([A, C, B]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
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

  it('keeps the RRF order, and sends nothing, when the passage text cannot be read', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { service } = build({
      passageError: new Error('relation "ci_search.mobile_search_documents" does not exist'),
    });

    expect(await topThree(service)).toEqual([A, C, B]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
