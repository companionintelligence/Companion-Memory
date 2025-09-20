import { Body, Controller, Get, Param, Post, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService, DataIngestionService } from '@ci/common/services';
import type { SyncDataIngestionRequest } from '@ci/common/services/DataIngestionService';
import type { RequestContext } from '@ci/common/types';

import type { SyncResponse } from '../clients/types';
import { ApiLogEventListenerService } from '../services/ApiLogEventListenerService';
import { ApiLogPostProcessorService } from '../services/ApiLogPostProcessorService';
import { CalendarPaginationService } from '../services/CalendarPaginationService';

// Validation schema for the ingestion request
const syncDataIngestionSchema = z.object({
  connectionId: z.string().uuid('Invalid connection ID'),
  syncResponse: z.object({
    success: z.boolean(),
    message: z.string(),
    data: z
      .object({
        results: z.array(
          z.object({
            api: z.string(),
            data: z.unknown(),
            error: z.string().optional(),
          }),
        ),
        errors: z.array(z.string()),
      })
      .optional(),
  }),
});

type SyncDataIngestionDto = {
  connectionId: string;
  syncResponse: SyncResponse;
};

const getApiLogsQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 50)),
});

@Controller('data-ingestion')
export class DataIngestionController {
  private readonly logger = new LoggerService(DataIngestionController.name);

