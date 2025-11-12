import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import plimit from 'p-limit';
import PgBoss, { JobWithMetadata } from 'pg-boss';

import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';

import { DEFAULT_QUEUE, WRITER_ONLY_QUEUES } from '../constants';
import { type EventPayloads } from '../event-registry';
import { EventListenerRegistry } from '../EventListenerRegistry';

interface EventData {
  name: string;
}

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new LoggerService(EventService.name);

  private semaphore = plimit(10);

  private running = false;

  private stopTasks: Promise<void>[] = [];

  private readonly backoffWhenFull = 150;

  private readonly backoffWhenEmpty = 5000;

  private readonly writerOnlyQueues = new Set<string>(WRITER_ONLY_QUEUES);

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

  constructor(private eventEmitter: EventEmitter2) {}

  async onModuleInit() {
    const listeners = EventListenerRegistry.getListeners();

    this.logger.log(`Validated ${listeners.length} event listeners`);

    listeners.forEach(([key, registration]) => {
      this.logger.debug(
        `Event listener registered: ${key} -> ${registration.className}.${registration.methodName}`,
      );
    });

    try {
      this.logger.log('Initializing PgBoss client...');

      await this.boss.start();

      this.logger.log('Initialized PgBoss client');
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

    const workerQueues = this.getWorkerQueues();
    const allQueues = new Set<string>([...workerQueues, ...this.writerOnlyQueues]);

    this.logger.log(`Discovered worker queues: ${Array.from(workerQueues).join(', ')}`);
    if (this.writerOnlyQueues.size > 0) {
      this.logger.log(`Discovered writer-only queues: ${Array.from(this.writerOnlyQueues).join(', ')}`);
    }

    // Create queues whether or not they have workers on this service
    for (const queue of allQueues) {
      await this.boss.createQueue(queue);
      this.logger.debug(`Created queue: ${queue}`);
    }

    try {
      this.logger.log('Initializing work queues...');

      // Start workers for all discovered queues
      for (const queue of workerQueues) {
        this.stopTasks.push(this.work(queue));
      }

      this.logger.log(`Initialized ${workerQueues.size} work queues`);
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
      this.logger.log('Flushing work queues...');

      await this.flush();

      this.logger.log('Flushed work queues');
    } catch (err: unknown) {
      this.logger.error('Failed to flush work queues', err instanceof Error ? err : new Error(String(err)));
    }

    try {
      this.logger.log('Stopping PgBoss client...');

      await this.boss.stop();

      this.logger.log('Stopped PgBoss client');
    } catch (err: unknown) {
      this.logger.error('Failed to stop PgBoss client', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: { queue?: string },
  ): Promise<string[]> {
    const resolvedData = {
      ...event,
      name,
    } satisfies EventData;

    const workerQueues = this.getWorkerQueues();
    const allQueues = new Set<string>([...workerQueues, ...this.writerOnlyQueues]);

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

    for (const queue of workerQueues) {
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

  private getWorkerQueues(): Set<string> {
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
        batchSize: available,
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
    return new Promise((resolve, reject) => {
      const { name, ...data } = job.data;

      const resolvedData = {
        ...data,
        jobId: job.id,
      };

      const done = () => resolve(undefined);
      const fail = (reason: unknown) => reject(reason instanceof Error ? reason : new Error(String(reason)));

      const queueSpecificEventName = `${name}:${queue}`;

      if (this.eventEmitter.hasListeners(queueSpecificEventName)) {
        this.eventEmitter.emit(queueSpecificEventName, resolvedData, { done, fail });
      } else {
        this.logger.log(`No listeners for event ${name} in queue ${queue}`);

        resolve(undefined);
      }
    });
  }
}
