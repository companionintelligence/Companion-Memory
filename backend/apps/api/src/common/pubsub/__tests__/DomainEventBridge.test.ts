import { EventEmitter2 } from '@nestjs/event-emitter';

import { ContextService } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { DomainEventBridge } from '../listeners/DomainEventBridge';
import { PubSubService } from '../PubSubService';

function makeLogger(): LoggerService {
  return {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;
}

async function flush(): Promise<void> {
  // The bridge dispatches the publish asynchronously inside an
  // `EventEmitter2.onAny` callback that returns synchronously. Yielding
  // twice lets both the immediate microtask and the publish promise resolve.
  await Promise.resolve();
  await Promise.resolve();
}

describe('DomainEventBridge', () => {
  function build() {
    const emitter = new EventEmitter2({ wildcard: false });
    const pubsub = new PubSubService(makeLogger());
    const bridge = new DomainEventBridge(emitter, pubsub, makeLogger());
    bridge.onModuleInit();

    return { emitter, pubsub };
  }

  it('republishes person.created to entity.<user>.Person', async () => {
    const { emitter, pubsub } = build();
    const received: unknown[] = [];

    pubsub.subscribe('entity.alice.Person', (p) => {
      received.push(p);
    });

    await ContextService.run({ userId: 'alice', traceId: 'trace-1' }, async () => {
      emitter.emit('person.created', { entityId: 'p1' });
      await flush();
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: 'person.created',
      payload: { entityId: 'p1' },
    });
  });

  it('strips :queue suffix that LocalEventService appends', async () => {
    const { emitter, pubsub } = build();
    const seen: unknown[] = [];

    pubsub.subscribe('entity.alice.Concept', (p) => {
      seen.push(p);
    });

    await ContextService.run({ userId: 'alice', traceId: 'trace-1' }, async () => {
      emitter.emit('concept.created:default', { entityId: 'c1' });
      await flush();
    });

    expect(seen).toHaveLength(1);
  });

  it('routes message.created onto thread.<user>.message', async () => {
    const { emitter, pubsub } = build();
    const seen: unknown[] = [];

    pubsub.subscribe('thread.alice.message', (p) => {
      seen.push(p);
    });

    await ContextService.run({ userId: 'alice', traceId: 'trace-1' }, async () => {
      emitter.emit('message.created', { messageId: 'm1' });
      await flush();
    });

    expect(seen).toHaveLength(1);
  });

  it('does not cross actor boundaries', async () => {
    const { emitter, pubsub } = build();
    let alice = 0;
    let bob = 0;

    pubsub.subscribe('entity.alice.*', () => {
      alice++;
    });
    pubsub.subscribe('entity.bob.*', () => {
      bob++;
    });

    await ContextService.run({ userId: 'alice', traceId: 'trace-1' }, async () => {
      emitter.emit('person.created', { entityId: 'p1' });
      await flush();
    });

    await ContextService.run({ userId: 'bob', traceId: 'trace-2' }, async () => {
      emitter.emit('person.created', { entityId: 'p2' });
      await flush();
    });

    expect(alice).toBe(1);
    expect(bob).toBe(1);
  });

  it('drops events with no agent-relevant mapping', async () => {
    const { emitter, pubsub } = build();
    let any = 0;

    pubsub.subscribe('*.*.*', () => {
      any++;
    });
    pubsub.subscribe('*.*', () => {
      any++;
    });

    await ContextService.run({ userId: 'alice', traceId: 'trace-1' }, async () => {
      emitter.emit('cron.tick', {});
      await flush();
    });

    expect(any).toBe(0);
  });
});
