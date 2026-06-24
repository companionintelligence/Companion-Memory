import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import plimit from 'p-limit';
import PgBoss, { JobWithMetadata } from 'pg-boss';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { EventListenerRegistry } from '../event-registration';
import { type EventPayloads } from '../event-registry';
import { EventRegistry } from '../registry';

import { EventService } from './EventService';

interface EventData {
  name: string;
}

@Injectable()
export class PGBossEventService extends EventService implements OnModuleInit, OnModuleDestroy {
  // Global in-flight job ceiling across all queues. Configurable (CI_QUEUE_CONCURRENCY)
  // so the decoupled embedding/index workers can be scaled for bulk imports.
  private semaphore = plimit(config.queues.concurrency);

  private readonly fetchBatchSize = config.queues.fetchBatchSize;

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

    // Create all discovered queues
    for (const queue of discoveredQueues) {
      await this.boss.createQueue(queue);
      this.logger.debug(`Created queue: ${queue}`);
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
   * @deprecated Use the new distributed EventPayloads type instead.
   */
  async send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: { queue?: string },
  ): Promise<string[]>;

  async send<E extends keyof EventRegistry>(
    name: E,
    event: EventRegistry[E],
    options?: { queue?: string },
  ): Promise<string[]>;

  async send<E extends string>(
    name: E,
    event: EventRegistry[keyof EventRegistry] | EventPayloads[keyof EventPayloads],
    options?: { queue?: string },
  ): Promise<string[]> {
    const resolvedData = {
      ...event,
      name,
    } satisfies EventData;

    const allQueues = this.getRegisteredQueues();

    // If a specific queue is provided and that queue exists, send only to that queue.
    if (options?.queue) {
      if (!allQueues.has(options.queue)) {
        this.logger.warn(`Requested queue ${options.queue} does not exist. Event ${name} will not be sent.`);

        return [];
      }

      const jobId = await this.boss.send(options.queue, resolvedData);

      return jobId ? [jobId] : [];
    }

    // Otherwise, send to all registered queues.
    const jobIds: string[] = [];

    for (const queue of allQueues) {
      try {
        const jobId = await this.boss.send(queue, resolvedData);

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

  private async work(queueName: string): Promise<void> {
    this.running = true;

    while (this.running) {
      const inFlightJobCount = this.semaphore.activeCount + this.semaphore.pendingCount;
      const available = Math.max(this.semaphore.concurrency - inFlightJobCount, 0);

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
        this.semaphore(async () => {
          try {
            await this.executeJob(queueName, job);
            await this.boss.complete(queueName, job.id);
          } catch (err) {
            this.logger.error(
              `Failed to complete job in queue ${queueName}`,
              err instanceof Error ? err : new Error(String(err)),
            );
            await this.boss.fail(queueName, job.id);
          }
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

    while (this.semaphore.activeCount + this.semaphore.pendingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async executeJob(queue: string, job: JobWithMetadata<EventData>): Promise<void> {
    const userId = (job as { userId?: string }).userId;

    return ContextService.run({ traceId: job.id, userId }, () => {
      return new Promise<void>((resolve, reject) => {
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
          resolve();
        };

        const fail = (reason: unknown) => {
          this.logger.error('Failed job', reason instanceof Error ? reason : new Error(String(reason)));
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };

        const skip = () => {
          this.logger.log('No listeners found, skipping job');
          resolve();
        };

        const queueSpecificEventName = `${name}:${queue}`;

        if (this.eventEmitter.hasListeners(queueSpecificEventName)) {
          this.eventEmitter.emit(queueSpecificEventName, resolvedData, { done, fail });
        } else {
          skip();
        }
      });
    });
  }
}
