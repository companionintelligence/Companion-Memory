import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LoggerService } from '@ci/common/logging';

import {
  BACKFILL_JOB_PRIORITY,
  DEFAULT_JOB_PRIORITY,
  DEFAULT_QUEUE,
  INTERACTIVE_JOB_PRIORITY,
} from '../../constants';
import { EventListenerRegistry } from '../../event-registration';
import type { EventSendOptions } from '../../types';
import { LocalEventService } from '../LocalEventService';
import { PGBossEventService } from '../PGBossEventService';

/**
 * Routing tests for the event bus: WHICH queues a `send()` reaches.
 *
 * The bug these pin down was measured on a live stack — `send()` with no
 * `{queue}` enqueued one pg-boss job onto EVERY registered queue, and each
 * worker then re-checked `eventEmitter.hasListeners(`${name}:${queue}`)` and
 * no-op'd. Every queue held an identical 90 jobs on a freshly booted appliance,
 * a ~93% waste rate. Nothing failed, so nothing caught it: the assertions here
 * are on the *number and identity of enqueues*, which is the only place the
 * waste was ever visible.
 *
 * Both implementations are exercised against the same registry fixture, because
 * the other half of the bug was that they could disagree — LocalEventService
 * runs listeners inline, so its fan-out cost nothing and the test suite stayed
 * green while production burned the work.
 *
 * Mocking follows PGBossEventService.spec.ts: a stub `boss`, a stub logger, no
 * Postgres. EventListenerRegistry is a static singleton, so every test clears it
 * and registers exactly the listeners it wants to reason about.
 */

// The overloads on send() are keyed to the real EventRegistry/EventPayloads,
// which these tests deliberately sidestep — the routing rule is independent of
// the payload types, and inventing a real event name per case would couple the
// tests to whatever the domains happen to declare today.
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

