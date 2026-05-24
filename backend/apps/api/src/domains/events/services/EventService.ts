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
