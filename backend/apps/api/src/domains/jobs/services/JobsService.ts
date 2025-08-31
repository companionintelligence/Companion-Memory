import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import { EventService } from '@ci/domains/events';

export interface JobInfo {
  id: string;
  name: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'expired' | 'cancelled' | 'failed';
  priority?: number;
  data: any;
  createdOn: Date;
  startedOn?: Date;
  completedOn?: Date;
  retryCount?: number;
  retryLimit?: number;
  output?: any;
}

@Injectable()
export class JobsService {
  private logger = new LoggerService(JobsService.name);

  constructor(private readonly eventService: EventService) {}

  async getJobs(): Promise<JobInfo[]> {
    try {
      // For now, return some mock data that represents what PgBoss jobs would look like
      // In a real implementation, we'd query the pgboss.job table directly via SQL
      // or wait for PgBoss to provide better queue introspection APIs
      return [
        {
          id: '1234',
          name: 'default',
          state: 'active',
          priority: 0,
          data: { name: 'API_ENQUEUE', foo: 'test', bar: 'test' },
          createdOn: new Date(),
          startedOn: new Date(),
          retryCount: 0,
          retryLimit: 3,
        },
        {
          id: '5678',
          name: 'default', 
          state: 'completed',
          priority: 0,
          data: { name: 'SOME_TASK', message: 'Task completed successfully' },
          createdOn: new Date(Date.now() - 60000),
          startedOn: new Date(Date.now() - 45000),
          completedOn: new Date(Date.now() - 30000),
          retryCount: 0,
          retryLimit: 3,
          output: { result: 'success' },
        },
        {
          id: '9999',
          name: 'default',
          state: 'failed',
          priority: 1,
          data: { name: 'FAILED_TASK', error: 'Something went wrong' },
          createdOn: new Date(Date.now() - 120000),
          startedOn: new Date(Date.now() - 100000),
          retryCount: 2,
          retryLimit: 3,
          output: { error: 'Connection timeout' },
        },
      ];
    } catch (error) {
      this.logger.error('Failed to fetch jobs', error as Error);
      return [];
    }
  }

  async getQueueStats() {
    try {
      // Mock stats for now - in real implementation would query pgboss tables
      return {
        total: 3,
        active: 1,
        completed: 1,
        failed: 1,
        retry: 0,
        cancelled: 0,
        created: 0,
      };
    } catch (error) {
      this.logger.error('Failed to get queue stats', error as Error);
      return { total: 0, active: 0, completed: 0, failed: 0, retry: 0, cancelled: 0, created: 0 };
    }
  }

  async enqueueJob(name: string, data: any): Promise<string | null> {
    try {
      // This delegates to the existing EventService for consistency
      return this.eventService.send('API_ENQUEUE' as any, data);
    } catch (error) {
      this.logger.error('Failed to enqueue job', error as Error);
      return null;
    }
  }

  // Note: For a proper implementation, we'd need direct database access to the pgboss schema
  // to properly manage jobs, as PgBoss doesn't expose all job management operations directly
  async updateJobStatus(jobId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<boolean> {
    this.logger.log(`Mock: updating job ${jobId} to status ${status}`);
    return true;
  }

  async deleteJob(jobId: string): Promise<boolean> {
    this.logger.log(`Mock: deleting job ${jobId}`);
    return true;
  }
}