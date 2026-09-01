import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LoggerService } from '@ci/common/logging';

import { EventListenerRegistry } from '../../event-registration';
import type { EventSendOptions } from '../../types';
import { PGBossEventService } from '../PGBossEventService';

/**
 * The guard against enqueuing work that pg-boss will silently throw away.
 *
 * A queue declared with `short`/`singleton`/`stately` is de-duplicated by a
 * unique index on `(name, COALESCE(singleton_key, ''))`, so a send carrying NO
 * singletonKey collides with every OTHER keyless job on that queue. pg-boss's
 * insert is `ON CONFLICT DO NOTHING` and `createJob` returns null rather than
 * raising, so the drop reaches the caller as "one fewer job id" — the exact
 * shape that let two keyless senders onto de-duplicating queues ship green.
 *
 * These tests drive the real `PGBossEventService.send`/`sendMany` against the
 * real `EventListenerRegistry` (the same source `onModuleInit` creates queues
 * from); only the pg-boss client is stubbed, and it is stubbed to pg-boss's own
 * return shapes — `string | null` from `send()`, and `null` from `insert()`.
 *
 * The asymmetry is the point. `send()` routes through the SINGLE-job plan,
 * which ends `ON CONFLICT DO NOTHING ... RETURNING id`, so a discarded job is
 * visible as a null id. `sendMany` routes through the BULK plan, which has the
 * same `ON CONFLICT DO NOTHING` and NO `RETURNING`, so `manager.insert` always
 * resolves `null` and a bulk drop leaves no trace at all. Bulk conflict loss is
 * therefore undetectable after the fact, and the throw in `sendMany` — which
 * refuses the only call shape that can cause it — is the entire defence rather
 * than a first line of one.
 */

// The send() overloads are keyed to the real EventRegistry, which is beside the
// point here: the guard is about the target queue, not the payload type.
type LooseSend = (
  name: string,
  event: Record<string, unknown>,
  options?: EventSendOptions,
) => Promise<string[]>;

interface StubLogger {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}

