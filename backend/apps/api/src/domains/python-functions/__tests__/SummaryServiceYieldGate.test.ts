import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { YieldGateRegistry } from '@ci/domains/events';

import {
  MAX_RUNS_IN_FLIGHT,
  OPEN_RECHECK_MS,
  SummaryServiceYieldGate,
  WAITING_RECHECK_MS,
} from '../services/SummaryServiceYieldGate';
import { PYTHON_FUNCTION_QUEUE_OPTIONS, PYTHON_FUNCTION_QUEUES, SUMMARY_SERVICE_YIELD_GATE } from '../types';

function makeLogger() {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService & { warn: jest.Mock };
}

function health(model: unknown): Response {
  return new Response(JSON.stringify({ status: 'degraded', llm: { reachable: false, model } }), {
    status: 200,
  });
}

/** Lets the background `/health` request and its `.json()` settle. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('SummaryServiceYieldGate', () => {
  let fetchMock: jest.SpyInstance;
  let now: number;
  let inFlight: number;
  let query: jest.Mock;

  function makeGate(logger = makeLogger()): SummaryServiceYieldGate {
    return new SummaryServiceYieldGate({ query } as unknown as DataSource, logger);
  }

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock = jest.spyOn(global, 'fetch');
    inFlight = 0;
    query = jest.fn(() => Promise.resolve([{ active: inFlight }]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    YieldGateRegistry.clear();
  });

  it('holds the queue until the summary service has answered', async () => {
    fetchMock.mockResolvedValue(health('small-chat'));

    const gate = makeGate();

    await expect(gate.shouldYield()).resolves.toBe(true);
    await settled();
    await expect(gate.shouldYield()).resolves.toBe(false);
  });

  it('holds the queue while there is no model and opens without a restart when one appears', async () => {
    fetchMock.mockResolvedValue(health(null));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();
    await expect(gate.shouldYield()).resolves.toBe(true);

    // Asked once a minute however often the worker loop asks the gate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += WAITING_RECHECK_MS - 1;
    await gate.shouldYield();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(health('small-chat'));
    now += 1;
    await gate.shouldYield();
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(gate.shouldYield()).resolves.toBe(false);
  });

  it('asks a healthy appliance far less often and closes if a restart lost the model', async () => {
    fetchMock.mockResolvedValue(health('small-chat'));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();

    now += OPEN_RECHECK_MS - 1;
    await gate.shouldYield();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(health(null));
    now += 1;
    await gate.shouldYield();
    await settled();

    await expect(gate.shouldYield()).resolves.toBe(true);
  });

  it('stays closed when the summary service does not answer and says so once', async () => {
    const logger = makeLogger();

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const gate = makeGate(logger);

    await gate.shouldYield();
    await settled();
    now += WAITING_RECHECK_MS;
    await gate.shouldYield();
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(gate.shouldYield()).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('opens for a summary service that answers without mentioning a model', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();

    await expect(gate.shouldYield()).resolves.toBe(false);
  });

  it('stays closed on an error status, whatever its body says', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'bad gateway' }), { status: 502 }));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();

    await expect(gate.shouldYield()).resolves.toBe(true);
  });

  it('stands aside while the summary service already holds enough runs and counts only that queue', async () => {
    fetchMock.mockResolvedValue(health('small-chat'));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();

    inFlight = MAX_RUNS_IN_FLIGHT - 1;
    await expect(gate.shouldYield()).resolves.toBe(false);

    inFlight = MAX_RUNS_IN_FLIGHT;
    await expect(gate.shouldYield()).resolves.toBe(true);

    inFlight = MAX_RUNS_IN_FLIGHT - 1;
    await expect(gate.shouldYield()).resolves.toBe(false);

    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("state = 'active'"), [
      PYTHON_FUNCTION_QUEUES.summary,
      null,
    ]);
  });

  it('counts only runs started since the summary service did, and learns of a restart at its next look', async () => {
    const startedAt = (at: string) =>
      new Response(JSON.stringify({ started_at: at, llm: { reachable: true, model: 'small-chat' } }), {
        status: 200,
      });

    fetchMock.mockResolvedValue(startedAt('2026-11-02T10:00:00+00:00'));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();
    await gate.shouldYield();

    const asked = query.mock.lastCall as [string, unknown[]];

    expect(asked[0]).toContain('started_on >= $2');
    expect(asked[1]).toEqual([PYTHON_FUNCTION_QUEUES.summary, '2026-11-02T10:00:00+00:00']);

    fetchMock.mockResolvedValue(startedAt('2026-11-02T11:00:00+00:00'));
    now += OPEN_RECHECK_MS;
    await gate.shouldYield();
    await settled();
    await gate.shouldYield();

    expect((query.mock.lastCall as [string, unknown[]])[1]).toEqual([
      PYTHON_FUNCTION_QUEUES.summary,
      '2026-11-02T11:00:00+00:00',
    ]);
  });

  it.each([[undefined], ['not a time'], [12345]])(
    'counts every active run when the summary service gives %p for its start',
    async (startedAt) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ started_at: startedAt, llm: { model: 'small-chat' } }), {
          status: 200,
        }),
      );

      const gate = makeGate();

      await gate.shouldYield();
      await settled();
      await gate.shouldYield();

      expect((query.mock.lastCall as [string, unknown[]])[1]).toEqual([PYTHON_FUNCTION_QUEUES.summary, null]);
    },
  );

  it('closes at once when a dispatch fails and opens again once the service answers', async () => {
    fetchMock.mockResolvedValue(health('small-chat'));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();
    await expect(gate.shouldYield()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(health('small-chat'));
    gate.handoverFailed();

    // Well inside OPEN_RECHECK_MS, and it asks straight away instead of waiting that out.
    await expect(gate.shouldYield()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settled();
    await expect(gate.shouldYield()).resolves.toBe(false);
  });

  it('does not count runs while it is waiting for a model', async () => {
    fetchMock.mockResolvedValue(health(null));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();
    await gate.shouldYield();

    expect(query).not.toHaveBeenCalled();
  });

  it('never has two requests in flight', async () => {
    let answer: (response: Response) => void = () => undefined;

    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );

    const gate = makeGate();

    await gate.shouldYield();
    now += WAITING_RECHECK_MS * 2;
    await gate.shouldYield();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(health(null));
    await settled();
  });

  it('is the gate only py-fn-summary names', async () => {
    fetchMock.mockResolvedValue(health(null));

    const gate = makeGate();

    await gate.shouldYield();
    await settled();

    expect(PYTHON_FUNCTION_QUEUE_OPTIONS.summary.yieldsTo).toBe(SUMMARY_SERVICE_YIELD_GATE);
    // One job per fetch, or a batch overshoots MAX_RUNS_IN_FLIGHT.
    expect(PYTHON_FUNCTION_QUEUE_OPTIONS.summary.localConcurrency).toBe(1);
    expect(PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.yieldsTo).toBeUndefined();
    await expect(YieldGateRegistry.shouldYield(SUMMARY_SERVICE_YIELD_GATE)).resolves.toBe(true);
  });
});
