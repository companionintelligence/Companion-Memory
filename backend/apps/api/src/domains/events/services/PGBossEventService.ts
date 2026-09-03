import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit from 'p-limit';
import PgBoss, { JobWithMetadata } from 'pg-boss';
import { DataSource } from 'typeorm';

import { ContextService } from '@ci/common/context';
import { JobControlStore, type JobMode } from '@ci/common/job-controls';
import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import config from '@ci/configuration';

import { DEAD_LETTER_QUEUE, DEFAULT_JOB_PRIORITY } from '../constants';
import { EventDefinitionRegistry, EventListenerRegistry } from '../event-registration';
import { type EventPayloads } from '../event-registry';
import {
  effectiveQueueConcurrency as computeQueueConcurrency,
  perProcessGlobalConcurrency,
  perQueueDefaultConcurrency,
  queueWorkerProcesses,
} from '../jobConcurrency';
import { queueInventory } from '../queueInventory';
import { EventRegistry } from '../registry';
import type { EventSendOptions, QueueOptions } from '../types';

import { EventService } from './EventService';

interface EventData {
  name: string;

  /**
   * Set by senders that act on behalf of a user. Read back out in
   * {@link PGBossEventService.executeJob} to restore the request context the
   * job was enqueued under, so a listener's `ContextService.getUserId()` matches
   * the user whose action created the work.
   */
  userId?: string;
}

// Rows per pg-boss insert() call in sendMany(). Bounds the single INSERT's
// parameter/row count so a multi-million-row backfill streams in fixed chunks
// instead of one enormous statement.
const PGBOSS_INSERT_CHUNK = 2000;

// The queue policies whose unique index actually refuses a duplicate:
// `short` on (name, COALESCE(singleton_key,'')) WHERE state='created',
// `singleton` the same WHERE state='active', `stately` on
// (name, state, COALESCE(singleton_key,'')) WHERE state <= 'active'
// (pg-boss plans.js, job_i1..job_i3). Every one of them COALESCEs a MISSING
// key to '', so keyless sends to such a queue de-duplicate against EACH OTHER
// — and the insert is ON CONFLICT DO NOTHING, so the loser is discarded with
// no error and `send()` merely resolves null. `standard` stores a singletonKey
// and enforces nothing.
const ENFORCING_QUEUE_POLICIES: ReadonlySet<NonNullable<QueueOptions['policy']>> = new Set([
  'short',
  'singleton',
  'stately',
]);

// Serializes queue PROVISIONING across processes. The web and worker halves
// both create/update every queue at boot, and pg-boss's create_queue
// deadlocks when two sessions race the same queue name (the insert into
// pgboss.queue and the partition DDL take their locks in opposite orders).
// Arbitrary value; must only be unique among this codebase's advisory locks
// (the test-side schemaLock uses 728104512).
const QUEUE_PROVISION_LOCK_KEY = 804_551_297;

// How long a dead-lettered job stays inspectable. 30 days, in minutes, because
// minutes is the only retention unit pg-boss v10 persists on a queue row (see
// the createQueue call in onModuleInit).
const DEAD_LETTER_RETENTION_MINUTES = 30 * 24 * 60;

/**
 * The retry policy, stated once and applied in both places it has to hold.
 *
 * pg-boss resolves a job's retry settings as COALESCE(job, queue, constructor
 * default). Passing these to the constructor alone leaves every queue row with
 * NULL retry columns, so the policy is invisible to anything reading
 * `pgboss.queue` — including the dashboard, which rendered "null" for retry
 * limit and delay on 20 of 22 queues. Writing them onto the queue too makes the
 * effective policy the one the database actually reports.
 */
const QUEUE_RETRY_POLICY = {
  retryLimit: 3,
  retryDelay: 10,
  retryBackoff: true,
} as const;

/**
 * Processes running queue workers on this appliance, resolved once.
 *
 * `processRole()` is fixed for the lifetime of a process, so this is too. See
 * `jobConcurrency.queueWorkerProcesses` for why the operator's appliance-wide
 * cap has to be divided by it before it reaches a semaphore.
 */
const QUEUE_WORKER_PROCESSES = queueWorkerProcesses();

@Injectable()
export class PGBossEventService extends EventService implements OnModuleInit, OnModuleDestroy {
  // Global in-flight job ceiling across ALL queues (bounds total DB/Ollama load).
  // Configurable (CI_QUEUE_CONCURRENCY) so the decoupled embedding/index workers
  // can be scaled for bulk imports, and overridable at runtime from the Jobs page
  // (`ci.job_settings`, kind `global`) so an operator can cool a hot box without
  // editing a compose file and restarting the appliance.
  private globalSemaphore = plimit(config.queues.concurrency);

  // Per-queue in-flight ceiling — one plimit per queue, created in onModuleInit.
  // Sized BELOW the global ceiling (CI_QUEUE_PER_QUEUE_CONCURRENCY) so a burst of
  // slow jobs on one queue can't take every global slot and starve another queue
  // (the search-index backlog stall behind image-description/embedding jobs).
  private readonly perQueueSemaphores = new Map<string, ReturnType<typeof plimit>>();

  // The shipped ceilings, held as instance fields rather than read from
  // `config` at each use. Not indirection for its own sake: the worker specs
  // need a 2-slot appliance without mutating process-wide config for every
  // other suite in the run, and the semaphores are now recomputed from these on
  // every settings change — so a test that only resized the semaphore would
  // have it silently reset on the loop's next iteration.
  private readonly shippedConcurrency = config.queues.concurrency;

  private readonly shippedPerQueueConcurrency = config.queues.perQueueConcurrency;

  private readonly fetchBatchSize = config.queues.fetchBatchSize;

  // The `localConcurrency` each queue declared for itself, if any. A hard floor
  // on what a settings row can ask for: the code that wrote `localConcurrency: 1`
  // knows something about the workload that the person typing a number does not.
  private readonly declaredQueueCeilings = new Map<string, number>();