describe('PGBossEventService de-duplication guard', () => {
  const priorSuppress = process.env.CI_QUEUE_SUPPRESS;

  let logger: StubLogger;
  let bossSend: jest.Mock;
  let bossInsert: jest.Mock;

  function makeService(): PGBossEventService {
    logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    const service = new PGBossEventService(
      new EventEmitter2(),
      logger as unknown as LoggerService,
      {} as never,
    );

    bossSend = jest.fn(async (queue: string) => `job-${queue}`);
    // insert() resolves `null` unconditionally — see the file header.
    bossInsert = jest.fn(async () => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).boss = { send: bossSend, insert: bossInsert };

    return service;
  }

  /** Only the guard's own errors, not any other error the service may log. */
  function errorsMentioning(fragment: string): string[] {
    return logger.error.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((message) => message.includes(fragment));
  }

  beforeEach(() => {
    delete process.env.CI_QUEUE_SUPPRESS;
    EventListenerRegistry.clear();
  });

  afterEach(() => {
    EventListenerRegistry.clear();

    if (priorSuppress == null) {
      delete process.env.CI_QUEUE_SUPPRESS;
    } else {
      process.env.CI_QUEUE_SUPPRESS = priorSuppress;
    }
  });

  describe('send()', () => {
    it.each(['short', 'singleton', 'stately'] as const)(
      'logs an error for a keyless send to a queue declared "%s"',
      async (policy) => {
        EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'guarded', { policy });
        const service = makeService();

        const jobIds = await (service.send.bind(service) as LooseSend)('thing.happened', { id: 'x' });

        const errors = errorsMentioning('no singletonKey');

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('thing.happened');
        expect(errors[0]).toContain('guarded');
        expect(errors[0]).toContain(policy);
        // Loud, not fatal: the job is still enqueued, because refusing it here
        // would turn a request path into a 500 over a duplicate.
        expect(jobIds).toEqual(['job-guarded']);
      },
    );

    it('stays silent when the send to a de-duplicating queue carries a singletonKey', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'guarded', {
        policy: 'short',
      });
      const service = makeService();

      await (service.send.bind(service) as LooseSend)('thing.happened', { id: 'x' }, { singletonKey: 'x' });

      expect(logger.error).not.toHaveBeenCalled();
      expect(bossSend.mock.calls[0][2]).toMatchObject({ singletonKey: 'x' });
    });

    it('stays silent for a keyless send to a queue that enforces nothing', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'plain');
      EventListenerRegistry.register('thing.happened', 'OtherListener', 'onThing', 'standard-queue', {
        policy: 'standard',
      });
      const service = makeService();

      await (service.send.bind(service) as LooseSend)('thing.happened', { id: 'x' });

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('guards the explicitly targeted queue too, not just the listener fan-out', async () => {
      EventListenerRegistry.register('other.event', 'ThingListener', 'onThing', 'guarded', {
        policy: 'short',
      });
      const service = makeService();

      await (service.send.bind(service) as LooseSend)('replay.event', { id: 'x' }, { queue: 'guarded' });

      expect(errorsMentioning('no singletonKey')).toHaveLength(1);
    });

    it('reports the null pg-boss returns when a keyless job is discarded on conflict', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'guarded', {
        policy: 'short',
      });
      const service = makeService();
      // What pg-boss actually does on ON CONFLICT DO NOTHING: resolve with null.
      bossSend.mockResolvedValue(null);

      const jobIds = await (service.send.bind(service) as LooseSend)('thing.happened', { id: 'x' });

      expect(jobIds).toEqual([]);
      expect(errorsMentioning('was not enqueued')).toHaveLength(1);
      expect(errorsMentioning('was not enqueued')[0]).toContain('guarded');
    });

    it('treats a null on a keyed send to a de-duplicating queue as the declared behaviour, not an error', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'guarded', {
        policy: 'short',
      });
      const service = makeService();
      bossSend.mockResolvedValue(null);

      const jobIds = await (service.send.bind(service) as LooseSend)(
        'thing.happened',
        { id: 'x' },
        { singletonKey: 'thing:x' },
      );

      expect(jobIds).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
      expect(
        logger.debug.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .filter((m) => m.includes('thing:x')),
      ).toHaveLength(1);
    });

    it('reports a null from a queue that declares no policy, where nothing should ever be discarded', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'plain');
      const service = makeService();
      bossSend.mockResolvedValue(null);

      await (service.send.bind(service) as LooseSend)('thing.happened', { id: 'x' });

      expect(errorsMentioning('was not enqueued')).toHaveLength(1);
    });
  });

  describe('sendMany()', () => {
    it('refuses to bulk-enqueue onto a de-duplicating queue instead of losing all but one job', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'guarded', {
        policy: 'short',
      });
      const service = makeService();

      await expect(
        service.sendMany('guarded', [
          { name: 'thing.happened', data: { id: 'a' } },
          { name: 'thing.happened', data: { id: 'b' } },
        ]),
      ).rejects.toThrow(/policy 'short'/);

      expect(bossInsert).not.toHaveBeenCalled();
    });

    it('refuses even when the caller supplies a batch-wide singletonKey, which is the lossy case itself', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'guarded', {
        policy: 'stately',
      });
      const service = makeService();

      await expect(
        service.sendMany(
          'guarded',
          [
            { name: 'thing.happened', data: { id: 'a' } },
            { name: 'thing.happened', data: { id: 'b' } },
          ],
          { singletonKey: 'batch' },
        ),
      ).rejects.toThrow(/silently discard all but one job/);

      expect(bossInsert).not.toHaveBeenCalled();
    });

    it('bulk-enqueues normally onto a queue that enforces no de-duplication', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'plain');
      const service = makeService();

      await service.sendMany('plain', [
        { name: 'thing.happened', data: { id: 'a' } },
        { name: 'thing.happened', data: { id: 'b' } },
      ]);

      expect(bossInsert).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('reports no loss from the null insert() resolves with, having no way to know of one', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'plain');
      const service = makeService();
      // The real return, and the one a silently-truncated insert also gives.
      // Nothing may be inferred from it — an earlier revision read it as an id
      // array and logged a fabricated "lost N of M jobs" if it ever were one.
      bossInsert.mockResolvedValue(null);

      await service.sendMany('plain', [
        { name: 'thing.happened', data: { id: 'a' } },
        { name: 'thing.happened', data: { id: 'b' } },
        { name: 'thing.happened', data: { id: 'c' } },
      ]);

      expect(errorsMentioning('lost')).toHaveLength(0);
      expect(bossInsert).toHaveBeenCalledTimes(1);
    });

    /**
     * The guard is only airtight because the bulk insert cannot collide with
     * pgboss.job's unique constraints in the first place. Two of those five
     * constraints are held off not by the throw but by what this map omits:
     * the PK is (name, id) and `id` defaults to gen_random_uuid() when absent,
     * and job_i4 is partial on `singleton_on IS NOT NULL`, which only a
     * per-job `singletonSeconds` can set. Threading either field through here
     * — from a widened EventSendOptions, say — silently reopens conflict loss
     * on a path that has no way to report it. Fail loudly instead.
     */
    it('never stamps an id or singletonSeconds onto a bulk job, which is what keeps the PK and job_i4 unreachable', async () => {
      EventListenerRegistry.register('thing.happened', 'ThingListener', 'onThing', 'plain');
      const service = makeService();

      await service.sendMany(
        'plain',
        [
          { name: 'thing.happened', data: { id: 'a' } },
          { name: 'thing.happened', data: { id: 'b' } },
        ],
        // Every option this path accepts, so a future field that gets mapped
        // onto the job is caught rather than sailing past an empty options bag.
        { singletonKey: 'batch', startAfter: 30, priority: 5 },
      );

      const [inserted] = bossInsert.mock.calls[0] as [Array<Record<string, unknown>>];

      expect(inserted).toHaveLength(2);

      for (const job of inserted) {
        expect(job).not.toHaveProperty('id');
        expect(job).not.toHaveProperty('singletonSeconds');
      }
    });
  });
});
