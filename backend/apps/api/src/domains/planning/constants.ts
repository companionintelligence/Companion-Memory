import type { QueueOptions } from '@ci/domains/events';

/**
 * The queue the five planning jobs run on, and why it is serial.
 *
 * TodoScan, InboxScan and TodoProcess each call `OllamaService.chat` directly,
 * in-process, from a worker on this queue. They do NOT enqueue onto the `llm`
 * queue — and that queue's whole reason for being (see `domains/llm/constants`)
 * is that the local GPU has one or two slots, so LLM work is serialised there
 * and chat jumps the line with `INTERACTIVE_JOB_PRIORITY`. Priority is a
 * pg-boss ordering and only applies within a queue. Work done here never
 * enters `llm`, so it never yields to a waiting chat turn: without a ceiling of
 * its own, up to the per-queue default (six) planning jobs could each be
 * holding an Ollama request while a person waits on a reply.
 *
 * `localConcurrency: 1` gives this queue the same shape as `llm`: one planning
 * job at a time per process. It does not make planning yield to chat — that
 * would mean routing the three calls through the `llm` queue, which is a larger
 * change — but it bounds the damage to one background request rather than six.
 *
 * `policy: 'short'` is what makes the per-user `singletonKey` PlanningJobsCron
 * sends (`planning:<label>:<userId>`) actually refuse a duplicate; pg-boss's
 * default `standard` policy stores the key and never checks it. It is
 * queue-wide, so every registration on this queue must declare the SAME
 * options or `EventListenerRegistry.register` throws at import time — which is
 * why they live here as one value rather than five literals.
 */
export const PLANNING_QUEUE = 'planning';

export const PLANNING_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  localConcurrency: 1,
};