  // Queues carrying at least one event a person is plausibly waiting on. Spared
  // by the "pause everything non-interactive" switch — see `queueInventory`.
  private readonly interactiveQueues = new Set<string>();

  // The settings revision the semaphores were last sized for. The store bumps it
  // only when a setting actually changes, so the work loop's per-iteration check
  // is an integer compare rather than a re-read of every queue's ceiling.
  private controlsRevision = -1;

  // Last mode each queue was observed in, so the worker logs a transition once
  // instead of logging "still paused" every time it wakes up.
  private readonly loggedQueueModes = new Map<string, JobMode>();

  // Queues whose drops have already been announced, and the settings revision
  // that announcement belongs to. Keeps a million-row import fan-out onto a
  // disabled queue to one log line rather than a million identical ones.
  private readonly loggedQueueDrops = new Set<string>();

  private loggedDropsRevision = -1;

  // Shared dead-letter queue. Jobs that exhaust their retries are moved here
  // (payload + failure output preserved) instead of vanishing when pgboss deletes
  // failed jobs after deleteAfterHours — so a failure stays inspectable. Nothing
  // works this queue, so entries accumulate; it carries a long retention.
  //
  // The name lives in `../constants` rather than here because JobMonitorService
  // has to exclude this queue from every "pending work" aggregate, and two
  // copies of the string is exactly how that exclusion silently stops matching.
  private static readonly DEAD_LETTER_QUEUE = DEAD_LETTER_QUEUE;

