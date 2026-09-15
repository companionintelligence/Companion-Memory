import type { LoggerService } from '@ci/common/logging';
import type { Acknowledgement } from '@ci/domains/events';

import { PythonFunctionDispatchListener } from '../listeners/PythonFunctionDispatchListener';
import { PYTHON_FUNCTIONS } from '../types';

function makeLogger() {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService & { error: jest.Mock; warn: jest.Mock; log: jest.Mock };
}

const logger = makeLogger();

// No `jobId` here any more. It was never the domain's field — the event bus
// used to merge pg-boss's id into every delivered payload, and this listener
// was the one consumer that legitimately wanted it. It now rides the ack, where
// tsc can see it.
const payload = {
  target: 'summary' as const,
  function: 'hourly_summary',
  args: { user_id: 'user-1' },
  userId: 'user-1',
};

function makeAck(): Acknowledgement {
  return { jobId: 'job-1', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

/** A json-capable stand-in for the catalog route, listing every allowlisted name. */
function catalogResponse(target: 'summary' | 'hbpe' = 'summary') {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ functions: [...PYTHON_FUNCTIONS[target]] }),
  };
}

/** Every fetch the listener made whose URL ends in `/functions/run`. */
function runCalls(fetchMock: jest.Mock): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url.endsWith('/functions/run'));
}

describe('PythonFunctionDispatchListener', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('POSTs the run to /functions/run and defers the job on 2xx', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/functions') ? catalogResponse() : { ok: true }),
      );

    global.fetch = fetchMock as unknown as typeof fetch;

    const listener = new PythonFunctionDispatchListener(logger);
    const ack = makeAck();

    await listener.dispatchSummary(payload, ack);

    const runs = runCalls(fetchMock);

    expect(runs).toHaveLength(1);

    const [, init] = runs[0];

    expect(JSON.parse(String(init.body))).toEqual({
      function: 'hourly_summary',
      args: { user_id: 'user-1' },
      job_id: 'job-1',
      queue: 'py-fn-summary',
    });

    expect(ack.defer).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
    expect(ack.done).not.toHaveBeenCalled();
  });

  it('takes job_id from the ACK, not from anything the payload happens to carry', async () => {
    // The completion path depends on this exact id: the sidecar echoes it back
    // to PythonFunctionCallbackController, which calls
    // `boss.complete(queue, jobId)`. Send a payload carrying a DIFFERENT and
    // plausible-looking `jobId` — the wire must ignore it.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(catalogResponse())
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('{}') }) as never;

    const ack = makeAck();
    ack.jobId = 'pgboss-job-2';

    await new PythonFunctionDispatchListener(logger).dispatchSummary(
      { ...payload, jobId: 'a-domain-id-that-must-not-win' } as never,
      ack,
    );

    const runs = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).includes('/functions/run'),
    );

    expect(JSON.parse(String(runs[0][1].body)).job_id).toBe('pgboss-job-2');
  });

  it('fails the job (for pg-boss retry) when the runner rejects the dispatch', async () => {
    global.fetch = jest
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          url.endsWith('/functions')
            ? catalogResponse()
            : { ok: false, status: 429, text: () => Promise.resolve('pool full') },
        ),
      ) as unknown as typeof fetch;

    const listener = new PythonFunctionDispatchListener(logger);
    const ack = makeAck();

    await listener.dispatchSummary(payload, ack);

    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.defer).not.toHaveBeenCalled();
  });

  it('fails the job when the runner is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const listener = new PythonFunctionDispatchListener(logger);
    const ack = makeAck();

    await listener.dispatchHbpe({ ...payload, target: 'hbpe', function: 'nightly' }, ack);

    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.defer).not.toHaveBeenCalled();
  });

  describe('function-catalog preflight', () => {
    it('logs an ERROR naming the sidecar version when the catalog route is absent', async () => {
      // The stale-image shape: /health answers, /functions does not exist.
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.endsWith('/functions')) {
          return Promise.resolve({ ok: false, status: 404 });
        }

        if (url.endsWith('/health')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        }

        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      const listener = new PythonFunctionDispatchListener(logger);
      const ack = makeAck();

      await listener.dispatchHbpe({ ...payload, target: 'hbpe', function: 'nightly' }, ack);

      expect(logger.error).toHaveBeenCalledTimes(1);

      const [message, meta] = (logger.error as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];

      expect(message).toMatch(/does not serve its function catalog/);
      expect(meta).toMatchObject({ target: 'hbpe', status: 404, version: 'not reported' });

      // Advisory only — the dispatch still went out and still deferred.
      expect(ack.defer).toHaveBeenCalledTimes(1);
    });

    it('logs an ERROR naming the functions the sidecar does not serve', async () => {
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.endsWith('/functions')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ functions: ['nightly'] }),
          });
        }

        if (url.endsWith('/health')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ version: '0.2.0' }),
          });
        }

        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      const listener = new PythonFunctionDispatchListener(logger);

      await listener.dispatchHbpe({ ...payload, target: 'hbpe', function: 'nightly' }, makeAck());

      const [, meta] = (logger.error as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];

      expect(meta).toMatchObject({
        target: 'hbpe',
        missing: ['bootstrap', 'ensure_bootstrap'],
        version: '0.2.0',
      });
    });

    it('probes each target once per process, not once per dispatch', async () => {
      const fetchMock = jest
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(url.endsWith('/functions') ? catalogResponse() : { ok: true }),
        );

      global.fetch = fetchMock as unknown as typeof fetch;

      const listener = new PythonFunctionDispatchListener(logger);

      await Promise.all([
        listener.dispatchSummary(payload, makeAck()),
        listener.dispatchSummary(payload, makeAck()),
      ]);
      await listener.dispatchSummary(payload, makeAck());

      const catalogCalls = (fetchMock.mock.calls as [string][]).filter(([url]) => url.endsWith('/functions'));

      expect(catalogCalls).toHaveLength(1);
      expect(runCalls(fetchMock)).toHaveLength(3);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not block the dispatch when the probe itself throws', async () => {
      const fetchMock = jest
        .fn()
        .mockImplementation((url: string) =>
          url.endsWith('/functions')
            ? Promise.reject(new Error('socket hang up'))
            : Promise.resolve({ ok: true }),
        );

      global.fetch = fetchMock as unknown as typeof fetch;

      const listener = new PythonFunctionDispatchListener(logger);
      const ack = makeAck();

      await listener.dispatchSummary(payload, ack);

      expect(ack.defer).toHaveBeenCalledTimes(1);
      expect(ack.fail).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });
});
