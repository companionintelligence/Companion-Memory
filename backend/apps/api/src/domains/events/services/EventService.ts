import { DEFAULT_QUEUE } from '../constants';
import { EventListenerRegistry } from '../event-registration';
import { type EventPayloads } from '../event-registry';
import type { EventRegistry } from '../registry';
import type { EventSendOptions } from '../types';

export abstract class EventService {
  /**
   * @deprecated Use the new distributed EventPayloads type instead.
   */
  abstract send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  abstract send<E extends keyof EventRegistry>(
    name: E,
    event: EventRegistry[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  abstract send<E extends string>(
    name: E,
    event: EventRegistry[keyof EventRegistry] | EventPayloads[keyof EventPayloads],
    options?: EventSendOptions,
  ): Promise<string[]>;

  /**
   * Bulk-enqueue many events onto ONE named queue in as few round trips as
   * possible. Unlike {@link send} this never fans out to every queue — the caller
   * names the single target. Intended for batch backfills that would otherwise
   * issue N awaited `send()` calls (e.g. the search-index backfill re-emitting
   * ~1M `*CreatedEvent`s); those N per-row inserts blow past request timeouts and
   * hog a connection. Each element's `name` is the event name and `data` is its
   * payload; the enqueued job is byte-identical to what `send(name, data, {queue})`
   * produces, so the same listeners consume it unchanged. Fire-and-forget: the
   * job ids are not returned.
   */
  abstract sendMany(
    queue: string,
    events: Array<{ name: string; data: Record<string, unknown> }>,
    options?: Omit<EventSendOptions, 'queue'>,
  ): Promise<void>;

  /**
   * Complete a job whose listener called `ack.defer()` — used by out-of-band
   * completion paths (e.g. a webhook reporting that an external executor
   * finished). No-op in implementations without a persistent queue.
   */
  abstract completeJob(queue: string, jobId: string, output?: Record<string, unknown>): Promise<void>;

  /**
   * Fail a deferred job so the queue's retry/dead-letter policy applies.
   * The output is persisted with the job for diagnosis.
   */
  abstract failJob(queue: string, jobId: string, output?: Record<string, unknown>): Promise<void>;

  /**
   * Every queue that exists — the union of all listener queues plus the default.
   * This is the set of queues to CREATE and to run workers for, and the set an
   * explicitly requested `options.queue` is validated against.
   *
   * It is deliberately NOT the routing set for an individual event: see
   * {@link getQueuesForEvent}.
   */
  protected getRegisteredQueues(): Set<string> {
    const listeners = EventListenerRegistry.getListeners();
    const queues = new Set<string>();

    // Always include default queue
    queues.add(DEFAULT_QUEUE);

    // Add all queues from registered listeners
    listeners.forEach(([, registration]) => {
      queues.add(registration.queue);
    });

    return queues;
  }

  /**
   * The queues a specific event should actually be delivered to.
   *
   * Shared by both implementations on purpose. Routing used to be decided
   * independently in each (`getRegisteredQueues()` fan-out in pg-boss, the same
   * again inline in local), which let the two drift: the local path executes
   * listeners synchronously and no-ops on a queue with no listener, so a test
   * suite running on LocalEventService saw correct behaviour while production
   * quietly enqueued — and then discarded — a job per queue per event. One
   * implementation of the routing rule means a test that pins the routing pins
   * it for both.
   */
  protected getQueuesForEvent(eventName: string): Set<string> {
    return EventListenerRegistry.getQueuesFor(eventName);
  }
}
