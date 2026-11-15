import {
  DECISION_TIMEOUT_MS,
  DecisionClient,
  type DecisionPassage,
  HBPE_DEFAULT_BASE_URL,
  resolveHbpeBaseUrl,
} from '../decisionClient';

const USER = '0190c3f2-0000-7000-8000-000000000001';
const BASE = 'http://hbpe.test:8002';
const SECRET = 'test-sidecar-secret';

const INGRESS_REPLY = {
  user_id: USER,
  intent: 'store_task',
  intent_confidence: 0.8,
  intent_distribution: { store_task: 0.8, conversational: 0.2 },
  is_commitment: true,
  commitment_probability: 0.91,
  sensitivity: 1,
  sensitivity_distribution: { general_info: 0.1, personal_private: 0.9 },
  calibrated: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetchMock: jest.Mock, options: { timeoutMs?: number } = {}): DecisionClient {
  return new DecisionClient({
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    headers: () => ({ Authorization: `Bearer ${SECRET}` }),
    ...options,
  });
}

function sentBody(fetchMock: jest.Mock, call = 0): unknown {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;

  return JSON.parse(String(init.body));
}

describe('resolveHbpeBaseUrl', () => {
  it('defaults to the local sidecar port when HBPE_BASE_URL is unset or blank', () => {
    expect(resolveHbpeBaseUrl({})).toBe(HBPE_DEFAULT_BASE_URL);
    expect(resolveHbpeBaseUrl({ HBPE_BASE_URL: '   ' })).toBe('http://localhost:8002');
  });

  it('reads HBPE_BASE_URL without a trailing slash', () => {
    expect(resolveHbpeBaseUrl({ HBPE_BASE_URL: 'http://hbpe-service:8002/' })).toBe(
      'http://hbpe-service:8002',
    );
  });
});

describe('DecisionClient.ingress', () => {
  it('POSTs {text} to /decision/ingress with user_id in the query and the sidecar bearer', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(INGRESS_REPLY));

    const decision = await clientWith(fetchMock).ingress(USER, 'Remind me to call the vet');

    expect(decision).toEqual(INGRESS_REPLY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe(`${BASE}/decision/ingress?user_id=${USER}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    });
    expect(init.signal).toBeDefined();
    expect(sentBody(fetchMock)).toEqual({ text: 'Remind me to call the vet' });
  });

  it('sends nothing for blank text or a user id the sidecar would refuse', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(INGRESS_REPLY));
    const client = clientWith(fetchMock);

    await expect(client.ingress(USER, '   ')).resolves.toBeUndefined();
    await expect(client.ingress('user-1', 'hello')).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cuts text to the sidecar limit of 8000 code points', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(INGRESS_REPLY));

    await clientWith(fetchMock).ingress(USER, 'a'.repeat(9000));

    expect((sentBody(fetchMock) as { text: string }).text).toHaveLength(8000);
  });

  it('resolves undefined on a non-2xx reply, a malformed body, or a network error', async () => {
    const serverError = jest.fn(async () => jsonResponse({ detail: 'boom' }, 500));
    const malformed = jest.fn(async () => jsonResponse({ intent: 'store_task' }));
    const network = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(clientWith(serverError).ingress(USER, 'x')).resolves.toBeUndefined();
    await expect(clientWith(malformed).ingress(USER, 'x')).resolves.toBeUndefined();
    await expect(clientWith(network).ingress(USER, 'x')).resolves.toBeUndefined();
  });

  it('resolves undefined when the sidecar exceeds the timeout', async () => {
    const hangsUntilAborted = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    await expect(
      clientWith(hangsUntilAborted, { timeoutMs: 20 }).ingress(USER, 'x'),
    ).resolves.toBeUndefined();
    expect(hangsUntilAborted).toHaveBeenCalledTimes(1);
  });

  it('gives the sidecar 800 ms, the budget the decision callers were specified against', () => {
    expect(DECISION_TIMEOUT_MS).toBe(800);
  });
});

describe('DecisionClient.rerank', () => {
  it('POSTs the query and the passages to /decision/rerank and returns the scored results', async () => {
    const results = [
      {
        id: 'communication:a',
        score: 0.7,
        is_relevant: true,
        relevance_probability: 0.8,
        temporal_freshness: 2,
        calibrated: true,
      },
    ];
    const fetchMock = jest.fn(async () => jsonResponse({ user_id: USER, results }));

    const out = await clientWith(fetchMock).rerank(USER, 'coffee with Sam', [
      { id: 'communication:a', text: 'Coffee with Sam on Tuesday' },
      { id: 'communication:b', text: '   ' },
    ]);

    expect(out).toEqual(results);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];

    expect(url).toBe(`${BASE}/decision/rerank?user_id=${USER}`);
    expect(sentBody(fetchMock)).toEqual({
      query: 'coffee with Sam',
      passages: [{ id: 'communication:a', text: 'Coffee with Sam on Tuesday' }],
    });
  });

  it('sends nothing when there is no query or no passage with text', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ user_id: USER, results: [] }));
    const client = clientWith(fetchMock);

    await expect(client.rerank(USER, '  ', [{ id: 'a', text: 'x' }])).resolves.toBeUndefined();
    await expect(client.rerank(USER, 'q', [])).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws on malformed input', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ user_id: USER, results: [] }));
    const client = clientWith(fetchMock);

    await expect(
      client.rerank(USER, 'q', [null, { id: 7, text: 'x' }] as unknown as DecisionPassage[]),
    ).resolves.toBeUndefined();
    await expect(
      client.rerank(USER, 'q', undefined as unknown as DecisionPassage[]),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends at most 100 passages', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ user_id: USER, results: [] }));
    const passages = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, text: `passage ${i}` }));

    await clientWith(fetchMock).rerank(USER, 'q', passages);

    expect((sentBody(fetchMock) as { passages: unknown[] }).passages).toHaveLength(100);
  });

  it('resolves undefined when the reply has results without a usable score', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ user_id: USER, results: [{ id: 'a' }] }));

    await expect(clientWith(fetchMock).rerank(USER, 'q', [{ id: 'a', text: 'x' }])).resolves.toBeUndefined();
  });
});

describe('DecisionClient.classifyL0', () => {
  it('sends the title, and the description only when there is one', async () => {
    const reply = {
      user_id: USER,
      l0_class: 'EXERCISE',
      confidence: 0.6,
      distribution: { EXERCISE: 0.6 },
      calibrated: true,
    };
    const fetchMock = jest.fn(async () => jsonResponse(reply));
    const client = clientWith(fetchMock);

    await expect(client.classifyL0(USER, 'Morning run')).resolves.toEqual(reply);
    await client.classifyL0(USER, 'Morning run', 'Along the river');

    expect(sentBody(fetchMock, 0)).toEqual({ title: 'Morning run' });
    expect(sentBody(fetchMock, 1)).toEqual({ title: 'Morning run', description: 'Along the river' });
  });
});
