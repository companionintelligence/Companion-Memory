import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';
import { ConnectionService } from '@ci/domains/connections';
import { EventService } from '@ci/domains/events';

import { ApiEndpointRegistry } from '../config/endpoint-registry';
import type { ApiEndpointConfig, DataCollectionPayload, EtlCollectionResult, EtlJob, EtlQueues } from '../types';

@Injectable()
export class EtlCollectionService {
  private logger = new LoggerService(EtlCollectionService.name);
  private jobs = new Map<string, EtlJob>();

  constructor(
    private readonly eventService: EventService,
    private readonly connectionService: ConnectionService,
  ) {}

  // Schedule data collection every 15 minutes during business hours
  @Cron('0 */15 9-17 * * 1-5', {
    name: 'etl-data-collection',
    timeZone: 'America/New_York',
  })
  async scheduledDataCollection(): Promise<void> {
    if (!config.features['scheduled.connection.fetching']) {
      this.logger.debug('Scheduled ETL data collection is disabled');
      return;
    }

    this.logger.log('Starting scheduled ETL data collection');

    try {
      // Get all active ETL jobs
      const activeJobs = Array.from(this.jobs.values()).filter(job => job.enabled);
      
      this.logger.log(`Processing ${activeJobs.length} active ETL jobs`);

      for (const job of activeJobs) {
        await this.enqueueDataCollection(job);
      }
    } catch (error) {
      this.logger.error('Error in scheduled ETL data collection', error as Error);
    }
  }

  async createJob(job: Omit<EtlJob, 'id'>): Promise<EtlJob> {
    const id = `etl-job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fullJob: EtlJob = { ...job, id };
    
    this.jobs.set(id, fullJob);
    this.logger.log(`Created ETL job ${id} for connection ${job.connectionId}`);
    
    return fullJob;
  }

  async getJob(id: string): Promise<EtlJob | undefined> {
    return this.jobs.get(id);
  }

  async updateJobStatus(id: string, status: EtlJob['status'], metadata?: Record<string, unknown>): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      const updatedJob: EtlJob = {
        ...job,
        status,
        lastRun: status === 'success' || status === 'error' ? new Date() : job.lastRun,
        metadata: metadata ? { ...job.metadata, ...metadata } : job.metadata,
      };
      this.jobs.set(id, updatedJob);
    }
  }

  async enqueueDataCollection(job: EtlJob): Promise<string | null> {
    const endpoint = ApiEndpointRegistry.getEndpoint(job.endpointConfigId);
    if (!endpoint) {
      this.logger.error(`Unknown endpoint configuration: ${job.endpointConfigId}`);
      return null;
    }

    const payload: DataCollectionPayload = {
      jobId: job.id,
      connectionId: job.connectionId,
      endpointConfigId: job.endpointConfigId,
    };

    await this.updateJobStatus(job.id, 'running');

    return this.eventService.send('etl.data.collection' as any, payload, {
      queue: 'etl.data.collection' as any,
    });
  }

  async collectData(payload: DataCollectionPayload): Promise<EtlCollectionResult> {
    const { jobId, connectionId, endpointConfigId } = payload;
    
    this.logger.log(`Collecting data for job ${jobId}, endpoint ${endpointConfigId}`);

    try {
      // Get the API endpoint configuration
      const endpoint = ApiEndpointRegistry.getEndpoint(endpointConfigId);
      if (!endpoint) {
        throw new Error(`Unknown endpoint configuration: ${endpointConfigId}`);
      }

      // Get connection details
      // Note: We would need to adapt this to work with a user context
      // For now, this is a placeholder showing the structure
      const connection = await this.connectionService.findOne({ userId: 'system' } as any, connectionId);
      
      // Collect data from the endpoint
      const data = await this.fetchEndpointData(connection, endpoint);

      const result: EtlCollectionResult = {
        jobId,
        endpointId: endpointConfigId,
        success: true,
        data,
        recordsProcessed: this.getRecordCount(data),
        timestamp: new Date(),
      };

      await this.updateJobStatus(jobId, 'success', {
        recordsProcessed: result.recordsProcessed,
        lastCollectionTime: result.timestamp,
      });

      this.logger.log(`Successfully collected ${result.recordsProcessed} records for job ${jobId}`);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await this.updateJobStatus(jobId, 'error', {
        lastError: errorMessage,
        lastErrorTime: new Date(),
      });

      this.logger.error(`Failed to collect data for job ${jobId}`, error as Error);

      return {
        jobId,
        endpointId: endpointConfigId,
        success: false,
        error: errorMessage,
        recordsProcessed: 0,
        timestamp: new Date(),
      };
    }
  }

  private async fetchEndpointData(connection: any, endpoint: ApiEndpointConfig): Promise<unknown> {
    // This would integrate with the existing client system
    // For now, return a placeholder showing the structure
    this.logger.log(`Fetching data from ${endpoint.provider} ${endpoint.name}`);
    
    return {
      endpoint: endpoint.id,
      provider: endpoint.provider,
      timestamp: new Date(),
      data: [], // Would contain actual API response data
    };
  }

  private getRecordCount(data: unknown): number {
    if (Array.isArray(data)) {
      return data.length;
    }
    
    if (data && typeof data === 'object' && 'data' in data && Array.isArray((data as any).data)) {
      return (data as any).data.length;
    }
    
    return 1;
  }
}