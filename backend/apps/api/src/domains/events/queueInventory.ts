import type { ServedRole } from '@ci/common/roles';

import { DEAD_LETTER_QUEUE } from './constants';
import { EventListenerRegistry } from './event-registration';
import { describeJob, type JobRowCategory } from './taxonomy';

/**
 * Everything the appliance knows about one queue, assembled from the two places
 * that know half of it each.
 *
 * The listener registry knows the mechanics — which events land here, which
 * process consumes them, what ceiling the code declared. The taxonomy knows the
 * meaning — what those events do and which part of the system they belong to.
 * Neither alone can answer the question the Jobs page has to answer before an
 * operator can safely switch a queue off: *what am I turning off?*
 */
export interface QueueInventoryEntry {
  readonly queue: string;

  /** Which process consumes it. Every queue is consumed by exactly one role. */
  readonly role: ServedRole;

  /**
   * The ceiling the queue declared for itself in `queueOptions.localConcurrency`,
   * or null if it declared none.
   *
   * A hard floor on what an operator can ask for. `llm` declares 1 because two
   * chat generations at once thrash the model; a settings UI that let someone
   * type 4 there would be offering a number the code will not honour.
   */
  readonly localConcurrency: number | null;

  /**
   * True when any event routed here is one a person is plausibly waiting on.
   *
   * This is what "pause everything non-interactive" spares. It is a QUEUE-level
   * approximation of a JOB-level property: the worker fetches by queue, so a
   * queue carrying even one interactive event has to keep running. Today that is
   * exactly one queue (`llm`, via `chat.generate`), and the approximation costs
   * nothing — but it is an approximation, and mixing an interactive event onto a
   * busy queue would quietly exempt that whole queue from the pause.
   */
  readonly interactive: boolean;

  /** Event names with a listener on this queue, sorted. */
  readonly events: readonly string[];

  /**
   * Distinct taxonomy categories of those events, most-common first.
   *
   * Usually one. `default` is the exception — sixteen listeners spanning graph
   * writes, new-user seeding and LLM work — and a UI that showed it under a
   * single category would be telling an operator that switching it off costs
   * them one thing when it costs them five.
   *
   * `unclassified` can appear here, and it means what it says: a listener has
   * been registered for an event with no entry in the taxonomy. Showing the
   * fingerprint's guess instead would tell an operator this queue does search
   * work when nothing in the system can confirm that.
   */
  readonly categories: readonly JobRowCategory[];
}

/**
 * Every queue with a registered listener, in name order.
 *
 * Built from the live `@OnEvent` registry rather than a hand-kept list, so a
 * queue added by a new listener appears on the Jobs page without anyone
 * remembering to add it here — and, more importantly, is controllable the day it
 * ships rather than the day someone notices it is not.
 *
 * The dead-letter queue is included: it has a real listener (the reaper) and a
 * real worker, so it is a real queue an operator can see. Whether it may be
 * switched off is a separate question, answered by the protected list.
 */
export function queueInventory(): QueueInventoryEntry[] {
  const events = new Map<string, Set<string>>();

  for (const [key, registration] of EventListenerRegistry.getListeners()) {
    // The registry keys on `${eventName}:${queue}`, and an event name may
    // contain anything but a colon — so slice by the queue's own length rather
    // than splitting, which would mangle any name that ever gains one.
    const eventName = key.slice(0, key.length - registration.queue.length - 1);
    const bucket = events.get(registration.queue) ?? new Set<string>();

    bucket.add(eventName);
    events.set(registration.queue, bucket);
  }

  const entries: QueueInventoryEntry[] = [];

  for (const [queue, eventNames] of events) {
    const options = EventListenerRegistry.getQueueOptions(queue);
    const sorted = [...eventNames].sort();

    entries.push({
      queue,
      role: options?.role ?? 'web',
      localConcurrency: options?.localConcurrency ?? null,
      interactive: sorted.some((event) => Boolean(describeJob(event, null, queue).interactive)),
      events: sorted,
      categories: rankedCategories(sorted, queue),
    });
  }

  return entries.sort((left, right) => left.queue.localeCompare(right.queue));
}

/** True for queues that are structurally part of the queue system's own upkeep. */
export function isDeadLetterQueue(queue: string): boolean {
  return queue === DEAD_LETTER_QUEUE;
}

function rankedCategories(events: readonly string[], queue: string): JobRowCategory[] {
  const counts = new Map<JobRowCategory, number>();

  for (const event of events) {
    const { category } = describeJob(event, null, queue);

    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category]) => category);
}