  // Bulk-import escape hatch: even with per-event routing, one imported row can
  // legitimately fan out to several enrichment queues. During a bulk load, set
  // CI_QUEUE_SUPPRESS to a comma-separated list of queues to skip enqueuing
  // entirely (e.g. file-preview-generation,image-description,geocode,feed-queue,
  // etl) — keep search-index for searchable results. Enrichment can be backfilled
  // later.
  private readonly suppressedQueues = new Set(
    (process.env.CI_QUEUE_SUPPRESS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  private running = false;

  private stopTasks: Promise<void>[] = [];

  private readonly backoffWhenFull = 150;

  private readonly backoffWhenEmpty = 5000;

  private boss = new PgBoss({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.username,
    password: config.db.password,
    schema: 'pgboss',
    ...QUEUE_RETRY_POLICY,
    expireInHours: 12,
    deleteAfterHours: 24,
    max: 10,
    // pg-boss's cron scheduler, off. Nothing in this codebase calls
    // `boss.schedule()` — every recurring job is a NestJS `@Cron` — so leaving
    // it enabled bought a phantom `__pgboss__send-it` queue, a 5-second clock
    // poll and a 30-second cron pass in EVERY process, forever, to service zero
    // schedules.
    schedule: false,
  });

  constructor(
    protected readonly eventEmitter: EventEmitter2,
    protected readonly logger: LoggerService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
    this.logger.setContext(PGBossEventService.name);
  }

  async onModuleInit() {
    const listeners = EventListenerRegistry.getListeners();

    this.logger.debug(`Validated ${listeners.length} event listeners`);

    listeners.forEach(([key, registration]) => {
      this.logger.debug(
        `Event listener registered: ${key} -> ${registration.className}.${registration.methodName}`,
      );
    });

    // Attached BEFORE start(). PgBoss is an EventEmitter, and an EventEmitter
    // that emits 'error' with no listener throws — so a failure during startup
    // (the exact window where one is most likely) used to escape as an
    // unhandled exception instead of the logged error it becomes here.
    this.boss.on('error', (err) => {
      this.logger.error('PgBoss error', err);
    });

    try {
      this.logger.debug('Initializing PgBoss client...');

      await this.boss.start();

      this.logger.debug('Initialized PgBoss client');
    } catch (err: unknown) {
      this.logger.error(
        'Failed to initialize PgBoss client',
        err instanceof Error ? err : new Error(String(err)),
      );

      throw err;
    }

    // Discover all queues from registered listeners
    const discoveredQueues = this.getRegisteredQueues();

    this.logger.debug(`Discovered queues: ${Array.from(discoveredQueues).join(', ')}`);

    this.warnOnOrphanEvents();

    // Which queues the "pause everything non-interactive" switch must spare.
    // Resolved once here rather than per send: it is a fold over the whole
    // listener registry against the taxonomy, and neither changes after boot.
    for (const entry of queueInventory()) {
      if (entry.interactive) {
        this.interactiveQueues.add(entry.queue);
      }
    }

    // Provisioning is serialized appliance-wide: with the web and worker
    // processes booting together, unserialized create_queue calls deadlock
    // intermittently (seen live: 40P01 between the pgboss.queue insert and
    // partition DDL). Session-level advisory lock on a dedicated app-pool
    // connection, while the creates themselves run through pg-boss's pool —
    // an advisory lock cares about sessions, not which pool does the DDL.
    const provisionLock = this.dataSource.createQueryRunner();

    await provisionLock.connect();
    await provisionLock.query('SELECT pg_advisory_lock($1)', [QUEUE_PROVISION_LOCK_KEY]);

    try {
      // Create the shared dead-letter queue FIRST so the work queues can reference
      // it. Long retention so exhausted-retry jobs stay inspectable; no worker
      // consumes it (it is not a registered listener queue), so entries accumulate.
      //
      // retentionMinutes, NOT retentionDays: pg-boss v10 only ever writes the
      // MINUTES form to the queue row. `applyRetentionConfig` (attorney.js)
      // folds retentionDays into a `keepUntil` interval string, `createQueue`
      // (manager.js) then destructures `retentionMinutes` alone, and the
      // `create_queue` PL/pgSQL reads `options->>'retentionMinutes'` — so
      // `retentionDays: 30` was dropped on the floor and the live queue row
      // carried `retention_minutes = NULL`. Same 30 days, expressed in the one
      // unit that survives the trip.
      await this.boss.createQueue(PGBossEventService.DEAD_LETTER_QUEUE, {
        name: PGBossEventService.DEAD_LETTER_QUEUE,
        retentionMinutes: DEAD_LETTER_RETENTION_MINUTES,
      });

      // createQueue is a no-op when the queue already exists, so a DLQ created
      // before this fix keeps its NULL retention forever without this line.
      await this.boss.updateQueue(PGBossEventService.DEAD_LETTER_QUEUE, {
        name: PGBossEventService.DEAD_LETTER_QUEUE,
        retentionMinutes: DEAD_LETTER_RETENTION_MINUTES,
      });

      // Create all discovered queues, routing exhausted-retry jobs to the DLQ and
      // giving each its own concurrency semaphore. createQueue is idempotent and
      // won't update an existing queue's options, so updateQueue (a COALESCE merge)
      // applies deadLetter to queues that already exist on a live DB too.
      for (const queue of discoveredQueues) {
        // Listener-requested queue-level options (expiration/retries) — used by
        // deferred-completion queues whose jobs stay active while an external
        // executor works, so their expiration must match the work's runtime.
        // `localConcurrency` and `role` are OURS (the semaphore size below, and
        // which process consumes — used by the worker-start loop), not
        // pg-boss's — split them off so the queue-create call sees only real
        // pg-boss options.
        const { localConcurrency, role, ...queueOptions } =
          EventListenerRegistry.getQueueOptions(queue) ?? {};

        // Retry policy first so a listener's own `queueOptions` still override
        // it. Stating it explicitly is what puts it in the queue ROW: pg-boss
        // resolves COALESCE(job, queue, constructor), so constructor-only
        // settings left 20 of 22 queue rows with NULL retry columns and the
        // dashboard rendering "null" where the policy should be.
        const options = {
          name: queue,
          deadLetter: PGBossEventService.DEAD_LETTER_QUEUE,
          ...QUEUE_RETRY_POLICY,
          ...queueOptions,
        };

        await this.boss.createQueue(queue, options);
        await this.boss.updateQueue(queue, options);

        if (localConcurrency != null) {
          this.declaredQueueCeilings.set(queue, localConcurrency);
        }

        this.perQueueSemaphores.set(queue, plimit(this.effectiveQueueConcurrency(queue)));
        this.logger.debug(
          `Created queue: ${queue} (role=${role ?? 'web'}, deadLetter=${PGBossEventService.DEAD_LETTER_QUEUE})`,
        );
      }
    } finally {
      try {
        await provisionLock.query('SELECT pg_advisory_unlock($1)', [QUEUE_PROVISION_LOCK_KEY]);
      } finally {
        await provisionLock.release();
      }
    }

    // Size every semaphore from the persisted settings before any worker starts.
    // Without this the first seconds after a boot run at the shipped ceiling
    // regardless of what the operator set — which is exactly the window after a
    // restart, i.e. the window an operator who just capped a hot box is watching.
    this.syncConcurrencyLimits();

    try {
      this.logger.debug('Initializing work queues...');

      // Start workers for the discovered queues THIS PROCESS serves. Every
      // process creates every queue and may send to every queue; consumption
      // is what the role decides — a queue marked `worker` runs its jobs in
      // the headless worker process, where a parser's synchronous stretches
      // cannot stutter the web process's event loop.
      let started = 0;

      for (const queue of discoveredQueues) {
        const queueRole = EventListenerRegistry.getQueueOptions(queue)?.role ?? 'web';

        if (!serves(queueRole)) {
          this.logger.debug(`Queue ${queue} belongs to role ${queueRole}; not consuming here`);
          continue;
        }

        // Terminal .catch, not decoration. This promise is parked in stopTasks
        // and nothing awaits it until flush() at shutdown, so anything that
        // escapes `work()` is an unhandled rejection for the entire uptime of
        // the process — and application.ts turns those into process.exit(1).
        // The loop guards its own known failure modes; this is the backstop for
        // the ones it does not know about, and it resolves rather than rethrows
        // so flush() still completes.
        this.stopTasks.push(
          this.work(queue).catch((err: unknown) => {
            this.logger.error(
              `Worker loop for queue ${queue} stopped unexpectedly; this queue will not be consumed until restart`,
              err instanceof Error ? err : new Error(String(err)),
            );
          }),
        );
        started += 1;
      }

      this.logger.debug(`Initialized ${started} of ${discoveredQueues.size} work queues for this role`);
    } catch (err: unknown) {
      this.logger.error(
        'Failed to initialize work queue client',
        err instanceof Error ? err : new Error(String(err)),
      );

      throw err;
    }
  }

  async onModuleDestroy() {
    try {
      this.logger.debug('Flushing work queues...');

      await this.flush();

      this.logger.debug('Flushed work queues');
    } catch (err: unknown) {
      this.logger.error('Failed to flush work queues', err instanceof Error ? err : new Error(String(err)));
    }

    try {
      this.logger.debug('Stopping PgBoss client...');

      await this.boss.stop();

      this.logger.debug('Stopped PgBoss client');
    } catch (err: unknown) {
      this.logger.error('Failed to stop PgBoss client', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Cross-check the declared event surface against the listener registry, once,
   * at boot.
   *
   * Every `defineEvent` name that resolves to zero queues is an orphan: emitting
   * it enqueues nothing. Under the old fan-out this was invisible — the event got
   * a job on every queue and every worker silently dropped it, so a missing
   * listener looked exactly like a working one. Now that routing is by listener,
   * an orphan is a silent no-op, which is worse to debug in the field than a loud
   * line at startup. Warn rather than throw: dormant events (a domain module not
   * enabled in this deployment) are legitimate, and refusing to boot over one
   * would be a self-inflicted outage.
   */
  private warnOnOrphanEvents(): void {
    const orphans = EventDefinitionRegistry.getNames().filter(
      (eventName) => EventListenerRegistry.getQueuesFor(eventName).size === 0,
    );

    if (orphans.length === 0) {
      return;
    }

    this.logger.warn(
      `${orphans.length} defined event(s) have no listener on any queue and will enqueue nothing when sent: ` +
        orphans.join(', '),
    );
  }

  /**
   * @deprecated Use the new distributed EventPayloads type instead.
   */
  async send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  async send<E extends keyof EventRegistry>(
    name: E,
    event: EventRegistry[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  async send<E extends string>(
    name: E,
    event: EventRegistry[keyof EventRegistry] | EventPayloads[keyof EventPayloads],
    options?: EventSendOptions,
  ): Promise<string[]> {
    const resolvedData = {
      ...event,
      name,
    } satisfies EventData;

    // pg-boss fetches ORDER BY priority DESC, so a higher number is worked
    // sooner. Every job carries an explicit priority rather than leaning on the
    // column default, so the ordering is legible from the enqueue side.
    const sendOptions: PgBoss.SendOptions = {
      priority: options?.priority ?? DEFAULT_JOB_PRIORITY,
      ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options?.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    };

    // If a specific queue is provided and that queue exists, send only to that queue.
    // Validated against every EXISTING queue rather than this event's listener
    // set: naming a queue explicitly is how a backfill re-drives an event onto
    // one worker, and that is legitimate even for a queue that would not be part
    // of the event's normal fan-out.
    if (options?.queue) {
      if (!this.getRegisteredQueues().has(options.queue)) {
        this.logger.warn(`Requested queue ${options.queue} does not exist. Event ${name} will not be sent.`);

        return [];
      }

      // Suppression applies here too. This branch used to return before the
      // check below ever ran, so CI_QUEUE_SUPPRESS silenced the listener-routed
      // fan-out while every `send(..., { queue })` call sailed straight past it
      // — which is exactly backwards, since naming a queue explicitly is what a
      // backfill does, and a backfill is what the suppression exists to stop.
      if (this.suppressedQueues.has(options.queue)) {
        this.logger.debug(`Queue ${options.queue} is suppressed; dropping event ${name}`);

        return [];
      }

      // The operator's setting, checked in the same place and for the same
      // reason as the env-var suppression above: naming a queue explicitly is
      // what a backfill does, and a backfill is precisely the traffic someone
      // reaches for this switch to stop.
      if (this.isQueueDisabled(options.queue)) {
        this.recordQueueDrop(options.queue, 1);

        return [];
      }

      const jobId = await this.sendToQueue(name, options.queue, resolvedData, sendOptions);

      return jobId ? [jobId] : [];
    }

    // Otherwise, send only to the queues that actually have a listener for THIS
    // event (minus any suppressed for a bulk load). This used to be every
    // registered queue, with each worker fetching the job and discarding it after
    // finding no listener — one real job plus N-1 pure-waste jobs per send.
    const targetQueues = this.getQueuesForEvent(name);

    if (targetQueues.size === 0) {
      // Not fatal: an event with no consumer is a no-op, and throwing here would
      // turn a dormant integration into a request failure. But it is always a
      // mistake worth surfacing — either the listener module never loaded, or the
      // emitter outlived its consumer.
      this.logger.warn(`Event ${name} has no registered listeners on any queue; nothing was enqueued.`);

      return [];
    }

    const jobIds: string[] = [];

    for (const queue of targetQueues) {
      if (this.suppressedQueues.has(queue)) {
        continue;
      }

      // A disabled queue drops its share of the fan-out and the event still goes
      // to every other queue that listens for it — turning off `image-description`
      // must not also stop the same upload being indexed for search.
      if (this.isQueueDisabled(queue)) {
        this.recordQueueDrop(queue, 1);

        continue;
      }

      try {
        const jobId = await this.sendToQueue(name, queue, resolvedData, sendOptions);

        if (jobId) {
          jobIds.push(jobId);
        }
      } catch (err: unknown) {
        this.logger.error(
          `Failed to send event ${name} to queue ${queue}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.debug(`Sent event ${name} to ${jobIds.length} queues`);

    return jobIds;
  }

  /**
   * The de-duplicating policy `queue` was DECLARED with, or undefined if it
   * enforces none. Read from the same registry the queue was created from
   * ({@link EventListenerRegistry.getQueueOptions}, populated by `@OnEvent`),
   * so the send side and the `createQueue` side can never disagree about what
   * a queue does.
   */
  private enforcingPolicyFor(queue: string): NonNullable<QueueOptions['policy']> | undefined {
    const policy = EventListenerRegistry.getQueueOptions(queue)?.policy;

    return policy !== undefined && ENFORCING_QUEUE_POLICIES.has(policy) ? policy : undefined;
  }

  /**
   * Enqueue one job, and refuse to let pg-boss's two silent outcomes stay silent.
   *
   * A keyless send to a de-duplicating queue is a programming error that loses
   * work: every such job COALESCEs to the same '' key, so all but the first are
   * discarded. It is logged rather than thrown because `send()` sits on request
   * and cron paths where turning a partial fan-out into a 500 would be a bigger
   * outage than the drop — but it is never correct, and the message says so.
   */
  private async sendToQueue(
    name: string,
    queue: string,
    data: EventData,
    sendOptions: PgBoss.SendOptions,
  ): Promise<string | null> {
    const policy = this.enforcingPolicyFor(queue);

    if (policy && !sendOptions.singletonKey) {
      this.logger.error(
        `Event ${name} was sent to queue ${queue} with no singletonKey, but that queue declares ` +
          `policy '${policy}'. pg-boss de-duplicates keyless jobs against each other, so this job is ` +
          `discarded whenever another keyless job is already waiting on ${queue}. Give the send a ` +
          `singletonKey, or drop the policy from the queue's queueOptions.`,
      );
    }

    const jobId = await this.boss.send(queue, data, sendOptions);

    if (jobId == null) {
      // pg-boss reports a de-duplicated insert by RESOLVING WITH NULL, not by
      // throwing (manager.createJob returns null when the ON CONFLICT DO NOTHING
      // insert returns no row). Folding that into "one fewer job id" made a
      // dropped job indistinguishable from an enqueued one at every call site.
      const detail =
        `Event ${name} was not enqueued on queue ${queue}: pg-boss de-duplicated it against a job ` +
        `already waiting (policy=${policy ?? 'standard'}, singletonKey=${sendOptions.singletonKey ?? 'none'})`;

      if (policy && sendOptions.singletonKey) {
        this.logger.debug(`${detail}. This is the queue's declared de-duplication working as intended.`);
      } else {
        this.logger.error(detail);
      }
    }

    return jobId;
  }

  async sendMany(
    queue: string,
    events: Array<{ name: string; data: Record<string, unknown> }>,
    options?: Omit<EventSendOptions, 'queue'>,
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    if (!this.getRegisteredQueues().has(queue)) {
      this.logger.warn(`Requested queue ${queue} does not exist. ${events.length} events will not be sent.`);

      return;
    }

    if (this.suppressedQueues.has(queue)) {
      // Unlike send()'s per-row fan-out (where skipping suppressed queues is the
      // whole point and logging would spam), sendMany is a deliberate bulk
      // enqueue of ONE named queue — dropping it silently makes a backfill
      // report success while enqueuing nothing. Warn loudly instead.
      this.logger.warn(
        `Queue ${queue} is suppressed via CI_QUEUE_SUPPRESS — dropping ${events.length} bulk-enqueued events. ` +
          `If this is a post-import backfill, unset the suppression and re-run.`,
      );

      return;
    }

    // Same reasoning as the suppression check above: a bulk enqueue of one named
    // queue that silently enqueues nothing is a backfill that reports success
    // having done nothing. Counted as `events.length` drops, not one, so the
    // Jobs page's tally is the number of jobs lost rather than the number of
    // calls that lost them.
    if (this.isQueueDisabled(queue)) {
      // Warned unconditionally with its own count, unlike the per-row path
      // above: this is ONE call that drops a whole backfill, and the number of
      // jobs it threw away is the thing the operator has to see. Same reasoning
      // as the CI_QUEUE_SUPPRESS branch it sits beside.
      JobControlStore.recordSkip('queue', queue, events.length);
      this.logger.warn(
        `Queue ${queue} is disabled by an operator setting — dropping ${events.length} bulk-enqueued events. ` +
          `Re-enable it from the Jobs page and re-run this backfill if the work still matters.`,
      );

      return;
    }

    const enforcingPolicy = this.enforcingPolicyFor(queue);

    if (enforcingPolicy) {
      // This API has one singletonKey for the WHOLE batch (and a batch with no
      // key COALESCEs to '' just the same), so on a de-duplicating queue the
      // unique index keeps exactly one row and ON CONFLICT DO NOTHING discards
      // the other N-1 without an error — a bulk enqueue that reports success
      // having enqueued 1 of a million. A per-job key is not expressible here,
      // so the call itself is wrong: refuse it at the caller instead of losing
      // the batch in the database. No caller reaches this today (every sendMany
      // target queue is policy-less); it exists so none can start to.
      throw new Error(
        `sendMany cannot enqueue ${events.length} events onto queue ${queue}: that queue declares ` +
          `policy '${enforcingPolicy}', which de-duplicates on a single per-batch singletonKey and would ` +
          `silently discard all but one job. Send these events individually with a per-job singletonKey, ` +
          `or drop the policy from the queue's queueOptions.`,
      );
    }

    // pg-boss insert() bulk-creates jobs in ONE INSERT per chunk, routing through
    // pg-boss's own job schema (so partitioning/defaults are handled for us). This
    // replaces N awaited boss.send() round trips — the difference between the
    // search-index backfill returning in seconds vs. blocking the request for
    // minutes while it enqueues ~1M rows. job.name is the queue; job.data mirrors
    // send()'s resolvedData ({ ...event, name }) so executeJob + listeners consume
    // it identically.
    const priority = options?.priority ?? DEFAULT_JOB_PRIORITY;

    const jobs: PgBoss.JobInsert[] = events.map((event) => ({
      name: queue,
      data: { ...event.data, name: event.name },
      priority,
      ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
      // JobInsert's own type omits `number` even though insert()'s SQL parses a
      // bulk-inserted startAfter the same way send()'s does (json_to_recordset
      // extracts it as text, then `now() + interval` — see plans.js) — send()'s
      // SendOptions (via JobOptions) declares the correct three-way union.
      ...(options?.startAfter !== undefined
        ? { startAfter: options.startAfter as PgBoss.JobInsert['startAfter'] }
        : {}),
    }));

    for (let i = 0; i < jobs.length; i += PGBOSS_INSERT_CHUNK) {
      const chunk = jobs.slice(i, i + PGBOSS_INSERT_CHUNK);

      // Conflict loss is NOT observable on this path, so nothing here pretends
      // to check for it. pg-boss's BULK plan (`insertJobs`, plans.js) ends
      // `ON CONFLICT DO NOTHING` with no `RETURNING` clause, so `manager.insert`
      // evaluates `rows.length ? rows.map(i => i.id) : null` over an
      // always-empty `rows` and resolves `null` — identically whether it wrote
      // every row or one. (Measured on the pinned 10.3.2: a 3-row insert onto a
      // `short` queue leaves 1 row on the queue and still resolves `null`.) The
      // SINGLE-job plan `insertJob` does carry `RETURNING id`, which is why
      // sendToQueue's null-check above is real work; that intuition does not
      // transfer here, and a previous revision of this loop read `insert()`'s
      // return as an id array and logged a drop — code that could never run.
      //
      // Not checking costs nothing, because the enforcing-policy throw above
      // makes a conflict unreachable. The `ON CONFLICT` has no target, so it
      // absorbs any unique constraint on pgboss.job, and there are five:
      //   - PK (name, id) — `id` is COALESCE(id, gen_random_uuid()) and the map
      //     above never sets one.
      //   - job_i1 / job_i2 / job_i3 — partial on policy short / singleton /
      //     stately, which is precisely what the throw refuses. The registry
      //     behind `enforcingPolicyFor` is the same one onModuleInit provisions
      //     from, and it calls `updateQueue` on every boot — which writes
      //     `policy = COALESCE($2, policy)` with $2 defaulted to 'standard' —
      //     so the declared policy and the queue row's `q.policy` cannot drift.
      //   - job_i4 — partial on `singleton_on IS NOT NULL`, which requires a
      //     per-job `singletonSeconds`. EventSendOptions has no such field, so
      //     this path cannot produce one.
      // The other way rows vanish is not a conflict at all: `insertJobs` INNER
      // JOINs pgboss.queue, so an unprovisioned queue silently swallows the
      // whole batch. That is what the getRegisteredQueues() check at the top of
      // sendMany is for.
      await this.boss.insert(chunk);
    }

    this.logger.debug(`Bulk-enqueued ${jobs.length} events onto queue ${queue}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Operator controls (`ci.job_settings`, surfaced on the Jobs page).
  //
  // Every one of these reads a synchronous in-memory snapshot the store keeps
  // refreshed on a timer. None of them can throw, and when the store has never
  // been configured — unit tests, CLI scripts, an appliance whose migration has
  // not run — they all answer "no opinion", which is byte-for-byte the behaviour
  // this file had before the table existed.
  // ─────────────────────────────────────────────────────────────────────────

  /** What this queue is allowed to do right now, global pause included. */
  private queueMode(queue: string): JobMode {
    return JobControlStore.queueMode(queue, { interactive: this.interactiveQueues.has(queue) });
  }

  /**
   * Whether this queue refuses new work.
   *
   * Only `disabled` drops an enqueue. `paused` deliberately does not: the point
   * of pausing is to stop the box working while losing nothing, so the sends
   * keep landing and the backlog is what drains when it comes back.
   */
  private isQueueDisabled(queue: string): boolean {
    return this.queueMode(queue) === 'disabled';
  }

  /**
   * Note that a disabled queue threw work away.
   *
   * Counted, not merely logged, because the alternative is a queue that reads as
   * quiet on the Jobs page while thousands of jobs a minute evaporate — the
   * "silent failure" the whole control is supposed to avoid. The counter is
   * folded into the row in batches, so this stays free on the import fan-out
   * path that calls it once per row.
   *
   * The log line, by contrast, is emitted ONCE per queue per settings revision.
   * This sits on the same path: an import fan-out reaches it once per imported
   * row, and a line per dropped job would bury the rest of the log under a
   * million copies of the same sentence — while telling an operator nothing the
   * counter does not. It is a `warn` rather than a `debug` because dropping work
   * deserves to be visible at default log levels; saying it once is what makes
   * that affordable.
   */
  private recordQueueDrop(queue: string, count: number): void {
    JobControlStore.recordSkip('queue', queue, count);

    // A settings change resets the "already said this" state, so switching a
    // queue off again after re-enabling it logs again rather than staying silent
    // for the life of the process.
    const revision = JobControlStore.revision();

    if (revision !== this.loggedDropsRevision) {
      this.loggedDropsRevision = revision;
      this.loggedQueueDrops.clear();
    }

    if (this.loggedQueueDrops.has(queue)) {
      return;
    }

    this.loggedQueueDrops.add(queue);
    this.logger.warn(
      `Queue ${queue} is disabled by an operator setting: new work for it is being DROPPED, not queued. ` +
        `The running total is on the Jobs page. Logged once per queue until the setting changes.`,
    );
  }

  /**
   * The per-process share of the appliance-wide in-flight ceiling.
   *
   * The default is `shipped × processes` so that an appliance nobody has
   * configured computes back to exactly `config.queues.concurrency` per process
   * on both topologies — the acceptance criterion that defaults change nothing
   * for anyone who never opens the page.
   *
   * `floor`, so the division can only ever undershoot the operator's number;
   * `max(1, …)` because a process with zero slots is a process that has stopped,
   * and "cap concurrency at 1" must not silently mean "stop the appliance". On a
   * split deployment a cap of 1 therefore yields 1 per process, i.e. 2 — the one
   * place this rounds up, and the only alternative is a dead queue.
   */
  private effectiveGlobalConcurrency(): number {
    return perProcessGlobalConcurrency(
      JobControlStore.globalConcurrency(),
      this.shippedConcurrency,
      QUEUE_WORKER_PROCESSES,
    );
  }

  /**
   * This queue's in-flight ceiling: the tightest of everything that has an
   * opinion about it.
   *
   * Order does not matter — it is a minimum — but the three inputs are different
   * in kind and worth naming:
   *
   * - the global per-queue default (config, or the operator's override);
   * - this queue's own operator setting, if one exists;
   * - the `localConcurrency` the queue declared in code.
   *
   * The last is why this is a minimum rather than a lookup with fallbacks. A
   * queue that declared 1 did so because two of its jobs at once break something
   * — the model thrashes, the event loop stalls — and no number typed into a
   * settings page should be able to override that. The UI shows the declared
   * ceiling as the row's maximum, so the constraint is visible rather than
   * merely enforced.
   */
  private effectiveQueueConcurrency(queue: string): number {
    return computeQueueConcurrency({
      perQueueDefault: perQueueDefaultConcurrency(
        JobControlStore.perQueueConcurrency(),
        this.shippedPerQueueConcurrency,
      ),
      requested: JobControlStore.row('queue', queue)?.concurrency ?? null,
      declared: this.declaredQueueCeilings.get(queue) ?? null,
    });
  }

  /**
   * Re-size the semaphores to match the current settings.
   *
   * `p-limit`'s `concurrency` setter is live in both directions: raising it
   * releases queued callbacks on the next microtask, and lowering it admits
   * nothing new while leaving jobs already running to finish. So an operator
   * dropping a cap sees the queue quiet down as its in-flight jobs complete,
   * rather than seeing work killed — which is the behaviour you want from a
   * control you reach for because the machine is already struggling.
   *
   * Guarded on the store's revision because each assignment schedules a
   * microtask; called from every queue's work loop, an unguarded version would
   * schedule dozens of them per second forever.
   */
  private syncConcurrencyLimits(): void {
    const revision = JobControlStore.revision();

    if (revision === this.controlsRevision) {
      return;
    }

    this.controlsRevision = revision;

    const globalConcurrency = this.effectiveGlobalConcurrency();

    if (this.globalSemaphore.concurrency !== globalConcurrency) {
      this.logger.log(
        `Global job concurrency set to ${globalConcurrency} in this process ` +
          `(${QUEUE_WORKER_PROCESSES} queue-serving process(es) on this appliance)`,
      );
      this.globalSemaphore.concurrency = globalConcurrency;
    }

    for (const [queue, semaphore] of this.perQueueSemaphores) {
      const next = this.effectiveQueueConcurrency(queue);

      if (semaphore.concurrency !== next) {
        this.logger.log(`Queue ${queue} concurrency set to ${next}`);
        semaphore.concurrency = next;
      }
    }
  }

  /** One line per mode transition, rather than one per five-second wake-up. */
  private logQueueMode(queue: string, mode: JobMode): void {
    if (this.loggedQueueModes.get(queue) === mode) {
      return;
    }

    this.loggedQueueModes.set(queue, mode);

    if (mode === 'enabled') {
      this.logger.log(`Queue ${queue} is running`);

      return;
    }

    this.logger.warn(
      mode === 'paused'
        ? `Queue ${queue} is paused by an operator setting; jobs stay queued and nothing is being worked`
        : `Queue ${queue} is disabled by an operator setting; new work is dropped and nothing queued is being worked`,
    );
  }

  private async work(queueName: string): Promise<void> {
    this.running = true;

    const perQueueSemaphore = this.perQueueSemaphores.get(queueName);

    if (perQueueSemaphore == null) {
      this.logger.error(`No per-queue semaphore for ${queueName}; worker will not start`);

      return;
    }

    while (this.running) {
      // Re-size the semaphores if — and only if — a setting moved. `revision()`
      // is an integer the store bumps on a real change, so the steady-state cost
      // of having runtime-tunable concurrency is one comparison per poll.
      this.syncConcurrencyLimits();

      // The operator's switch, on the EXECUTE side.
      //
      // Not fetching is the whole mechanism, and it is deliberately gentler than
      // it could be: the jobs stay `created`, pg-boss holds no lease on them,
      // and they run in order the moment the queue is switched back on. That is
      // what makes `paused` safe to reach for on a hot box — it costs a backlog,
      // never work.
      //
      // A `disabled` queue lands here too. Its own sends were already dropped at
      // enqueue, so what this stops is whatever was queued BEFORE the switch —
      // without which "disabled" would still burn a box down through an existing
      // backlog of 12,000 jobs.
      const mode = this.queueMode(queueName);

      if (mode !== 'enabled') {
        this.logQueueMode(queueName, mode);
        await new Promise((resolve) => setTimeout(resolve, this.backoffWhenEmpty));

        continue;
      }

      this.logQueueMode(queueName, mode);

      // Available slots are bounded by BOTH this queue's own ceiling and the
      // global ceiling, so one queue can never consume more than its share of the
      // global pool (no cross-queue starvation) nor exceed the total cap.
      const perQueueInFlight = perQueueSemaphore.activeCount + perQueueSemaphore.pendingCount;
      const perQueueAvailable = Math.max(perQueueSemaphore.concurrency - perQueueInFlight, 0);

      const globalInFlight = this.globalSemaphore.activeCount + this.globalSemaphore.pendingCount;
      const globalAvailable = Math.max(this.globalSemaphore.concurrency - globalInFlight, 0);

      const available = Math.min(perQueueAvailable, globalAvailable);

      if (available === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.backoffWhenFull));
        continue;
      }

      let jobs: JobWithMetadata<EventData>[];

      try {
        jobs = await this.boss.fetch<EventData>(queueName, {
          includeMetadata: true,
          batchSize: Math.min(available, this.fetchBatchSize),
        });
      } catch (err: unknown) {
        // A fetch failure is transient by nature — a dropped connection, a
        // failover, a statement timeout under load. Unguarded, it escaped the
        // `while` loop and rejected the promise sitting in `stopTasks`, which
        // nothing awaits until shutdown: an unhandled rejection that takes the
        // whole process down AND, if it did not, would leave this queue with no
        // worker for the rest of the process's life while every other queue kept
        // running. Log, back off, and go round again.
        this.logger.error(
          `Failed to fetch jobs from queue ${queueName}; retrying after backoff`,
          err instanceof Error ? err : new Error(String(err)),
        );

        await new Promise((resolve) => setTimeout(resolve, this.backoffWhenEmpty));

        continue;
      }

      if (jobs.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.backoffWhenEmpty));

        continue;
      }

      for (const job of jobs) {
        // Hold a per-queue slot for the whole job, and a global slot for the work
        // itself — so total in-flight respects both the per-queue and global caps.
        //
        // Deliberately not awaited: the loop's job is to keep fetching while
        // these run. But an un-awaited promise that rejects is an unhandled
        // rejection, so the chain below must be total — `runJob` catches
        // everything it can, and this `.catch` is the backstop for anything it
        // cannot (a semaphore that throws, an error thrown by the logger itself).
        void perQueueSemaphore(() => this.runJob(queueName, job)).catch((err: unknown) => {
          this.logger.error(
            `Job supervision failed on queue ${queueName}`,
            err instanceof Error ? err : new Error(String(err)),
          );
        });
      }
    }
  }

  /**
   * Run one fetched job to a terminal outcome.
   *
   * The completion bookkeeping is deliberately NOT inside the same `try` as the
   * listener. It used to be, and that conflated two unrelated failures: when
   * `boss.complete()` threw on a job whose listener had already SUCCEEDED, the
   * shared catch called `boss.fail()` — burning a retry on completed work and,
   * once the retries ran out, dead-lettering a job that had done its job. A
   * transient error on the acknowledgement round trip became duplicated work.
   *
   * Split, the two failures get the treatment each deserves: a listener failure
   * fails the job (pg-boss retries, then dead-letters), while a completion
   * failure is only logged. The job stays `active` and pg-boss's own expiration
   * re-queues it on schedule — at-least-once, which is what a queue promises
   * anyway, instead of a false negative that looks like a bug in the handler.
   */
  private async runJob(queueName: string, job: JobWithMetadata<EventData>): Promise<void> {
    await this.globalSemaphore(async () => {
      let outcome: 'completed' | 'deferred';

      try {
        outcome = await this.executeJob(queueName, job);
      } catch (err: unknown) {
        // Persist the failure reason in the job's output so it survives in
        // pgboss.job — without this arg the error is lost and a failed job
        // is undiagnosable after the fact.
        await this.failJobQuietly(queueName, job.id, err);

        return;
      }

      // Deferred jobs stay `active` in pg-boss: an out-of-band caller
      // (webhook) completes/fails them by id, or the queue's
      // expireInSeconds elapses and pg-boss retries.
      if (outcome === 'deferred') {
        return;
      }

      try {
        await this.boss.complete(queueName, job.id);
      } catch (err: unknown) {
        this.logger.error(
          `Job ${job.id} on queue ${queueName} succeeded but could not be marked complete; ` +
            `it will be retried when its lease expires`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  }

  /**
   * Mark a job failed, recording why, and never throw while doing it.
   *
   * `boss.fail()` is itself a database round trip and can fail for the same
   * reasons the job did. When that happened inside the worker's un-awaited
   * callback it became an unhandled rejection — a job failure escalating into a
   * process exit. The job is left `active` here and pg-boss's expiration will
   * retry it, which is the same outcome as a crash, minus the crash.
   */
  private async failJobQuietly(queueName: string, jobId: string, reason: unknown): Promise<void> {
    this.logger.error(
      `Job ${jobId} failed on queue ${queueName}`,
      reason instanceof Error ? reason : new Error(String(reason)),
    );

    try {
      await this.boss.fail(queueName, jobId, {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        failedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      this.logger.error(
        `Could not record the failure of job ${jobId} on queue ${queueName}; ` +
          `it will be retried when its lease expires`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async flush(): Promise<void> {
    this.running = false;

    try {
      await Promise.all(this.stopTasks);
    } catch (err: unknown) {
      this.logger.error(err instanceof Error ? err : new Error(String(err)));
    }

    // Every in-flight job holds a per-queue slot for its whole lifetime (the
    // global slot is nested inside), so draining all per-queue semaphores drains
    // everything.
    while (this.totalInFlightJobs() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Total jobs currently running or queued across every per-queue semaphore. */
  private totalInFlightJobs(): number {
    let count = 0;

    for (const semaphore of this.perQueueSemaphores.values()) {
      count += semaphore.activeCount + semaphore.pendingCount;
    }

    return count;
  }

  /**
   * Complete a job that a listener deferred (see {@link Acknowledgement.defer}).
   * Called out-of-band, typically by a webhook controller once the external
   * executor reports success.
   */
  async completeJob(queue: string, jobId: string, output?: Record<string, unknown>): Promise<void> {
    await this.boss.complete(queue, jobId, output);
    this.logger.log('Completed deferred job', { queue, jobId });
  }

  /**
   * Fail a deferred job so pg-boss applies its retry/dead-letter policy. The
   * output is persisted on the job row so the failure stays diagnosable.
   */
  async failJob(queue: string, jobId: string, output?: Record<string, unknown>): Promise<void> {
    await this.boss.fail(queue, jobId, output);
    this.logger.warn(`Failed deferred job ${jobId} on queue ${queue}`);
  }

  private async executeJob(
    queue: string,
    job: JobWithMetadata<EventData>,
  ): Promise<'completed' | 'deferred'> {
    // The user id travels in the job PAYLOAD, not on the job row: pgboss.job has
    // no userId column (its columns are id, name, priority, data, state,
    // retry_*, start_after, started_on, singleton_*, expire_in, created_on,
    // completed_on, keep_until, output, dead_letter, policy). This used to read
    // `(job as { userId?: string }).userId`, i.e. a field that cannot exist, so
    // ContextService.getUserId() returned null inside EVERY background job —
    // measured on a live appliance as 36,923 of 41,580 queued jobs carrying a
    // `data->>'userId'` that never reached the context they were executed in.
    const userId = job.data?.userId;

    return ContextService.run({ traceId: job.id, userId }, () => {
      return new Promise<'completed' | 'deferred'>((resolve, reject) => {
        const { name, ...data } = job.data;

        const resolvedData = {
          ...data,
          jobId: job.id,
        };

        this.logger.log('Executing job', {
          eventName: name,
          queue,
          ...(userId ? { userId } : {}),
        });

        const done = () => {
          this.logger.log('Completed job');
          resolve('completed');
        };

        const fail = (reason: unknown) => {
          this.logger.error('Failed job', reason instanceof Error ? reason : new Error(String(reason)));
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };

        const defer = () => {
          this.logger.log('Deferred job completion', { queue, jobId: job.id });
          resolve('deferred');
        };

        const skip = () => {
          this.logger.log('No listeners found, skipping job');
          resolve('completed');
        };

        const queueSpecificEventName = `${name}:${queue}`;

        if (this.eventEmitter.hasListeners(queueSpecificEventName)) {
          this.eventEmitter.emit(queueSpecificEventName, resolvedData, { done, fail, defer });
        } else {
          skip();
        }
      });
    });
  }
}
