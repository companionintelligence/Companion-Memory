import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';
import { Context } from '@ci/common/decorators';

import { ApiEndpointRegistry } from '../config/endpoint-registry';
import { EtlCollectionService } from '../services/EtlCollectionService';
import { EtlTransformService } from '../services/EtlTransformService';
import type { ApiEndpointConfig, EtlJob, EtlTransformMap } from '../types';

interface CreateEtlJobRequest {
  connectionId: string;
  endpointConfigId: string;
  transformMapId?: string;
  schedule?: string;
  enabled: boolean;
}

interface TransformDataRequest {
  transformMapId: string;
  sourceData: unknown;
}

@Controller('etl')
@UseGuards(JwtAuthGuard)
export class EtlController {
  private logger = new LoggerService(EtlController.name);

  constructor(
    private readonly etlCollectionService: EtlCollectionService,
    private readonly etlTransformService: EtlTransformService,
  ) {}

  @Get('endpoints')
  async getApiEndpoints(): Promise<{ endpoints: ApiEndpointConfig[] }> {
    const endpoints = ApiEndpointRegistry.getAllEndpoints();
    this.logger.log(`Retrieved ${endpoints.length} API endpoint configurations`);
    
    return { endpoints };
  }

  @Get('endpoints/:provider')
  async getApiEndpointsByProvider(@Param('provider') provider: string): Promise<{ endpoints: ApiEndpointConfig[] }> {
    const endpoints = ApiEndpointRegistry.getEndpointsByProvider(provider);
    this.logger.log(`Retrieved ${endpoints.length} API endpoint configurations for provider: ${provider}`);
    
    return { endpoints };
  }

  @Get('jobs')
  async getJobs(@Context() context: RequestContext): Promise<{ jobs: EtlJob[] }> {
    // In a real implementation, we would filter jobs by user
    // For now, return empty array as placeholder
    this.logger.log(`Retrieved ETL jobs for user: ${context.userId}`);
    
    return { jobs: [] };
  }

  @Post('jobs')
  async createJob(
    @Context() context: RequestContext,
    @Body() request: CreateEtlJobRequest,
  ): Promise<{ job: EtlJob }> {
    this.logger.log(`Creating ETL job for user: ${context.userId}`, {
      connectionId: request.connectionId,
      endpointConfigId: request.endpointConfigId,
    });

    // Validate the endpoint exists
    const endpoint = ApiEndpointRegistry.getEndpoint(request.endpointConfigId);
    if (!endpoint) {
      throw new Error(`Unknown endpoint configuration: ${request.endpointConfigId}`);
    }

    // Validate transform map if provided
    if (request.transformMapId) {
      const transformMap = this.etlTransformService.getTransformMap(request.transformMapId);
      if (!transformMap) {
        throw new Error(`Unknown transform map: ${request.transformMapId}`);
      }
    }

    const job = await this.etlCollectionService.createJob({
      connectionId: request.connectionId,
      endpointConfigId: request.endpointConfigId,
      transformMapId: request.transformMapId,
      schedule: request.schedule,
      enabled: request.enabled,
      status: 'idle',
    });

    this.logger.log(`Created ETL job: ${job.id}`);

    return { job };
  }

  @Get('jobs/:id')
  async getJob(
    @Context() context: RequestContext,
    @Param('id') id: string,
  ): Promise<{ job: EtlJob }> {
    const job = await this.etlCollectionService.getJob(id);
    if (!job) {
      throw new Error(`ETL job not found: ${id}`);
    }

    this.logger.log(`Retrieved ETL job: ${id} for user: ${context.userId}`);

    return { job };
  }

  @Put('jobs/:id/run')
  async runJob(
    @Context() context: RequestContext,
    @Param('id') id: string,
  ): Promise<{ message: string; jobId: string | null }> {
    const job = await this.etlCollectionService.getJob(id);
    if (!job) {
      throw new Error(`ETL job not found: ${id}`);
    }

    this.logger.log(`Running ETL job: ${id} for user: ${context.userId}`);

    const jobId = await this.etlCollectionService.enqueueDataCollection(job);

    return {
      message: jobId ? 'Job queued successfully' : 'Failed to queue job',
      jobId,
    };
  }

  @Get('transform-maps')
  async getTransformMaps(): Promise<{ transformMaps: EtlTransformMap[] }> {
    // In a real implementation, we would have a registry for transform maps
    // For now, return empty array as placeholder
    this.logger.log('Retrieved ETL transform maps');
    
    return { transformMaps: [] };
  }

  @Post('transform')
  async transformData(
    @Context() context: RequestContext,
    @Body() request: TransformDataRequest,
  ): Promise<{ transformedData: unknown }> {
    this.logger.log(`Transforming data for user: ${context.userId}`, {
      transformMapId: request.transformMapId,
    });

    const transformedData = await this.etlTransformService.transform(
      request.sourceData,
      request.transformMapId,
    );

    this.logger.log(`Successfully transformed data using map: ${request.transformMapId}`);

    return { transformedData };
  }

  @Get('status')
  async getStatus(@Context() context: RequestContext): Promise<{
    totalEndpoints: number;
    totalJobs: number;
    activeJobs: number;
    lastCollectionTime?: Date;
  }> {
    const totalEndpoints = ApiEndpointRegistry.getAllEndpoints().length;
    
    // In a real implementation, we would get actual job statistics
    const stats = {
      totalEndpoints,
      totalJobs: 0,
      activeJobs: 0,
    };

    this.logger.log(`Retrieved ETL status for user: ${context.userId}`, stats);

    return stats;
  }
}