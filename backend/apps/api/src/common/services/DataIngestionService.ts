import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import type { SyncResponse } from '@ci/domains/connections/clients/types';
import { ApiLogEntity } from '@ci/domains/connections/entities/ApiLogEntity';
import type { ApiLog } from '@ci/domains/connections/types';

import type { RequestContext } from '../types';

import { LoggerService } from './LoggerService';

export interface SyncDataIngestionRequest {
  connectionId: string;
  userId: string;
  syncResponse: SyncResponse;
  requestContext: RequestContext;
}

export interface IngestionResult {
  success: boolean;
  message: string;
  details: {
    apiLogsCreated: number;
    errors: Array<{
      type: 'api_log' | 'validation';
      message: string;
      data?: unknown;
    }>;
    createdApiLogs: ApiLog[];
  };
}

@Injectable()
export class DataIngestionService {
  private readonly logger = new LoggerService(DataIngestionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Main entry point for ingesting sync data into PostgreSQL
   * Provides maximum visibility and error handling
   */
  async ingestSyncData(request: SyncDataIngestionRequest): Promise<IngestionResult> {
    const { connectionId, userId, syncResponse, requestContext } = request;

    this.logger.log('Starting data ingestion process', {
      connectionId,
      userId,
      requestId: requestContext.requestId,
      syncSuccess: syncResponse.success,
      resultCount: syncResponse.data?.results?.length || 0,
    });

    const result: IngestionResult = {
      success: true,
      message: 'Data ingestion completed',
      details: {
        apiLogsCreated: 0,
        errors: [],
        createdApiLogs: [],
      },
    };

    try {
      // Create a single API log entry for the entire sync response
      await this.createApiLogEntry(connectionId, userId, syncResponse, result);

      // Determine overall success
      result.success = result.details.errors.length === 0;
      result.message = result.success
        ? `Successfully ingested sync data: ${result.details.apiLogsCreated} API log created`
        : `Data ingestion completed with ${result.details.errors.length} errors`;

      this.logger.log('Data ingestion process completed', {
        connectionId,
        userId,
        requestId: requestContext.requestId,
        success: result.success,
        apiLogsCreated: result.details.apiLogsCreated,
        errorCount: result.details.errors.length,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during data ingestion';

      this.logger.error('Critical error during data ingestion', {
        connectionId,
        userId,
        requestId: requestContext.requestId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      result.success = false;
      result.message = `Critical error during data ingestion: ${errorMessage}`;
      result.details.errors.push({
        type: 'validation',
        message: errorMessage,
        data: { connectionId, userId },
      });

      return result;
    }
  }

  /**
   * Creates an API log entry for the entire sync response
   * Stores the complete sync response as a single entry in the api_logs table
   */
  private async createApiLogEntry(
    connectionId: string,
    userId: string,
    syncResponse: SyncDataIngestionRequest['syncResponse'],
    result: IngestionResult,
  ): Promise<void> {
    try {
      this.logger.log('Creating API log entry for entire sync response', {
        connectionId,
        userId,
        syncSuccess: syncResponse.success,
        resultCount: syncResponse.data?.results?.length || 0,
      });

      const apiLogId = uuid7();
      const content = JSON.stringify({
        syncResponse,
        timestamp: new Date().toISOString(),
        metadata: {
          ingestionService: 'DataIngestionService',
          version: '1.0.0',
          type: 'complete_sync_response',
        },
      });

      // Create the entity using TypeORM repository
      const apiLogEntity = this.apiLogRepository.create({
        id: apiLogId,
        content,
        user: { id: userId },
        connection: { id: connectionId },
      });

      // Save the entity
      this.logger.log('Saving API log entity to database', {
        apiLogId,
        connectionId,
        userId,
      });

      const savedEntity = await this.apiLogRepository.save(apiLogEntity);

      this.logger.log('Successfully saved API log entity to database', {
        apiLogId,
        connectionId,
        userId,
        savedEntityId: savedEntity.id,
      });

      // Transform to ApiLog object using the entity's toApiLog method
      const apiLogObject = savedEntity.toApiLog();

      result.details.apiLogsCreated++;
      result.details.createdApiLogs.push(apiLogObject);

      this.logger.log('Successfully created API log entry for entire sync response', {
        apiLogId,
        connectionId,
        userId,
        resultCount: syncResponse.data?.results?.length || 0,
        apiLogObject: {
          id: apiLogObject.id,
          content: apiLogObject.content,
          created_at: apiLogObject.created_at,
          hasUser: !!apiLogObject.user,
          hasConnection: !!apiLogObject.connection,
        },
      });

      // Emit event to trigger post-processing
      this.eventEmitter.emit('api-log.created', {
        apiLogId,
        userId,
        connectionId,
        timestamp: new Date(),
      });

      this.logger.log('Emitted API log created event for post-processing', {
        apiLogId,
        connectionId,
        userId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error creating API log';

      this.logger.error('Failed to create API log entry', {
        connectionId,
        userId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      result.details.errors.push({
        type: 'api_log',
        message: `Failed to create API log: ${errorMessage}`,
        data: { connectionId, userId },
      });
    }
  }

  /**
   * Retrieves API logs for a connection and transforms them to ApiLog objects
   */
  async getApiLogsForConnection(connectionId: string, userId: string, limit: number = 50): Promise<ApiLog[]> {
    try {
      this.logger.log('Retrieving API logs for connection', {
        connectionId,
        userId,
        limit,
      });

      const entities = await this.apiLogRepository.find({
        where: {
          connection: { id: connectionId },
          user: { id: userId },
        },
        relations: ['user', 'connection'],
        order: { created_at: 'DESC' },
        take: limit,
      });

      const apiLogs = entities.map((entity) => entity.toApiLog());

      this.logger.log('Successfully retrieved API logs', {
        connectionId,
        userId,
        count: apiLogs.length,
      });

      return apiLogs;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error retrieving API logs';

      this.logger.error('Failed to retrieve API logs', {
        connectionId,
        userId,
        error: errorMessage,
      });

      throw new Error(`Failed to retrieve API logs: ${errorMessage}`);
    }
  }

  /**
   * Transforms a raw database row to an ApiLog object
   * This is useful when working with raw SQL queries
   */
  transformToApiLogObject(rawData: {
    id: string;
    content: string;
    user_id: string;
    connection_id: string;
    created_at: Date;
    user?: {
      id: string;
      name: string;
      email: string;
    };
    connection?: {
      id: string;
      name: string;
      active: boolean;
      clientid: string;
      clientkey: string;
      clientsecret: string;
      schedule: string;
      accessToken: string;
      refreshToken: string;
      tokenExpiry: Date;
      provider?: {
        id: string;
        name: string | null;
        tokenHost: string | null;
        tokenPath: string | null;
        authorizePath: string | null;
        apiBaseUrl: string | null;
        scopes: string | null;
      };
    };
  }): ApiLog {
    return {
      id: rawData.id,
      content: rawData.content,
      user: rawData.user
        ? {
            id: rawData.user.id,
            name: rawData.user.name,
            email: rawData.user.email,
          }
        : undefined,
      connection: rawData.connection
        ? {
            id: rawData.connection.id,
            name: rawData.connection.name,
            active: rawData.connection.active,
            clientid: rawData.connection.clientid,
            clientkey: rawData.connection.clientkey,
            clientsecret: rawData.connection.clientsecret,
            schedule: rawData.connection.schedule,
            accessToken: rawData.connection.accessToken,
            refreshToken: rawData.connection.refreshToken,
            tokenExpiry: rawData.connection.tokenExpiry,
            provider: rawData.connection.provider,
          }
        : undefined,
      created_at: rawData.created_at,
    };
  }

  /**
   * Gets the latest API logs for a user (for debugging)
   */
  async getLatestApiLogs(userId: string, limit: number = 5): Promise<ApiLog[]> {
    try {
      const entities = await this.apiLogRepository.find({
        where: { user: { id: userId } },
        relations: ['user', 'connection'],
        order: { created_at: 'DESC' },
        take: limit,
      });

      return entities.map((entity) => entity.toApiLog());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error retrieving API logs';
      this.logger.error('Failed to get latest API logs', {
        userId,
        limit,
        error: errorMessage,
      });
      throw new Error(`Failed to get latest API logs: ${errorMessage}`);
    }
  }

  /**
   * Gets the count of events for a specific connection
   */
  async getEventCountForConnection(connectionId: string, userId: string): Promise<number> {
    try {
      const result = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM events 
         WHERE connection_id = $1 AND user_id = $2`,
        [connectionId, userId],
      );

      return parseInt(result[0]?.count || '0', 10);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error getting event count';
      this.logger.error('Failed to get event count for connection', {
        connectionId,
        userId,
        error: errorMessage,
      });
      throw new Error(`Failed to get event count: ${errorMessage}`);
    }
  }

  /**
   * Health check method to verify database connectivity
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.dataSource.query('SELECT 1');

      return { healthy: true, message: 'Database connection is healthy' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error('Database health check failed', { error: errorMessage });

      return { healthy: false, message: `Database connection failed: ${errorMessage}` };
    }
  }
}
