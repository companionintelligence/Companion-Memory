import type { LoggerService } from '@ci/common/logging';

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

describe('PubSubService', () => {
  it('delivers a payload to a matching literal subscription', async () => {
    const ps = new PubSubService(makeLogger());
    const received: unknown[] = [];

    ps.subscribe('entity.alice.Person', (p) => {
      received.push(p);
    });

    expect(await ps.publish('entity.alice.Person', { id: '1' })).toBe(1);
    expect(received).toEqual([{ id: '1' }]);
  });

  it('uses * wildcard for any one segment', async () => {
    const ps = new PubSubService(makeLogger());
    const seen: string[] = [];

    ps.subscribe('entity.alice.*', (p: unknown) => {
      seen.push((p as { type: string }).type);
    });

    await ps.publish('entity.alice.Person', { type: 'Person' });
    await ps.publish('entity.alice.Concept', { type: 'Concept' });
    await ps.publish('entity.bob.Person', { type: 'Person' });

    expect(seen).toEqual(['Person', 'Concept']);
  });

  it('does not cross actor boundaries', async () => {
    const ps = new PubSubService(makeLogger());
    let aliceCount = 0;
    let bobCount = 0;

    ps.subscribe('entity.alice.*', () => {
      aliceCount++;
    });
    ps.subscribe('entity.bob.*', () => {
      bobCount++;
    });

    await ps.publish('entity.alice.Person', {});
    await ps.publish('entity.bob.Person', {});

    expect(aliceCount).toBe(1);
    expect(bobCount).toBe(1);
  });

  it('unsubscribes cleanly', async () => {
    const ps = new PubSubService(makeLogger());
    const seen: unknown[] = [];

    const sub = ps.subscribe('topic', (p) => {
      seen.push(p);
    });

    await ps.publish('topic', 'a');
    sub.unsubscribe();
    await ps.publish('topic', 'b');

    expect(seen).toEqual(['a']);
    expect(ps._subscriberCount()).toBe(0);
  });

  it('iterate() yields buffered payloads and resolves pending awaits', async () => {
    const ps = new PubSubService(makeLogger());
    const abort = new AbortController();

    const iter = ps.iterate<{ n: number }>('counts', abort.signal);

    const collected: number[] = [];
    const consumer = (async () => {
      for await (const v of iter) {
        collected.push(v.n);
        if (collected.length === 3) {
          abort.abort();
        }
      }
    })();

    await ps.publish('counts', { n: 1 });
    await ps.publish('counts', { n: 2 });
    await ps.publish('counts', { n: 3 });

    await consumer;
    expect(collected).toEqual([1, 2, 3]);
    expect(ps._subscriberCount()).toBe(0);
  });

  it('does not let a throwing subscriber kill fan-out', async () => {
    const ps = new PubSubService(makeLogger());
    let secondCalled = false;

    ps.subscribe('topic', () => {
      throw new Error('boom');
    });
    ps.subscribe('topic', () => {
      secondCalled = true;
    });

    expect(await ps.publish('topic', null)).toBe(2);
    expect(secondCalled).toBe(true);
  });
});