function makeLogger(): StubLogger {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

describe('event routing', () => {
  const priorSuppress = process.env.CI_QUEUE_SUPPRESS;

  let logger: StubLogger;
  let bossSend: jest.Mock;

  /**
   * Construction reads CI_QUEUE_SUPPRESS into an immutable field, so the
   * suppression cases must set the env var BEFORE building the service.
   */
  function makePgBossService(): PGBossEventService {
    logger = makeLogger();
    const service = new PGBossEventService(new EventEmitter2(), logger as unknown as LoggerService);
    bossSend = jest.fn(async (queue: string) => `job-${queue}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).boss = { send: bossSend };

    return service;
  }

  /** Queues that boss.send() was actually called with, order-independent. */
  function enqueuedQueues(): string[] {
    return bossSend.mock.calls.map((call: unknown[]) => call[0] as string).sort();
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

  describe('EventListenerRegistry.getQueuesFor', () => {
    it('returns only the queues that registered a listener for that event', () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');

      expect(EventListenerRegistry.getQueuesFor('file.uploaded')).toEqual(
        new Set(['file-preview', 'search-index']),
      );
      expect(EventListenerRegistry.getQueuesFor('note.created')).toEqual(new Set(['search-index']));
    });

    it('returns an empty set for an event nobody listens to', () => {
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');

      expect(EventListenerRegistry.getQueuesFor('never.listened')).toEqual(new Set());
    });

    it('hands back a copy so a caller cannot mutate the routing table', () => {
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');

      EventListenerRegistry.getQueuesFor('note.created').add('geocode');

      expect(EventListenerRegistry.getQueuesFor('note.created')).toEqual(new Set(['search-index']));
    });

    it('clear() resets the queue index as well as the listener map', () => {
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');
      expect(EventListenerRegistry.getQueuesFor('note.created').size).toBe(1);

      EventListenerRegistry.clear();

      expect(EventListenerRegistry.getListeners()).toEqual([]);
      expect(EventListenerRegistry.getQueuesFor('note.created')).toEqual(new Set());
      // A stale index would also leave the duplicate guard armed against a
      // listener that no longer exists, so re-registering must be clean.
      expect(() =>
        EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index'),
      ).not.toThrow();
    });
  });

  describe('PGBossEventService.send', () => {
    it('enqueues exactly once for an event with a single listener', async () => {
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');
      const service = makePgBossService();

      const jobIds = await (service.send.bind(service) as LooseSend)('note.created', { noteId: 'n1' });

      expect(bossSend).toHaveBeenCalledTimes(1);
      expect(enqueuedQueues()).toEqual(['search-index']);
      expect(jobIds).toEqual(['job-search-index']);
    });

    it('enqueues once per listening queue and nowhere else', async () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      EventListenerRegistry.register('file.uploaded', 'ParseListener', 'onUploaded', 'document-parsing');
      // Registered queues that do NOT listen to file.uploaded. Before per-event
      // routing these each received an identical job and threw it away.
      EventListenerRegistry.register('position.created', 'GeoListener', 'onCreated', 'geocode');
      EventListenerRegistry.register('feed.tick', 'FeedListener', 'onTick', 'feed-queue');
      const service = makePgBossService();

      const jobIds = await (service.send.bind(service) as LooseSend)('file.uploaded', { fileId: 'f1' });

      expect(bossSend).toHaveBeenCalledTimes(3);
      expect(enqueuedQueues()).toEqual(['document-parsing', 'file-preview', 'search-index']);
      expect(jobIds).toHaveLength(3);
    });

    it('sends the same payload and an explicit default priority to every target queue', async () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      const service = makePgBossService();

      await (service.send.bind(service) as LooseSend)('file.uploaded', { fileId: 'f1' });

      for (const call of bossSend.mock.calls) {
        expect(call[1]).toEqual({ fileId: 'f1', name: 'file.uploaded' });
        expect(call[2]).toEqual({ priority: DEFAULT_JOB_PRIORITY });
      }
    });

    it('enqueues nothing and warns when no queue listens to the event', async () => {
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');
      const service = makePgBossService();

      const jobIds = await (service.send.bind(service) as LooseSend)('orphan.event', { id: 'x' });

      expect(bossSend).not.toHaveBeenCalled();
      expect(jobIds).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('orphan.event');
    });

    it('still targets exactly the one queue named in options.queue', async () => {
      // The explicit-queue path is validated against every EXISTING queue, not
      // against the event's listeners — that is how a backfill re-drives an event
      // onto one worker.
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      const service = makePgBossService();

      const jobIds = await (service.send.bind(service) as LooseSend)(
        'file.uploaded',
        { fileId: 'f1' },
        { queue: 'search-index' },
      );

      expect(bossSend).toHaveBeenCalledTimes(1);
      expect(enqueuedQueues()).toEqual(['search-index']);
      expect(jobIds).toEqual(['job-search-index']);
    });

    it('warns and sends nothing when options.queue names a queue that does not exist', async () => {
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      const service = makePgBossService();

      const jobIds = await (service.send.bind(service) as LooseSend)(
        'file.uploaded',
        { fileId: 'f1' },
        { queue: 'no-such-queue' },
      );

      expect(bossSend).not.toHaveBeenCalled();
      expect(jobIds).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('skips a suppressed queue but still reaches the others', async () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      process.env.CI_QUEUE_SUPPRESS = 'file-preview';
      const service = makePgBossService();

      const jobIds = await (service.send.bind(service) as LooseSend)('file.uploaded', { fileId: 'f1' });

      expect(bossSend).toHaveBeenCalledTimes(1);
      expect(enqueuedQueues()).toEqual(['search-index']);
      expect(jobIds).toEqual(['job-search-index']);
    });

    it('keeps sending to the remaining queues when one queue throws', async () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      const service = makePgBossService();
      bossSend.mockImplementation(async (queue: string) => {
        if (queue === 'file-preview') {
          throw new Error('boom');
        }

        return `job-${queue}`;
      });

      const jobIds = await (service.send.bind(service) as LooseSend)('file.uploaded', { fileId: 'f1' });

      expect(jobIds).toEqual(['job-search-index']);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('LocalEventService.send (parity with pg-boss routing)', () => {
    /**
     * Local execution has no queue to inspect, so "was this queue reached?" is
     * observed through the emitter: a handler is attached for every candidate
     * queue and we assert which ones actually fired.
     */
    function makeLocalService(queueEventNames: string[]): {
      service: LocalEventService;
      fired: string[];
    } {
      logger = makeLogger();
      const emitter = new EventEmitter2();
      const fired: string[] = [];

      for (const queueEventName of queueEventNames) {
        emitter.on(queueEventName, (_payload: unknown, ack: { done: () => void }) => {
          fired.push(queueEventName);
          ack.done();
        });
      }

      return {
        service: new LocalEventService(emitter, logger as unknown as LoggerService),
        fired,
      };
    }

    it('executes only on the queues that registered a listener for the event', async () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');
      EventListenerRegistry.register('position.created', 'GeoListener', 'onCreated', 'geocode');

      const { service, fired } = makeLocalService([
        'file.uploaded:file-preview',
        'file.uploaded:search-index',
        'file.uploaded:geocode',
        `file.uploaded:${DEFAULT_QUEUE}`,
      ]);

      await (service.send.bind(service) as LooseSend)('file.uploaded', { fileId: 'f1' });

      expect(fired.sort()).toEqual(['file.uploaded:file-preview', 'file.uploaded:search-index']);
    });

    it('executes nothing and warns when no queue listens to the event', async () => {
      EventListenerRegistry.register('note.created', 'NoteListener', 'onCreated', 'search-index');

      const { service, fired } = makeLocalService(['orphan.event:search-index']);

      const jobIds = await (service.send.bind(service) as LooseSend)('orphan.event', { id: 'x' });

      expect(fired).toEqual([]);
      expect(jobIds).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('orphan.event');
    });

    it('still targets exactly the one queue named in options.queue', async () => {
      EventListenerRegistry.register('file.uploaded', 'PreviewListener', 'onUploaded', 'file-preview');
      EventListenerRegistry.register('file.uploaded', 'IndexListener', 'onUploaded', 'search-index');

      const { service, fired } = makeLocalService([
        'file.uploaded:file-preview',
        'file.uploaded:search-index',
      ]);

      await (service.send.bind(service) as LooseSend)(
        'file.uploaded',
        { fileId: 'f1' },
        { queue: 'search-index' },
      );

      expect(fired).toEqual(['file.uploaded:search-index']);
    });
  });

  describe('job priority tiers', () => {
    // A sign flip here would silently invert the scheduler: pg-boss fetches
    // ORDER BY priority DESC, so interactive work MUST sort above the default and
    // backfills below it.
    it('orders interactive above default above backfill', () => {
      expect(INTERACTIVE_JOB_PRIORITY).toBeGreaterThan(DEFAULT_JOB_PRIORITY);
      expect(BACKFILL_JOB_PRIORITY).toBeLessThan(DEFAULT_JOB_PRIORITY);
    });
  });
});
