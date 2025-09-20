import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/services/LoggerService';

import { ApiLogPostProcessorService } from './ApiLogPostProcessorService';

export interface ApiLogCreatedEvent {
  apiLogId: string;
  userId: string;
  connectionId: string;
  timestamp: Date;
}

@Injectable()
export class ApiLogEventListenerService implements OnModuleInit {
  private readonly logger = new LoggerService(ApiLogEventListenerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly postProcessorService: ApiLogPostProcessorService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing API log event listener service');

    // Listen for API log creation events
    this.eventEmitter.on('api-log.created', this.handleApiLogCreated.bind(this));

    this.logger.log('API log event listener service initialized');
  }

  /**
   * Handles the API log created event
   */
  private async handleApiLogCreated(event: ApiLogCreatedEvent) {
    this.logger.log('Received API log created event', {
      apiLogId: event.apiLogId,
      userId: event.userId,
      connectionId: event.connectionId,
      timestamp: event.timestamp,
    });

    try {
      // Process the API log asynchronously
      const result = await this.postProcessorService.processApiLog(event.apiLogId);

      this.logger.log('API log post-processing completed', {
        apiLogId: event.apiLogId,
        success: result.success,
        eventsCreated: result.details.eventsCreated,
        hasMorePages: result.details.hasMorePages,
        nextPageToken: result.details.nextPageToken,
        errorCount: result.details.errors.length,
      });

      // If there are more pages and a nextPageToken, trigger the next sync
      // Limit to 10 pages to prevent infinite loops
      if (result.details.hasMorePages && result.details.nextPageToken) {
        const pageCount = await this.getPaginationCount(event.connectionId, event.userId);

        if (pageCount < 10) {
          this.logger.log('Triggering next page sync', {
            connectionId: event.connectionId,
            userId: event.userId,
            nextPageToken: result.details.nextPageToken,
            currentPageCount: pageCount,
            maxPages: 10,
          });

          await this.triggerNextPageSync(event.connectionId, event.userId, result.details.nextPageToken);
        } else {
          this.logger.log('Reached maximum pagination limit, stopping', {
            connectionId: event.connectionId,
            userId: event.userId,
            pageCount,
            maxPages: 10,
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during post-processing';

      this.logger.error('Failed to process API log', {
        apiLogId: event.apiLogId,
        userId: event.userId,
        connectionId: event.connectionId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Triggers the next page sync with the nextPageToken
   */
  private async triggerNextPageSync(
    connectionId: string,
    userId: string,
    nextPageToken: string,
  ): Promise<void> {
    try {
      this.logger.log('Triggering next page sync', {
        connectionId,
        userId,
        nextPageToken,
      });

      // Emit an event to trigger the next page sync
      this.eventEmitter.emit('sync.next-page', {
        connectionId,
        userId,
        nextPageToken,
        timestamp: new Date(),
      });

      this.logger.log('Next page sync event emitted', {
        connectionId,
        userId,
        nextPageToken,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error triggering next page sync';

      this.logger.error('Failed to trigger next page sync', {
        connectionId,
        userId,
        nextPageToken,
        error: errorMessage,
      });
    }
  }

  /**
   * Manually trigger post-processing for a specific API log
   * Useful for testing or manual reprocessing
   */
  async triggerPostProcessing(apiLogId: string): Promise<void> {
    this.logger.log('Manually triggering post-processing', { apiLogId });

    try {
      const result = await this.postProcessorService.processApiLog(apiLogId);

      this.logger.log('Manual post-processing completed', {
        apiLogId,
        success: result.success,
        eventsCreated: result.details.eventsCreated,
        hasMorePages: result.details.hasMorePages,
        nextPageToken: result.details.nextPageToken,
        errorCount: result.details.errors.length,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during manual post-processing';

      this.logger.error('Failed to manually process API log', {
        apiLogId,
        error: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Gets the count of API logs for a connection to track pagination
   */
  private async getPaginationCount(connectionId: string, userId: string): Promise<number> {
    try {
      const result = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM api_logs 
         WHERE connection_id = $1 AND user_id = $2 
         AND created_at > NOW() - INTERVAL '1 hour'`,
        [connectionId, userId],
      );

      return parseInt(result[0]?.count || '0', 10);
    } catch (error) {
      this.logger.error('Failed to get pagination count', {
        connectionId,
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return 0;
    }
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.dataSource.query('SELECT 1');

      return { healthy: true, message: 'API log event listener service is healthy' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error('Event listener health check failed', { error: errorMessage });

      return { healthy: false, message: `Event listener service failed: ${errorMessage}` };
    }
  }
}
