import { DEFAULT_QUEUE } from '../constants';
import { EventListenerRegistry } from '../event-registration';
import { type EventPayloads } from '../event-registry';
import type { EventRegistry } from '../registry';

export abstract class EventService {
  /**
   * @deprecated Use the new distributed EventPayloads type instead.
   */
  abstract send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: { queue?: string },
  ): Promise<string[]>;

  abstract send<E extends keyof EventRegistry>(
    name: E,
    event: EventRegistry[E],
    options?: { queue?: string },
  ): Promise<string[]>;

  abstract send<E extends string>(
    name: E,
    event: EventRegistry[keyof EventRegistry] | EventPayloads[keyof EventPayloads],
    options?: { queue?: string },
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
  ): Promise<void>;

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
}
