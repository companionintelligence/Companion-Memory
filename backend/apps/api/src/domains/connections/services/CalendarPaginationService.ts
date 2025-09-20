import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DataIngestionService } from '@ci/common/services/DataIngestionService';
import { LoggerService } from '@ci/common/services/LoggerService';
import type { RequestContext } from '@ci/common/types';

import { ConnectionService } from './ConnectionService';

export interface NextPageSyncEvent {
  connectionId: string;
  userId: string;
  nextPageToken: string;
  timestamp: Date;
}

@Injectable()
export class CalendarPaginationService implements OnModuleInit {
  private readonly logger = new LoggerService(CalendarPaginationService.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly dataIngestionService: DataIngestionService,
    private readonly connectionService: ConnectionService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing calendar pagination service');

    // Listen for next page sync events
    this.eventEmitter.on('sync.next-page', this.handleNextPageSync.bind(this));

    this.logger.log('Calendar pagination service initialized');
  }

  /**
   * Handles the next page sync event
   */
  private async handleNextPageSync(event: NextPageSyncEvent) {
    this.logger.log('Received next page sync event', {
      connectionId: event.connectionId,
      userId: event.userId,
      nextPageToken: event.nextPageToken,
      timestamp: event.timestamp,
    });

    try {
      // Create a request context for the sync
      const context: RequestContext = {
        userId: event.userId,
        requestId: `next-page-${Date.now()}`,
      };

      this.logger.log('Triggering next page sync with ConnectionService', {
        connectionId: event.connectionId,
        userId: event.userId,
        nextPageToken: event.nextPageToken,
        requestId: context.requestId,
      });

      // Call ConnectionService directly to sync with the pagination token
      const syncResponse = await this.connectionService.syncWithToken(
        context,
        event.connectionId,
        event.nextPageToken,
      );

      this.logger.log('Next page sync completed', {
        connectionId: event.connectionId,
        userId: event.userId,
        nextPageToken: event.nextPageToken,
        requestId: context.requestId,
        syncSuccess: syncResponse.success,
        resultCount: syncResponse.data?.results?.length || 0,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during next page sync';

      this.logger.error('Failed to handle next page sync', {
        connectionId: event.connectionId,
        userId: event.userId,
        nextPageToken: event.nextPageToken,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Manually trigger a next page sync
   * Useful for testing or manual pagination
   */
  async triggerManualNextPageSync(
    connectionId: string,
    userId: string,
    nextPageToken: string,
  ): Promise<void> {
    this.logger.log('Manually triggering next page sync', {
      connectionId,
      userId,
      nextPageToken,
    });

    const context: RequestContext = {
      userId,
      requestId: `manual-next-page-${Date.now()}`,
    };

    await this.connectionService.syncWithToken(context, connectionId, nextPageToken);
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      return { healthy: true, message: 'Calendar pagination service is healthy' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Pagination service health check failed', { error: errorMessage });

      return { healthy: false, message: `Pagination service failed: ${errorMessage}` };
    }
  }
}