  constructor(
    private readonly dataIngestionService: DataIngestionService,
    private readonly postProcessorService: ApiLogPostProcessorService,
    private readonly eventListenerService: ApiLogEventListenerService,
    private readonly paginationService: CalendarPaginationService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async ingestSyncData(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(syncDataIngestionSchema)) body: SyncDataIngestionDto,
  ) {
    this.logger.log('Received sync data ingestion request', {
      connectionId: body.connectionId,
      userId: context.userId,
      requestId: context.requestId,
      syncSuccess: body.syncResponse.success,
      resultCount: body.syncResponse.data?.results?.length || 0,
    });

    try {
      const request: SyncDataIngestionRequest = {
        connectionId: body.connectionId,
        userId: context.userId!,
        syncResponse: body.syncResponse,
        requestContext: context,
      };

      const result = await this.dataIngestionService.ingestSyncData(request);

      this.logger.log('Sync data ingestion completed', {
        connectionId: body.connectionId,
        userId: context.userId,
        requestId: context.requestId,
        success: result.success,
        apiLogsCreated: result.details.apiLogsCreated,
        errorCount: result.details.errors.length,
      });

      return {
        success: result.success,
        message: result.message,
        details: result.details,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during data ingestion';

      this.logger.error('Critical error in sync data ingestion endpoint', {
        connectionId: body.connectionId,
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      return {
        success: false,
        message: `Critical error during data ingestion: ${errorMessage}`,
        details: {
          apiLogsCreated: 0,
          errors: [
            {
              type: 'validation' as const,
              message: errorMessage,
              data: { connectionId: body.connectionId, userId: context.userId },
            },
          ],
          createdApiLogs: [],
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('connections/:connectionId/api-logs')
  async getApiLogsForConnection(
    @Context() context: RequestContext,
    @Param('connectionId') connectionId: string,
    @Query(new ValidationPipe(getApiLogsQuerySchema)) query: { limit: number },
  ) {
    this.logger.log('Retrieving API logs for connection', {
      connectionId,
      userId: context.userId,
      requestId: context.requestId,
      limit: query.limit,
    });

    try {
      const apiLogs = await this.dataIngestionService.getApiLogsForConnection(
        connectionId,
        context.userId!,
        query.limit,
      );

      this.logger.log('Successfully retrieved API logs', {
        connectionId,
        userId: context.userId,
        requestId: context.requestId,
        count: apiLogs.length,
      });

      return {
        success: true,
        data: apiLogs,
        count: apiLogs.length,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error retrieving API logs';

      this.logger.error('Failed to retrieve API logs', {
        connectionId,
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        success: false,
        message: `Failed to retrieve API logs: ${errorMessage}`,
        data: [],
        count: 0,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testIngestion(@Context() context: RequestContext) {
    this.logger.log('Testing data ingestion service', {
      userId: context.userId,
      requestId: context.requestId,
    });

    try {
      const testRequest: SyncDataIngestionRequest = {
        connectionId: 'test-connection-id',
        userId: context.userId!,
        syncResponse: {
          success: true,
          message: 'Test sync response',
          data: {
            results: [
              {
                api: 'Test API',
                data: { test: 'data' },
              },
            ],
            errors: [],
          },
        },
        requestContext: context,
      };

      const result = await this.dataIngestionService.ingestSyncData(testRequest);

      this.logger.log('Test ingestion completed', {
        userId: context.userId,
        requestId: context.requestId,
        success: result.success,
        apiLogsCreated: result.details.apiLogsCreated,
      });

      return {
        success: result.success,
        message: result.message,
        details: result.details,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during test ingestion';

      this.logger.error('Test ingestion failed', {
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        success: false,
        message: `Test ingestion failed: ${errorMessage}`,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('process/:apiLogId')
  @HttpCode(HttpStatus.OK)
  async processApiLog(@Context() context: RequestContext, @Param('apiLogId') apiLogId: string) {
    this.logger.log('Manually triggering API log post-processing', {
      apiLogId,
      userId: context.userId,
      requestId: context.requestId,
    });

    try {
      const result = await this.postProcessorService.processApiLog(apiLogId);

      this.logger.log('Manual post-processing completed', {
        apiLogId,
        userId: context.userId,
        requestId: context.requestId,
        success: result.success,
        eventsCreated: result.details.eventsCreated,
        hasMorePages: result.details.hasMorePages,
        nextPageToken: result.details.nextPageToken,
        errorCount: result.details.errors.length,
      });

      return {
        success: result.success,
        message: result.message,
        details: result.details,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during post-processing';

      this.logger.error('Manual post-processing failed', {
        apiLogId,
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        success: false,
        message: `Post-processing failed: ${errorMessage}`,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('debug/latest-api-logs')
  @HttpCode(HttpStatus.OK)
  async getLatestApiLogs(@Context() context: RequestContext) {
    this.logger.log('Getting latest API logs for debugging', {
      userId: context.userId,
      requestId: context.requestId,
    });

    try {
      // Get the latest API logs for this user
      const apiLogs = await this.dataIngestionService.getLatestApiLogs(context.userId!, 5);

      return {
        success: true,
        message: 'Latest API logs retrieved',
        data: {
          apiLogs: apiLogs.map((log) => ({
            id: log.id,
            content: JSON.parse(log.content),
            created_at: log.created_at,
            hasUser: !!log.user,
            hasConnection: !!log.connection,
            connectionId: log.connection?.id,
          })),
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error retrieving API logs';

      this.logger.error('Failed to get latest API logs', {
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        success: false,
        message: `Failed to get latest API logs: ${errorMessage}`,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('debug/pagination-status/:connectionId')
  @HttpCode(HttpStatus.OK)
  async getPaginationStatus(@Context() context: RequestContext, @Param('connectionId') connectionId: string) {
    this.logger.log('Getting pagination status', {
      connectionId,
      userId: context.userId,
      requestId: context.requestId,
    });

    try {
      // Get recent API logs for this connection
      const apiLogs = await this.dataIngestionService.getLatestApiLogs(context.userId!, 20);
      const connectionLogs = apiLogs.filter((log) => log.connection?.id === connectionId);

      // Get event count for this connection
      const eventCount = await this.dataIngestionService.getEventCountForConnection(
        connectionId,
        context.userId!,
      );

      return {
        success: true,
        message: 'Pagination status retrieved',
        data: {
          connectionId,
          apiLogCount: connectionLogs.length,
          eventCount,
          recentApiLogs: connectionLogs.slice(0, 5).map((log) => ({
            id: log.id,
            created_at: log.created_at,
            hasNextPageToken: this.extractNextPageTokenFromLog(log),
          })),
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error getting pagination status';

      this.logger.error('Failed to get pagination status', {
        connectionId,
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        success: false,
        message: `Failed to get pagination status: ${errorMessage}`,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('test-pagination')
  @HttpCode(HttpStatus.OK)
  async testPagination(
    @Context() context: RequestContext,
    @Body() body: { connectionId: string; nextPageToken: string },
  ) {
    this.logger.log('Testing pagination manually', {
      connectionId: body.connectionId,
      nextPageToken: body.nextPageToken,
      userId: context.userId,
      requestId: context.requestId,
    });

    try {
      await this.paginationService.triggerManualNextPageSync(
        body.connectionId,
        context.userId!,
        body.nextPageToken,
      );

      return {
        success: true,
        message: 'Pagination test completed',
        data: {
          connectionId: body.connectionId,
          nextPageToken: body.nextPageToken,
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during pagination test';

      this.logger.error('Pagination test failed', {
        connectionId: body.connectionId,
        nextPageToken: body.nextPageToken,
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        success: false,
        message: `Pagination test failed: ${errorMessage}`,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Helper method to extract nextPageToken from API log content
   */
  private extractNextPageTokenFromLog(apiLog: { content: string }): string | null {
    try {
      const content = JSON.parse(apiLog.content);
      const syncResponse = content.syncResponse;

      if (syncResponse?.data?.results) {
        for (const result of syncResponse.data.results) {
          if (result.api === 'Google Calendar' && result.data?.nextPageToken) {
            return result.data.nextPageToken;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('health-check')
  @HttpCode(HttpStatus.OK)
  async healthCheck(@Context() context: RequestContext) {
    this.logger.log('Health check requested', {
      userId: context.userId,
      requestId: context.requestId,
    });

    try {
      const healthResult = await this.dataIngestionService.healthCheck();

      this.logger.log('Health check completed', {
        userId: context.userId,
        requestId: context.requestId,
        healthy: healthResult.healthy,
      });

      return {
        ...healthResult,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during health check';

      this.logger.error('Health check failed', {
        userId: context.userId,
        requestId: context.requestId,
        error: errorMessage,
      });

      return {
        healthy: false,
        message: `Health check failed: ${errorMessage}`,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
