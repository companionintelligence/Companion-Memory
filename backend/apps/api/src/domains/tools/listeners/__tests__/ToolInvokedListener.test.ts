import { EventListenerRegistry } from '@ci/domains/events';

import { ToolInvokedEvent, type ToolInvokedPayload } from '../../events';
import { ToolInvokedListener } from '../ToolInvokedListener';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeLedger() {
  return { record: jest.fn().mockResolvedValue({ id: 'row-1' }) } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makePayload(overrides: Partial<ToolInvokedPayload> = {}): ToolInvokedPayload {
  return {
    intent: 'memory.recall',
    tool: 'memory_recall',
    domain: 'memory',
    source: 'native',
    userId: 'user-1',
    correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    capability: 'full',
    occurredAt: '2026-08-26T12:00:00.000Z',
    outcome: 'success',
    durationMs: 42,
    access: 'read',
    external: false,
    destructive: false,
    ...overrides,
  };
}

describe('ToolInvokedListener', () => {
  it('registers a listener on the `telemetry` queue for tool.invoked, so send() routes there instead of dropping it', () => {
    // The @OnEvent decorator runs at class-definition time — importing the class above
    // already registered it. This is the class's headline claim: that its mere existence
    // is what keeps `tool.invoked` from being an orphaned send() with nowhere to land.
    expect(EventListenerRegistry.getQueuesFor(ToolInvokedEvent)).toEqual(new Set(['telemetry']));
  });

  it('PERSISTS the invocation, which is the whole point — a debug line is not a record', async () => {
    const ledger = makeLedger();
    const listener = new ToolInvokedListener(ledger, makeLogger());
    const payload = makePayload();

    await listener.handleToolInvoked(payload);

    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(payload);
  });

  it('persists a refused invocation the same way it persists a successful one', async () => {
    const ledger = makeLedger();
    const listener = new ToolInvokedListener(ledger, makeLogger());

    await listener.handleToolInvoked(
      makePayload({ outcome: 'refused', errorCode: 'TOOL_FORBIDDEN', tool: 'memory_forget' }),
    );

    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'refused', tool: 'memory_forget' }),
    );
  });

  it('still logs the full payload, not a hand-picked subset of it', async () => {
    const logger = makeLogger();
    const listener = new ToolInvokedListener(makeLedger(), logger);

    await listener.handleToolInvoked(makePayload());

    expect(logger.debug).toHaveBeenCalledWith('tool.invoked', {
      intent: 'memory.recall',
      tool: 'memory_recall',
      domain: 'memory',
      source: 'native',
      access: 'read',
      external: false,
      destructive: false,
      outcome: 'success',
      errorCode: undefined,
      durationMs: 42,
      userId: 'user-1',
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      capability: 'full',
    });
  });

  it('does not throw when the optional fields (userId, durationMs) are absent', async () => {
    const ledger = makeLedger();
    const listener = new ToolInvokedListener(ledger, makeLogger());

    await expect(
      listener.handleToolInvoked(makePayload({ userId: undefined, durationMs: undefined })),
    ).resolves.toBeUndefined();

    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined, durationMs: undefined }),
    );
  });
});
