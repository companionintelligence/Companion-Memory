import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import plimit from 'p-limit';
import PgBoss, { JobWithMetadata } from 'pg-boss';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { DEFAULT_JOB_PRIORITY } from '../constants';
import { EventDefinitionRegistry, EventListenerRegistry } from '../event-registration';
import { type EventPayloads } from '../event-registry';
import { EventRegistry } from '../registry';
import type { EventSendOptions } from '../types';

import { EventService } from './EventService';

interface EventData {
  name: string;
}

// Rows per pg-boss insert() call in sendMany(). Bounds the single INSERT's
// parameter/row count so a multi-million-row backfill streams in fixed chunks
// instead of one enormous statement.
const PGBOSS_INSERT_CHUNK = 2000;

@Injectable()
export class PGBossEventService extends EventService implements OnModuleInit, OnModuleDestroy {
  // Global in-flight job ceiling across ALL queues (bounds total DB/Ollama load).
  // Configurable (CI_QUEUE_CONCURRENCY) so the decoupled embedding/index workers
  // can be scaled for bulk imports.
  private globalSemaphore = plimit(config.queues.concurrency);

  // Per-queue in-flight ceiling — one plimit per queue, created in onModuleInit.
  // Sized BELOW the global ceiling (CI_QUEUE_PER_QUEUE_CONCURRENCY) so a burst of
  // slow jobs on one queue can't take every global slot and starve another queue
  // (the search-index backlog stall behind image-description/embedding jobs).
  private readonly perQueueSemaphores = new Map<string, ReturnType<typeof plimit>>();

  private readonly perQueueConcurrency = config.queues.perQueueConcurrency;

  private readonly fetchBatchSize = config.queues.fetchBatchSize;

  // Shared dead-letter queue. Jobs that exhaust their retries are moved here
  // (payload + failure output preserved) instead of vanishing when pgboss deletes
  // failed jobs after deleteAfterHours — so a failure stays inspectable. Nothing
  // works this queue, so entries accumulate; it carries a long retention.
  private static readonly DEAD_LETTER_QUEUE = 'dead-letter';

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
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    expireInHours: 12,
    deleteAfterHours: 24,
    max: 10,
  });

  constructor(
    protected readonly eventEmitter: EventEmitter2,
    protected readonly logger: LoggerService,
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

    this.boss.on('error', (err) => {
      this.logger.error('PgBoss error', err);
    });

    // Discover all queues from registered listeners
    const discoveredQueues = this.getRegisteredQueues();

    this.logger.debug(`Discovered queues: ${Array.from(discoveredQueues).join(', ')}`);

    this.warnOnOrphanEvents();

    // Create the shared dead-letter queue FIRST so the work queues can reference
    // it. Long retention so exhausted-retry jobs stay inspectable; no worker
    // consumes it (it is not a registered listener queue), so entries accumulate.
    await this.boss.createQueue(PGBossEventService.DEAD_LETTER_QUEUE, {
      name: PGBossEventService.DEAD_LETTER_QUEUE,
      retentionDays: 30,
    });

    // Create all discovered queues, routing exhausted-retry jobs to the DLQ and
    // giving each its own concurrency semaphore. createQueue is idempotent and
    // won't update an existing queue's options, so updateQueue (a COALESCE merge)
    // applies deadLetter to queues that already exist on a live DB too.
    for (const queue of discoveredQueues) {
      // Listener-requested queue-level options (expiration/retries) — used by
      // deferred-completion queues whose jobs stay active while an external
      // executor works, so their expiration must match the work's runtime.
      const queueOptions = EventListenerRegistry.getQueueOptions(queue) ?? {};

      const options = { name: queue, deadLetter: PGBossEventService.DEAD_LETTER_QUEUE, ...queueOptions };

      await this.boss.createQueue(queue, options);
      await this.boss.updateQueue(queue, options);
      this.perQueueSemaphores.set(queue, plimit(this.perQueueConcurrency));
      this.logger.debug(`Created queue: ${queue} (deadLetter=${PGBossEventService.DEAD_LETTER_QUEUE})`);
    }

    try {
      this.logger.debug('Initializing work queues...');

      // Start workers for all discovered queues
      for (const queue of discoveredQueues) {
        this.stopTasks.push(this.work(queue));
      }

      this.logger.debug(`Initialized ${discoveredQueues.size} work queues`);
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

      const jobId = await this.boss.send(options.queue, resolvedData, sendOptions);

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

      try {
        const jobId = await this.boss.send(queue, resolvedData, sendOptions);

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
    }));

    for (let i = 0; i < jobs.length; i += PGBOSS_INSERT_CHUNK) {
      await this.boss.insert(jobs.slice(i, i + PGBOSS_INSERT_CHUNK));
    }

    this.logger.debug(`Bulk-enqueued ${jobs.length} events onto queue ${queue}`);
  }

  private async work(queueName: string): Promise<void> {
    this.running = true;

    const perQueueSemaphore = this.perQueueSemaphores.get(queueName);

    if (perQueueSemaphore == null) {
      this.logger.error(`No per-queue semaphore for ${queueName}; worker will not start`);

      return;
    }

    while (this.running) {
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

      const jobs = await this.boss.fetch<EventData>(queueName, {
        includeMetadata: true,
        batchSize: Math.min(available, this.fetchBatchSize),
      });

      if (jobs.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.backoffWhenEmpty));

        continue;
      }

      for (const job of jobs) {
        // Hold a per-queue slot for the whole job, and a global slot for the work
        // itself — so total in-flight respects both the per-queue and global caps.
        perQueueSemaphore(async () => {
          await this.globalSemaphore(async () => {
            try {
              const outcome = await this.executeJob(queueName, job);

              // Deferred jobs stay `active` in pg-boss: an out-of-band caller
              // (webhook) completes/fails them by id, or the queue's
              // expireInSeconds elapses and pg-boss retries.
              if (outcome !== 'deferred') {
                await this.boss.complete(queueName, job.id);
              }
            } catch (err) {
              this.logger.error(
                `Failed to complete job in queue ${queueName}`,
                err instanceof Error ? err : new Error(String(err)),
              );
              // Persist the failure reason in the job's output so it survives in
              // pgboss.job — without this arg the error is lost and a failed job
              // is undiagnosable after the fact.
              await this.boss.fail(queueName, job.id, {
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                failedAt: new Date().toISOString(),
              });
            }
          });
        });
      }
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
    const userId = (job as { userId?: string }).userId;

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
