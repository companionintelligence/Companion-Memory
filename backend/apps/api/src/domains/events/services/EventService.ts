import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import PgBoss from 'pg-boss';

import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';

import { type EventPayloads } from '../event-registry';

export enum Queues {
  DEFAULT = 'default',
}

interface EventData {
  name: string;
}

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private logger = new LoggerService(EventService.name);

  private boss = new PgBoss({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.username,
    password: config.db.password,
    schema: 'pgboss',
    // Optional PgBoss settings
    retryLimit: 3,
    retryDelay: 1000,
    expireInHours: 12, // Must be less than 24 hours for PgBoss v10+
    deleteAfterHours: 24, // Also reduced to be reasonable
    max: 10, // maxPoolSize equivalent
  });

  constructor(private eventEmitter: EventEmitter2) {}

  async onModuleInit() {
    try {
      await this.boss.start();
      this.logger.log('Initialized PgBoss client');
    } catch (error: unknown) {
      this.logger.error('Failed to initialize PgBoss client', error as Error);
      throw error;
    }

    this.boss.on('error', (err) => {
      this.logger.error('PgBoss error', err);
    });

    // For now we're only interested in one queue. We might want to add more if
    // we need certain tasks to run in parallel, with a larger number of workers,
    // or with different characteristics. Measure and improve as needed.
    await this.boss.createQueue(Queues.DEFAULT);

    await this.boss.work<EventData>(Queues.DEFAULT, async ([job]) => {
      const { name, ...data } = job.data;

      const resolvedData = {
        ...data,
        jobId: job.id,
      };

      this.eventEmitter.emit(name, resolvedData);
    });
  }

  async onModuleDestroy() {
    try {
      await this.boss.stop();
      this.logger.log('Stopped PgBoss client');
    } catch (error: unknown) {
      this.logger.error('Failed to stop PgBoss client', error as Error);
      throw error;
    }
  }

  async send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: { queue?: Queues },
  ): Promise<string | null> {
    const resolvedOptions = options ?? {
      queue: Queues.DEFAULT,
    };

    const { queue } = resolvedOptions;
    const resolvedQueue = queue ?? Queues.DEFAULT;

    const resolvedData = {
      ...event,
      name,
    } satisfies EventData;

    return this.boss.send(resolvedQueue, resolvedData);
  }

  async getJobs(queue?: string, limit = 100): Promise<PgBoss.Job[]> {
    const resolvedQueue = queue ?? Queues.DEFAULT;
    
    try {
      // Use the internal pg-boss methods to get all job data
      // This is a more reliable approach than trying to fetch from different states
      const connection = this.boss.db;
      if (!connection) {
        this.logger.warn('Database connection not available');
        return [];
      }

      // Query the pg-boss job table directly for better reliability
      const query = `
        SELECT id, name, data, state, priority, 
               createdon as "createdOn", startedon as "startedOn", 
               completedon as "completedOn", failedreason as "failedReason",
               retrycount as "retryCount", expirein as "expireIn"
        FROM pgboss.job 
        WHERE name LIKE $1 
        ORDER BY createdon DESC 
        LIMIT $2
      `;
      
      const result = await connection.query(query, [`%${resolvedQueue}%`, limit]);
      return result.rows || [];
    } catch (error) {
      this.logger.error('Failed to get jobs', error as Error);
      // Fallback to empty array - don't crash the system
      return [];
    }
  }

  async getJobById(id: string): Promise<PgBoss.Job | null> {
    try {
      return await this.boss.getJobById(id);
    } catch (error) {
      this.logger.error('Failed to get job by ID', error as Error);
      return null;
    }
  }

  async cancelJob(id: string): Promise<boolean> {
    try {
      return await this.boss.cancel(id);
    } catch (error) {
      this.logger.error('Failed to cancel job', error as Error);
      return false;
    }
  }

  async resumeJob(id: string): Promise<boolean> {
    try {
      return await this.boss.resume(id);
    } catch (error) {
      this.logger.error('Failed to resume job', error as Error);
      return false;
    }
  }
}
