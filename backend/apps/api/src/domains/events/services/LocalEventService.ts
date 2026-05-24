import { Injectable, BeforeApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type EventPayloads } from '../event-registry';
import { EventRegistry } from '../registry';

import { EventService } from './EventService';

interface EventData {
  name: string;
}

interface JobWithMetadata<T> {
  id: string;
  data: T;
  userId?: string;
}

@Injectable()
export class LocalEventService extends EventService implements BeforeApplicationShutdown {
  private pendingJobs: Promise<string[]>[] = [];

  constructor(
    protected readonly eventEmitter: EventEmitter2,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(LocalEventService.name);
  }

  async beforeApplicationShutdown() {
    if (this.pendingJobs.length > 0) {
      this.logger.log(`Waiting for ${this.pendingJobs.length} background jobs to finish...`);
      await Promise.allSettled(this.pendingJobs);
      this.logger.log('All background jobs finished');
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
    const traceId = uuidv4();
    const userId = (event as { userId?: string }).userId;

    const executionPromise = ContextService.run({ traceId, userId }, async () => {
      const allQueues = this.getRegisteredQueues();
      let targetQueues: Set<string>;

      if (options?.queue) {
        if (!allQueues.has(options.queue)) {
          this.logger.warn(
            `Requested queue ${options.queue} does not exist. Event ${name} will not be sent.`,
          );

          return [];
        }

        targetQueues = new Set([options.queue]);
      } else {
        targetQueues = allQueues;
      }

      const job: JobWithMetadata<EventData> = {
        id: traceId,
        data: {
          name,
          ...event,
        },
        userId,
      };

      const promises: Promise<void>[] = [];

      for (const queue of targetQueues) {
        this.logger.debug(`Executing job for event ${name} directly in queue ${queue}`);
        promises.push(this.executeJob(queue, job));
      }

      await Promise.all(promises);

      this.logger.debug(`Finished direct execution of event ${name} for ${promises.length} queues`);

      return [traceId];
    });

    this.trackJob(executionPromise);

    return executionPromise;
  }

  private trackJob(promise: Promise<string[]>) {
    this.pendingJobs.push(promise);

    promise.finally(() => {
      this.pendingJobs = this.pendingJobs.filter((p) => p !== promise);
    });
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

        this.logger.log(`Executing job for event ${name} in queue ${queue}`, userId ? { userId } : undefined);

        const done = () => {
          this.logger.log(`Completed job ${job.id} for event ${name}`);
          resolve();
        };

        const fail = (reason: unknown) => {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          this.logger.error(`Failed job ${job.id} for event ${name}`, error);
          reject(error);
        };

        const queueSpecificEventName = `${name}:${queue}`;

        if (this.eventEmitter.hasListeners(queueSpecificEventName)) {
          this.eventEmitter.emit(queueSpecificEventName, resolvedData, { done, fail });
        } else {
          this.logger.log(`No listeners for event ${name} in queue ${queue}`);
          resolve();
        }
      });
    });
  }
}
