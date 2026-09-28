import { ApiError, ImportApiClient, UnreachableError } from '../client';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };

    calls.push(call);

    return responder(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('ImportApiClient', () => {
  it('sends the api key as x-api-key and hits unprefixed import paths', async () => {
    const { fetchImpl, calls } = stubFetch(() => json([]));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'secret', fetchImpl });

    await client.listSources();

    expect(calls[0].url).toBe('http://box:3030/import/sources');
    expect(calls[0].headers['x-api-key']).toBe('secret');
  });

  it('uses the appliance-wide ingest lifecycle status route', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ tables: {}, searchIndex: {}, at: '' }));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await client.ingestStatus();

    expect(calls[0].url).toBe('http://box:3030/v1/ingest/status?scope=appliance');
  });

  it('omits an absent api key entirely rather than sending an empty one', async () => {
    const { fetchImpl, calls } = stubFetch(() => json([]));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await client.listSources();

    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('drops undefined query parameters instead of sending "undefined"', async () => {
    const { fetchImpl, calls } = stubFetch(() => json([]));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await client.listRuns(undefined);
    await client.listRuns(10);

    expect(calls[0].url).toBe('http://box:3030/import/runs');
    expect(calls[1].url).toBe('http://box:3030/import/runs?limit=10');
  });

  it('uses PATCH for the write-only Memory inference endpoint update', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({
        backend: 'openai_compatible',
        port: 8000,
        hostGateway: 'host.docker.internal',
        locked: false,
        endpoint: 'http://host.docker.internal:8000/v1',
        apiKeyConfigured: true,
      }),
    );
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'secret', fetchImpl });

    await client.updateLlmEndpoint({ backend: 'openai_compatible', port: 8000, apiKey: 'write-only' });

    expect(calls[0]).toMatchObject({
      url: 'http://box:3030/llm/endpoint',
      method: 'PATCH',
      body: JSON.stringify({ backend: 'openai_compatible', port: 8000, apiKey: 'write-only' }),
    });
  });

  it('POSTs a failed-push retry to the run’s own route, id encoded', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ items: 437, entities: 0, requeued: true }));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'secret', fetchImpl });

    expect(await client.retryFailedPush('68bffe0a-1dbe-4783-a226-49149f45ec4f')).toEqual({
      items: 437,
      entities: 0,
      requeued: true,
    });
    expect(calls[0]).toMatchObject({
      url: 'http://box:3030/import/runs/68bffe0a-1dbe-4783-a226-49149f45ec4f/push/retry',
      method: 'POST',
    });

    await client.retryFailedPush('a/b');

    expect(calls[1].url).toBe('http://box:3030/import/runs/a%2Fb/push/retry');
  });

  it('turns a 401 into the one-line fix', async () => {
    const { fetchImpl } = stubFetch(() => json({ message: 'Unauthorized' }, 401));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await expect(client.listSources()).rejects.toThrow(/Set CI_API_KEY/);
  });

  it('says the key was rejected when one was actually sent', async () => {
    const { fetchImpl } = stubFetch(() => json({ message: 'Unauthorized' }, 401));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'bad', fetchImpl });

    await expect(client.listSources()).rejects.toThrow(/api key was rejected/);
  });

  it('carries the server’s own message through on other failures', async () => {
    const { fetchImpl } = stubFetch(() => json({ message: ['dropId is required'] }, 400));
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

    await expect(client.startRun({ dropId: '' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('dropId is required'),
    });
  });

  it('names an unreachable appliance rather than leaking a socket error', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: null, fetchImpl });

    await expect(client.listSources()).rejects.toBeInstanceOf(UnreachableError);
    await expect(client.listSources()).rejects.toThrow(/CI_SERVER_URL/);
  });

  describe('orchestrate', () => {
    const ndjson = (lines: unknown[]) =>
      new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
        headers: { 'content-type': 'application/x-ndjson' },
      });

    it('asks for the stream, so a multi-hour leg cannot hit the headers timeout', async () => {
      const { fetchImpl, calls } = stubFetch(() =>
        ndjson([{ type: 'result', ok: true, legs: [], totalDurationMs: 1 }]),
      );
      const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

      await client.orchestrate(undefined);

      expect(calls[0].headers.accept).toBe('application/x-ndjson');
      expect(JSON.parse(calls[0].body as string)).toEqual({ abortOnError: false });
    });

    it('forwards progress lines and resolves with the result frame', async () => {
      const seen: string[] = [];
      const { fetchImpl } = stubFetch(() =>
        ndjson([
          { type: 'leg-start', leg: 'geocode' },
          { type: 'tick' },
          {
            type: 'result',
            ok: true,
            legs: [{ leg: 'geocode', ok: true, durationMs: 5 }],
            totalDurationMs: 5,
          },
        ]),
      );
      const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

      const summary = await client.orchestrate(['geocode'], {
        onLine: (line) => seen.push(String(line.type)),
      });

      expect(seen).toEqual(['leg-start', 'tick']);
      expect(summary).toEqual({
        ok: true,
        legs: [{ leg: 'geocode', ok: true, durationMs: 5 }],
        totalDurationMs: 5,
      });
    });

    it('reassembles a frame split across chunk boundaries', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();

          controller.enqueue(encoder.encode('{"type":"result","ok":true,"legs":[],"tot'));
          controller.enqueue(encoder.encode('alDurationMs":7}\n'));
          controller.close();
        },
      });

      const fetchImpl = (async () =>
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        })) as unknown as typeof fetch;
      const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

      await expect(client.orchestrate(undefined)).resolves.toMatchObject({ totalDurationMs: 7 });
    });

    it('treats a stream that never reports a result as a failure, not an empty run', async () => {
      const { fetchImpl } = stubFetch(() => ndjson([{ type: 'leg-start', leg: 'geocode' }]));
      const client = new ImportApiClient({ baseUrl: 'http://box:3030', apiKey: 'k', fetchImpl });

      await expect(client.orchestrate(undefined)).rejects.toBeInstanceOf(ApiError);
      await expect(client.orchestrate(undefined)).rejects.toThrow(/may have restarted/);
    });
  });
});
