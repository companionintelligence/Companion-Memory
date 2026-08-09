import { Injectable, BeforeApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type EventPayloads } from '../event-registry';
import { EventRegistry } from '../registry';
import type { EventSendOptions } from '../types';

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
    options?: EventSendOptions,
  ): Promise<string[]>;

  async send<E extends keyof EventRegistry>(
    name: E,
    event: EventRegistry[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  // `options.priority` is accepted for signature parity with the pg-boss
  // implementation and deliberately ignored: this service executes listeners
  // inline at the call site, so there is no pending queue to order.
  async send<E extends string>(
    name: E,
    event: EventRegistry[keyof EventRegistry] | EventPayloads[keyof EventPayloads],
    options?: EventSendOptions,
  ): Promise<string[]> {
    const traceId = uuidv4();
    const userId = (event as { userId?: string }).userId;

    const executionPromise = ContextService.run({ traceId, userId }, async () => {
      let targetQueues: Set<string>;

      if (options?.queue) {
        if (!this.getRegisteredQueues().has(options.queue)) {
          this.logger.warn(
            `Requested queue ${options.queue} does not exist. Event ${name} will not be sent.`,
          );

          return [];
        }

        targetQueues = new Set([options.queue]);
      } else {
        // Route by listener, exactly as the pg-boss implementation does. This
        // path used to iterate EVERY registered queue and rely on executeJob's
        // hasListeners() check to no-op on the ones that don't care — cheap here
        // (no jobs are persisted), which is precisely why the equivalent waste in
        // production went unnoticed by the test suite for so long. Keeping the
        // two routing rules identical is the point: local behaviour is the
        // behaviour tests assert.
        targetQueues = this.getQueuesForEvent(name);

        if (targetQueues.size === 0) {
          this.logger.warn(`Event ${name} has no registered listeners on any queue; nothing was executed.`);

          return [];
        }
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

  // The base class declares a third `options` parameter carrying `priority`.
  // It is omitted here rather than accepted and discarded: inline execution has
  // no queue to reorder, so there is nothing to honour.
  async sendMany(
    queue: string,
    events: Array<{ name: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    if (!this.getRegisteredQueues().has(queue)) {
      this.logger.warn(`Requested queue ${queue} does not exist. ${events.length} events will not be sent.`);

      return;
    }

    // LocalEventService executes inline (no pg-boss), so there is no bulk-insert
    // fast path — just run each event through the same single-queue execution
    // send() uses. Fine for dev/test volumes; the pg-boss impl carries the
    // import-scale bulk path.
    for (const event of events) {
      const job: JobWithMetadata<EventData> = {
        id: uuidv4(),
        data: { name: event.name, ...event.data },
        userId: (event.data as { userId?: string }).userId,
      };

      await this.executeJob(queue, job);
    }
  }

  // No persistent queue to complete against — deferred jobs were already
  // released inline (defer resolves like done here), so this is a no-op.
  async completeJob(queue: string, jobId: string): Promise<void> {
    this.logger.debug(`completeJob(${queue}, ${jobId}) is a no-op for LocalEventService`);
  }

  async failJob(queue: string, jobId: string, output?: Record<string, unknown>): Promise<void> {
    this.logger.warn(
      `failJob(${queue}, ${jobId}) is a no-op for LocalEventService${output ? `: ${JSON.stringify(output)}` : ''}`,
    );
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

        // Inline execution has no persistent job to leave active, so a defer
        // simply releases the caller — the external executor's webhook will hit
        // completeJob(), which is a no-op here.
        const defer = () => {
          this.logger.log(`Deferred job ${job.id} for event ${name} (inline: treated as done)`);
          resolve();
        };

        const queueSpecificEventName = `${name}:${queue}`;

        if (this.eventEmitter.hasListeners(queueSpecificEventName)) {
          this.eventEmitter.emit(queueSpecificEventName, resolvedData, { done, fail, defer });
        } else {
          this.logger.log(`No listeners for event ${name} in queue ${queue}`);
          resolve();
        }
      });
    });
  }
}
