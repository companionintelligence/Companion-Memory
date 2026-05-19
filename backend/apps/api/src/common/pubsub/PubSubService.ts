import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

/**
 * Plan 05 §3.1 — minimal pubsub abstraction. Today an in-memory map; later
 * swapped for a Postgres LISTEN backend when we go multi-process. Callers
 * subscribe to a *topic* and receive every message published on it. Topics
 * are conventionally namespaced and scoped to an actor so events for one
 * actor cannot leak to another.
 *
 * Topic conventions (each domain owns its prefix):
 *  - `entity.<userId>.<entityType?>`
 *  - `relationship.<userId>`
 *  - `thread.<threadId>.message`
 *  - `thread.<threadId>.stream`
 *  - `summary.<userId>`
 *  - `measurement.<userId>.<sensorId>`
 *  - `skill.<invocationId>.trace`
 *
 * Wildcard subscription: a `*` segment matches any single segment. For
 * example, `entity.<userId>.*` receives all entity events for that user.
 */
export type PubSubHandler<T> = (payload: T) => void | Promise<void>;

export interface PubSubSubscription {
  unsubscribe(): void;
}

interface SubscriptionEntry {
  pattern: string[];
  handler: PubSubHandler<unknown>;
}

@Injectable()
export class PubSubService {
  private readonly subscriptions = new Map<string, SubscriptionEntry>();

  private nextId = 1;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(PubSubService.name);
  }

  /**
   * Publish a payload to a topic. Every subscription whose pattern matches
   * the topic receives the payload. Errors in subscriber handlers are caught
   * and logged so one bad subscriber can't kill fan-out.
   */
  async publish<T>(topic: string, payload: T): Promise<number> {
    const parts = topic.split('.');
    let delivered = 0;

    for (const sub of this.subscriptions.values()) {
      if (!matches(sub.pattern, parts)) {
        continue;
      }

      delivered++;
      try {
        await sub.handler(payload);
      } catch (error) {
        this.logger.warn('PubSub subscriber threw', {
          topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return delivered;
  }

  /**
   * Subscribe to a topic pattern. Use `*` to match a single segment;
   * everything else must match literally.
   */
  subscribe<T>(pattern: string, handler: PubSubHandler<T>): PubSubSubscription {
    const id = String(this.nextId++);

    this.subscriptions.set(id, {
      pattern: pattern.split('.'),
      handler: handler as PubSubHandler<unknown>,
    });

    return {
      unsubscribe: () => {
        this.subscriptions.delete(id);
      },
    };
  }

  /**
   * Iterate published payloads as an AsyncIterable. The GraphQL subscription
   * resolver and the MCP resource-subscription path both consume this. The
   * iterator stays open until the caller `return`s out of it (typically when
   * the underlying connection closes).
   */
  async *iterate<T>(pattern: string, signal?: AbortSignal): AsyncIterable<T> {
    const buffer: T[] = [];
    let pendingResolve: ((value: IteratorResult<T>) => void) | null = null;
    let done = false;

    const sub = this.subscribe<T>(pattern, (payload) => {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ value: payload, done: false });
      } else {
        buffer.push(payload);
      }
    });

    const finish = () => {
      done = true;
      sub.unsubscribe();
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    };

    signal?.addEventListener('abort', finish, { once: true });

    try {
      while (!done) {
        if (buffer.length > 0) {
          yield buffer.shift() as T;
          continue;
        }

        const next: IteratorResult<T> = await new Promise((resolve) => {
          pendingResolve = resolve;
        });

        if (next.done) {
          return;
        }

        yield next.value;
      }
    } finally {
      finish();
    }
  }

  /** Test helper. */
  _subscriberCount(): number {
    return this.subscriptions.size;
  }
}

/**
 * Match a parsed pattern (with `*` wildcards) against a parsed topic. Both
 * are arrays of segments; `*` matches any one segment; the topic may be
 * longer than the pattern only if the pattern's last segment is `*` (which
 * matches the remainder).
 */
function matches(pattern: string[], topic: string[]): boolean {
  if (pattern.length === topic.length) {
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] !== '*' && pattern[i] !== topic[i]) {
        return false;
      }
    }

    return true;
  }

  return false;
}
