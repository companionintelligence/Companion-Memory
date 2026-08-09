import { DEFAULT_QUEUE } from './constants';
import type { QueueOptions } from './types';

export class EventListenerRegistry {
  private static listeners = new Map<string, { className: string; methodName: string; queue: string }>();

  // Queue-level options requested via @OnEvent({ queueOptions }). Keyed by
  // queue name; conflicting explicit values from different listeners throw at
  // registration (decorator evaluation) so a misconfiguration fails fast.
  private static queueOptions = new Map<string, QueueOptions>();

  // Secondary index: event name -> the queues that actually have a listener for
  // it. The primary map is keyed `${eventName}:${queue}`, so answering "which
  // queues care about this event?" from it alone means scanning every entry and
  // splitting strings — on the send() hot path, per event, per row of an import.
  // This index is maintained in register() so the lookup is O(1). It is derived
  // state: it MUST stay in lockstep with `listeners` (see clear()).
  private static queuesByEvent = new Map<string, Set<string>>();

  static register(
    eventName: string,
    className: string,
    methodName: string,
    queue: string = DEFAULT_QUEUE,
    queueOptions?: QueueOptions,
  ) {
    const key = `${eventName}:${queue}`;
    const existing = this.listeners.get(key);

    if (existing) {
      throw new Error(
        `Multiple listeners detected for event ${eventName} in queue ${queue}. ` +
          `Existing: ${existing.className}.${existing.methodName}, ` +
          `New: ${className}.${methodName}. ` +
          `Only one listener per event per queue is allowed.`,
      );
    }

    this.listeners.set(key, {
      className,
      methodName,
      queue,
    });

    if (queueOptions) {
      const current = this.queueOptions.get(queue) ?? {};

      for (const [option, value] of Object.entries(queueOptions) as [keyof QueueOptions, number][]) {
        const existingValue = current[option];

        if (existingValue !== undefined && existingValue !== value) {
          throw new Error(
            `Conflicting queueOptions.${option} for queue ${queue}: ` +
              `${existingValue} already registered, ${className}.${methodName} requests ${value}.`,
          );
        }

        current[option] = value;
      }

      this.queueOptions.set(queue, current);
    }

    let queues = this.queuesByEvent.get(eventName);

    if (!queues) {
      queues = new Set<string>();
      this.queuesByEvent.set(eventName, queues);
    }

    queues.add(queue);
  }

  static getListeners() {
    return Array.from(this.listeners.entries());
  }

  static getQueueOptions(queue: string): QueueOptions | undefined {
    return this.queueOptions.get(queue);
  }

  /**
   * The queues that have a registered listener for `eventName` — i.e. the only
   * queues where enqueuing this event can ever result in work.
   *
   * This is the routing decision for {@link EventService.send}. Before this
   * index existed, send() fanned every event out to EVERY registered queue and
   * each worker re-checked `eventEmitter.hasListeners(`${name}:${queue}`)` and
   * no-op'd — measured on a freshly booted stack as an identical 90 jobs sitting
   * on every queue, ~93% of them destined to be fetched, deserialised, matched
   * against nothing and completed. Routing at enqueue time deletes that work
   * instead of doing it.
   *
   * Returns a fresh Set: callers must not be able to mutate the registry's
   * routing table by accident (send() iterating it is read-only, but that is not
   * something the type system enforces). An empty Set means "nobody listens" —
   * callers should treat that as a misconfiguration worth logging, not an error.
   */
  static getQueuesFor(eventName: string): Set<string> {
    return new Set(this.queuesByEvent.get(eventName) ?? []);
  }

  static clear() {
    this.listeners.clear();
    this.queueOptions.clear();
    // `queuesByEvent` is derived from `listeners`; leaving it populated here
    // would make a cleared registry still route events to queues whose listeners
    // no longer exist — the exact drift this index risks introducing.
    this.queuesByEvent.clear();
  }
}

export class EventDefinitionRegistry {
  private static names = new Set<string>();

  /**
   * Event registration helper method used to enforce event payload constraints
   * at compile time and name uniqueness at runtime.
   */
  static defineEvent<T extends Record<string, unknown> & { name?: never }>(name: string) {
    if (this.names.has(name)) {
      throw new Error(`Event name "${name}" is already registered.`);
    }

    this.names.add(name);

    return {} as T;
  }

  /**
   * Every event name declared via {@link defineEvent}, in declaration order.
   *
   * Used at boot to cross-check the declared event surface against the listener
   * registry: a name here with no entry in {@link EventListenerRegistry} is an
   * orphan — something emits it (or will) and nothing consumes it.
   */
  static getNames(): string[] {
    return Array.from(this.names);
  }
}

export function defineEvent<T extends Record<string, unknown> & { name?: never }>(name: string) {
  return EventDefinitionRegistry.defineEvent<T>(name);
}
