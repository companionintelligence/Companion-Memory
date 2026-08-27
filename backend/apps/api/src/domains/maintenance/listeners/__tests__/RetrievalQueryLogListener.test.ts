import { EventListenerRegistry } from '@ci/domains/events';
import { RetrievalQueryEvent, type RetrievalQueryPayload } from '@ci/domains/search-next';

import { RetrievalQueryLogListener } from '../RetrievalQueryLogListener';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as never;
}

function makePayload(overrides: Partial<RetrievalQueryPayload> = {}): RetrievalQueryPayload {
  return {
    userId: '00000000-0000-0000-0000-0000000000aa',
    caller: 'search',
    modeTaken: 'semantic',
    queryTokenCount: 6,
    includeTypes: null,
    excludeTypes: ['message', 'position'],
    resultCount: 0,
    topScore: null,
    latencyMs: 41,
    ...overrides,
  };
}

function makeListener() {
  const insert = jest.fn().mockResolvedValue({ identifiers: [] });
  const logger = makeLogger();
  const listener = new RetrievalQueryLogListener({ insert } as never, logger);

  return { listener, insert, logger };
}

describe('RetrievalQueryLogListener', () => {
  it('registers a listener on the `telemetry` queue, so send() routes there instead of dropping it', () => {
    // `EventService.send(..., { queue })` validates the queue against the
    // REGISTERED listener queues and warns-and-drops when nobody consumes it —
    // a sender without a listener is a silent no-op (the SEARCH_EMBED_ENTITY
    // bug). The @OnEvent decorator ran at class-definition time, so importing
    // the class above already registered it.
    expect(EventListenerRegistry.getQueuesFor(RetrievalQueryEvent)).toEqual(new Set(['telemetry']));
  });

  it('persists the payload verbatim, minus the fields the row derives itself', async () => {
    const { listener, insert } = makeListener();

    await listener.handleRetrievalQuery(makePayload({ resultCount: 3, topScore: 0.87 }));

    const [row] = insert.mock.calls[0] as [Record<string, unknown>];

    expect(row).toMatchObject({
      userId: '00000000-0000-0000-0000-0000000000aa',
      caller: 'search',
      modeTaken: 'semantic',
      queryTokenCount: 6,
      includeTypes: null,
      excludeTypes: ['message', 'position'],
      resultCount: 3,
      topScore: 0.87,
      latencyMs: 41,
    });
  });

  it('never writes zero_result — the column is GENERATED from result_count and cannot be allowed to disagree', async () => {
    const { listener, insert } = makeListener();

    await listener.handleRetrievalQuery(makePayload({ resultCount: 0 }));

    const [row] = insert.mock.calls[0] as [Record<string, unknown>];

    expect(row).not.toHaveProperty('zeroResult');
    expect(row).not.toHaveProperty('zero_result');
  });

  it('never writes a query, prompt, or any other free text', async () => {
    const { listener, insert } = makeListener();

    await listener.handleRetrievalQuery(makePayload());

    const [row] = insert.mock.calls[0] as [Record<string, unknown>];

    expect(row).not.toHaveProperty('query');
    expect(row).not.toHaveProperty('prompt');
    expect(row).not.toHaveProperty('text');
  });

  it('stamps `ts` at insert rather than trusting the producer, so queue lag cannot rewrite history', async () => {
    const { listener, insert } = makeListener();

    const before = Date.now();

    await listener.handleRetrievalQuery(makePayload());

    const [row] = insert.mock.calls[0] as [{ ts: Date }];

    expect(row.ts).toBeInstanceOf(Date);
    expect(row.ts.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('drops a payload with no userId instead of failing the job forever', async () => {
    // `user_id` is NOT NULL with an FK to ci.users, so such a row can never be
    // stored; retrying it to the dead-letter queue buys nothing.
    const { listener, insert, logger } = makeListener();

    await listener.handleRetrievalQuery(makePayload({ userId: '' }));

    expect(insert).not.toHaveBeenCalled();
    expect((logger as unknown as { warn: jest.Mock }).warn).toHaveBeenCalled();
  });
});
