import type { EventPayloads } from './event-registry';

export type Acknowledgement = {
  /**
   * The QUEUE's own id for this delivery (`pgboss.job.id`) — and the only
   * channel for runtime job metadata.
   *
   * It used to be merged into the payload as `jobId`, which meant the bus wrote
   * into a namespace it does not own. Any domain that named a field `jobId`
   * silently lost it: `domains/agent` declares one on five payload types
   * meaning the `ci.agent_jobs` row, so `AgentDispatchListener` rang the Hub
   * doorbell with pg-boss's id instead, the harness 404'd fetching its packet,
   * and the stale reaper closed the job reporting that OpenClaw had never
   * checked in — blaming the one part of the chain that was working.
   *
   * Required rather than optional so that every construction site is caught by
   * `Type check backend`, which is a merge gate. A listener that reports
   * completion out-of-band reads the id from HERE and passes it to
   * {@link EventService.completeJob} / {@link EventService.failJob}.
   *
   * Under LocalEventService this is an inline uuid with no pg-boss row behind
   * it, and `completeJob` there is a no-op.
   */
  jobId: string;

  done: () => void;
  fail: (reason: unknown) => void;

  /**
   * Release the worker slot WITHOUT completing or failing the job. The job
   * stays `active` in pg-boss until something calls
   * {@link EventService.completeJob} / {@link EventService.failJob} with its id
   * (e.g. a webhook from an external executor), or until the queue's
   * `expireInSeconds` elapses and pg-boss retries it. Only meaningful with
   * `autoAcknowledge: false`; LocalEventService treats it as `done`.
   */
  defer: () => void;
};

/**
 * pg-boss queue-level options a listener can request for its queue. Applied at
 * queue creation/update on module init by the pg-boss implementation; ignored
 * by LocalEventService.
 */
export type QueueOptions = {
  /**
   * pg-boss queue de-duplication policy. Defaults to `standard`, under which a
   * send's `singletonKey` is STORED AND NEVER ENFORCED — pg-boss 10 makes
   * de-duplication a queue property, and its unique index on
   * (name, singleton_key) is partial: `WHERE state='created' AND policy='short'`.
   * A queue that wants a singletonKey to actually refuse duplicates must say so
   * here; `SyncOrchestrator` documents the same trap from the other side.
   *
   * `short` is queue-WIDE and collapses keyless sends together under
   * COALESCE(singleton_key,''), so only declare it on a queue whose every send
   * carries a key.
   */
  policy?: 'standard' | 'short' | 'singleton' | 'stately';

  /** Seconds an `active` job may run before pg-boss expires (and retries) it. */
  expireInSeconds?: number;

  /**
   * Minutes an UNFINISHED job may sit on this queue before pg-boss throws it
   * away. Overrides the appliance-wide default the pg-boss implementation
   * stamps on every queue; ignored by LocalEventService.
   *
   * This is not the finished-job window. pg-boss's `archive()` deletes from
   * `pgboss.job` on three predicates, and the third is
   * `state < 'active' AND keep_until < now()` — `state < 'active'` covers
   * `created` and `retry`, i.e. work that has never run. `keep_until` resolves
   * as `start_after + COALESCE(job.keep_until, queue.retention_minutes * 60,
   * constructor default, '14 days')`, so a queue row with a NULL
   * `retention_minutes` silently inherits **14 days** and a job paused,
   * disabled or simply backlogged past that is archived and then dropped
   * `deleteAfterHours` later — no log, no dead letter, no trace.
   *
   * MINUTES is the only unit that survives the trip: pg-boss v10 destructures
   * `retentionMinutes` alone in `createQueue`/`updateQueue` and its
   * `create_queue` reads `options->>'retentionMinutes'`, so `retentionDays` is
   * dropped on the floor and reads as a fix that did nothing.
   */
  retentionMinutes?: number;

  /** Retry attempts before the job is routed to the dead-letter queue. */
  retryLimit?: number;

  /** Seconds between retries (with pg-boss's backoff applied on top). */
  retryDelay?: number;

  /**
   * In-process worker slots for THIS queue, overriding the global
   * `queues.perQueueConcurrency` downward. For queues whose jobs are heavy
   * in-process work — parsing a 40GB archive shares the event loop and the
   * database pool with every interactive request — running six abreast
   * starves the API; such a queue declares 1 and serializes. Never raises
   * above the global per-queue ceiling. Ignored by LocalEventService.
   */
  localConcurrency?: number;

  /**
   * Which process consumes this queue. Defaults to `web`, the process every
   * topology has. A queue whose jobs are heavy in-process work declares
   * `worker` and is consumed only by the headless worker process (CI_ROLE) —
   * pg-boss lives in Postgres, so any process can consume; this decides which
   * one does. Both roles still CREATE the queue and can SEND to it. Ignored
   * by LocalEventService (single-process by definition).
   */
  role?: 'web' | 'worker';

  /**
   * Name of a yield gate (see `yieldGates.ts`). While the named gate answers
   * "yield", this queue's worker loop takes no new lease — jobs stay `created`
   * and run the moment the gate opens, the same way `paused` leaves them. The
   * job already running when the gate closes finishes normally. A gate nobody
   * registered, or one that throws, reads as open. Ignored by
   * LocalEventService.
   */
  yieldsTo?: string;

  /**
   * Name of a lane this queue shares with others. Queues on one lane draw
   * from ONE in-process slot pool instead of one each, sized to the smallest
   * `localConcurrency` among them — so four Ollama-bound queues that each
   * declare 1 put at most one generation in front of the runner at a time,
   * while keeping their separate backlogs and policies (which is why they are
   * not simply one queue). The global cap and each queue's yield gate still
   * apply on top. Ignored by LocalEventService.
   */
  lane?: string;
};

export type EventPayload<E extends keyof EventPayloads> = EventPayloads[E];

/**
 * Options accepted by {@link EventService.send} and {@link EventService.sendMany}.
 */
export type EventSendOptions = {
  /**
   * Send to this one queue instead of fanning out to every registered queue.
   * Ignored by `sendMany`, which always names its target queue positionally.
   */
  queue?: string;

  /**
   * Job priority. Higher is worked sooner; defaults to `DEFAULT_JOB_PRIORITY`
   * (0). Only the pg-boss implementation honours it — `LocalEventService` runs
   * listeners inline, so there is no queue to order.
   */
  priority?: number;

  /** pg-boss singleton key — suppresses duplicate pending jobs with the same key. */
  singletonKey?: string;

  /**
   * Delay before the job becomes visible. pg-boss accepts a Date, an ISO
   * string, or an integer number of seconds from now. LocalEventService honours
   * it too, via a plain setTimeout before running listeners inline.
   */
  startAfter?: Date | string | number;
};
