import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import config from '@ci/configuration';

import { DecisionClient, type DecisionPassage } from '../decisionClient';

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

describe('DecisionClient base URL', () => {
  const previous = process.env.HBPE_BASE_URL;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.HBPE_BASE_URL;
    } else {
      process.env.HBPE_BASE_URL = previous;
    }
  });

  it('posts to the services.hbpe.host setting, the one HbpeService uses', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(INGRESS_REPLY));
    const client = new DecisionClient({ fetch: fetchMock as unknown as typeof fetch, headers: () => ({}) });

    await client.ingress(USER, 'Remind me to call the vet');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];

    expect(url).toBe(`${config.services.hbpe.host.replace(/\/+$/, '')}/decision/ingress?user_id=${USER}`);
  });

  it('ignores HBPE_BASE_URL, so one setting governs both callers', async () => {
    process.env.HBPE_BASE_URL = 'http://elsewhere.test:9999';
    const fetchMock = jest.fn(async () => jsonResponse(INGRESS_REPLY));
    const client = new DecisionClient({ fetch: fetchMock as unknown as typeof fetch, headers: () => ({}) });

    await client.ingress(USER, 'Remind me to call the vet');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];

    expect(url).not.toContain('elsewhere.test');
    expect(url).toContain(config.services.hbpe.host.replace(/\/+$/, ''));
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

  it('cuts text to 8000 code points, so a supplementary-plane character is never split', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(INGRESS_REPLY));
    const emoji = '\u{1F600}'; // U+1F600: one code point, two UTF-16 code units.

    await clientWith(fetchMock).ingress(USER, emoji.repeat(9000));

    const sent = (sentBody(fetchMock) as { text: string }).text;

    expect(Array.from(sent)).toHaveLength(8000);
    expect(sent).toHaveLength(16000);
    expect(Array.from(sent).every((character) => character === emoji)).toBe(true);
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

  it('resolves undefined when a reply has no numeric commitment probability', async () => {
    // JSON.stringify drops an undefined property, so the reply goes out without it.
    const fetchMock = jest.fn(async () =>
      jsonResponse({ ...INGRESS_REPLY, commitment_probability: undefined }),
    );

    await expect(clientWith(fetchMock).ingress(USER, 'x')).resolves.toBeUndefined();
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
});

describe('DecisionClient against a sidecar that accepts and never answers', () => {
  let server: Server;
  let stalledBase: string;
  let accepted = 0;

  beforeAll(async () => {
    server = createServer(() => {
      accepted += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    stalledBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('gives up after the 800 ms default budget and resolves undefined', async () => {
    const client = new DecisionClient({ baseUrl: stalledBase, headers: () => ({}) });
    const started = Date.now();

    await expect(client.ingress(USER, 'Remind me to call the vet')).resolves.toBeUndefined();

    const elapsed = Date.now() - started;

    expect(accepted).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(3000);
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
