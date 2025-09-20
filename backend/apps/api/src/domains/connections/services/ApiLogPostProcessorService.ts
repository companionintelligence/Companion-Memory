import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services/LoggerService';

import type { SyncResponse } from '../clients/types';
import { ApiLogEntity } from '../entities/ApiLogEntity';
import type { ApiLog } from '../types';

export interface CalendarEventData {
  id: string;
  name: string;
  type?: string;
  description?: string;
  start_time?: Date;
  end_time?: Date;
  external_id?: string;
  source_url?: string;
  source_data?: unknown;
  user_id: string;
  connection_id: string;
}

export interface CalendarPaginationData {
  nextPageToken?: string;
  hasMorePages: boolean;
  totalEvents: number;
}

export interface PostProcessingResult {
  success: boolean;
  message: string;
  details: {
    eventsCreated: number;
    totalEvents: number;
    nextPageToken?: string;
    hasMorePages: boolean;
    errors: Array<{
      type: 'calendar_processing' | 'event_creation' | 'pagination' | 'validation';
      message: string;
      data?: unknown;
    }>;
  };
}

@Injectable()
export class ApiLogPostProcessorService {
  private readonly logger = new LoggerService(ApiLogPostProcessorService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
  ) {}

  /**
   * Main entry point for processing a new API log entry
   * Extracts calendar data and creates events, handles pagination
   */
  async processApiLog(apiLogId: string): Promise<PostProcessingResult> {
    this.logger.log('Starting API log post-processing', {
      apiLogId,
    });

    const result: PostProcessingResult = {
      success: true,
      message: 'Post-processing completed',
      details: {
        eventsCreated: 0,
        hasMorePages: false,
        totalEvents: 0,
        errors: [],
      },
    };

    try {
      // Step 1: Retrieve the API log entry
      const apiLog = await this.getApiLogById(apiLogId);
      if (!apiLog) {
        throw new Error(`API log with ID ${apiLogId} not found`);
      }

      // Step 2: Parse the content to extract sync response
      const syncResponse = this.parseApiLogContent(apiLog.content);
      if (!syncResponse) {
        this.logger.log('No sync response found in API log content', { apiLogId });

        return result;
      }

      // Step 3: Process calendar data if present
      if (syncResponse.data?.results) {
        if (!apiLog.user?.id || !apiLog.connection?.id) {
          this.logger.error('Missing user or connection ID in API log', {
            apiLogId,
            hasUserId: !!apiLog.user?.id,
            hasConnectionId: !!apiLog.connection?.id,
          });
          result.details.errors.push({
            type: 'validation',
            message: 'Missing user or connection ID in API log',
            data: { apiLogId },
          });

          return result;
        }

        const calendarResult = await this.processCalendarData(
          apiLogId,
          apiLog.user.id,
          apiLog.connection.id,
          syncResponse.data.results,
        );

        result.details.eventsCreated = calendarResult.eventsCreated;
        result.details.nextPageToken = calendarResult.nextPageToken;
        result.details.hasMorePages = calendarResult.hasMorePages;
        result.details.totalEvents = calendarResult.totalEvents;
        result.details.errors.push(...calendarResult.errors);
      }

      // Step 4: Determine overall success
      result.success = result.details.errors.length === 0;
      result.message = result.success
        ? `Post-processing completed: ${result.details.eventsCreated} events created`
        : `Post-processing completed with ${result.details.errors.length} errors`;

      this.logger.log('API log post-processing completed', {
        apiLogId,
        success: result.success,
        eventsCreated: result.details.eventsCreated,
        hasMorePages: result.details.hasMorePages,
        nextPageToken: result.details.nextPageToken,
        errorCount: result.details.errors.length,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during post-processing';

      this.logger.error('Critical error during API log post-processing', {
        apiLogId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      result.success = false;
      result.message = `Critical error during post-processing: ${errorMessage}`;
      result.details.errors.push({
        type: 'calendar_processing',
        message: errorMessage,
        data: { apiLogId },
      });

      return result;
    }
  }

  /**
   * Retrieves an API log by ID with relations
   */
  private async getApiLogById(apiLogId: string): Promise<ApiLog | null> {
    try {
      const entity = await this.apiLogRepository.findOne({
        where: { id: apiLogId },
        relations: ['user', 'connection'],
      });

      return entity ? entity.toApiLog() : null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error retrieving API log';
      this.logger.error('Failed to retrieve API log', {
        apiLogId,
        error: errorMessage,
      });
      throw new Error(`Failed to retrieve API log: ${errorMessage}`);
    }
  }

  /**
   * Parses the API log content to extract the sync response
   */
  private parseApiLogContent(content: string): SyncResponse | null {
    try {
      const parsed = JSON.parse(content);

      return parsed.syncResponse || null;
    } catch (error) {
      this.logger.error('Failed to parse API log content', {
        error: error instanceof Error ? error.message : 'Unknown parsing error',
        content: content.substring(0, 200) + '...', // Log first 200 chars for debugging
      });

      return null;
    }
  }

  /**
   * Processes calendar data from API results
   */
  private async processCalendarData(
    apiLogId: string,
    userId: string,
    connectionId: string,
    results: Array<{ api: string; data: unknown; error?: string }>,
  ): Promise<{
    eventsCreated: number;
    nextPageToken?: string;
    hasMorePages: boolean;
    totalEvents: number;
    errors: Array<{
      type: 'calendar_processing' | 'event_creation' | 'pagination' | 'validation';
      message: string;
      data?: unknown;
    }>;
  }> {
    const result = {
      eventsCreated: 0,
      nextPageToken: undefined as string | undefined,
      hasMorePages: false,
      totalEvents: 0,
      errors: [] as Array<{
        type: 'calendar_processing' | 'event_creation' | 'pagination' | 'validation';
        message: string;
        data?: unknown;
      }>,
    };

    for (const apiResult of results) {
      if (this.isCalendarApi(apiResult.api)) {
        try {
          this.logger.log('Processing calendar data from API result', {
            apiLogId,
            userId,
            connectionId,
            api: apiResult.api,
            hasData: !!apiResult.data,
          });

          const calendarResult = await this.processSingleCalendarApi(apiResult, userId, connectionId);

          result.eventsCreated += calendarResult.eventsCreated;
          result.totalEvents += calendarResult.totalEvents;

          // Handle pagination - use the most recent nextPageToken
          if (calendarResult.nextPageToken) {
            result.nextPageToken = calendarResult.nextPageToken;
            result.hasMorePages = true;

            this.logger.log('Found nextPageToken for pagination', {
              apiLogId,
              userId,
              connectionId,
              api: apiResult.api,
              nextPageToken: calendarResult.nextPageToken,
              eventsCreated: calendarResult.eventsCreated,
            });
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error processing calendar data';

          this.logger.error('Failed to process calendar data', {
            apiLogId,
            userId,
            connectionId,
            api: apiResult.api,
            error: errorMessage,
          });

          result.errors.push({
            type: 'calendar_processing',
            message: `Failed to process ${apiResult.api}: ${errorMessage}`,
            data: { api: apiResult.api, connectionId, userId },
          });
        }
      }
    }

    return result;
  }

  /**
   * Processes a single calendar API result
   */
  private async processSingleCalendarApi(
    apiResult: { api: string; data: unknown; error?: string },
    userId: string,
    connectionId: string,
  ): Promise<{
    eventsCreated: number;
    nextPageToken?: string;
    totalEvents: number;
  }> {
    const result = {
      eventsCreated: 0,
      nextPageToken: undefined as string | undefined,
      totalEvents: 0,
    };

    // Import the calendar parser dynamically to avoid circular dependencies
    const { parseCalendarDataToEvents } = await import('../utils/calendarParser');

    // Parse calendar data to events
    const events = parseCalendarDataToEvents(apiResult.data, connectionId, userId);
    result.totalEvents = events.length;

    this.logger.log('Parsed calendar events', {
      api: apiResult.api,
      connectionId,
      userId,
      eventCount: events.length,
      sampleEvent: events[0]
        ? {
            id: events[0].id,
            name: events[0].name,
          }
        : null,
    });

    // Save events to database
    if (events.length > 0) {
      await this.saveEventsToDatabase(events);
      result.eventsCreated = events.length;
    }

    // Extract nextPageToken from the API data
    result.nextPageToken = this.extractNextPageToken(apiResult.data);

    return result;
  }

  /**
   * Extracts nextPageToken from calendar API data
   */
  private extractNextPageToken(data: unknown): string | undefined {
    try {
      if (typeof data === 'object' && data !== null) {
        const dataObj = data as Record<string, unknown>;

        // Google Calendar format
        if (dataObj.nextPageToken && typeof dataObj.nextPageToken === 'string') {
          this.logger.log('Extracted Google Calendar nextPageToken', {
            nextPageToken: dataObj.nextPageToken,
            hasItems: !!dataObj.items,
            itemCount: Array.isArray(dataObj.items) ? dataObj.items.length : 0,
          });

          return dataObj.nextPageToken;
        }

        // Microsoft Calendar format
        if (dataObj['@odata.nextLink'] && typeof dataObj['@odata.nextLink'] === 'string') {
          // Extract token from the nextLink URL
          const nextLink = dataObj['@odata.nextLink'];
          const tokenMatch = nextLink.match(/[?&]skiptoken=([^&]+)/);
          if (tokenMatch) {
            this.logger.log('Extracted Microsoft Calendar nextPageToken', {
              nextPageToken: tokenMatch[1],
              nextLink,
              hasValue: !!dataObj.value,
              valueCount: Array.isArray(dataObj.value) ? dataObj.value.length : 0,
            });

            return tokenMatch[1];
          }
        }

        this.logger.log('No nextPageToken found in calendar data', {
          hasNextPageToken: !!dataObj.nextPageToken,
          hasODataNextLink: !!dataObj['@odata.nextLink'],
          dataKeys: Object.keys(dataObj),
        });
      }
    } catch (error) {
      this.logger.warn('Failed to extract nextPageToken', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return undefined;
  }

  /**
   * Saves events to the database with deduplication
   */
  private async saveEventsToDatabase(events: CalendarEventData[]): Promise<void> {
    for (const event of events) {
      try {
        // Check if event already exists to prevent duplicates
        const existingEvent = await this.dataSource.query(
          `SELECT id FROM events WHERE external_id = $1 AND connection_id = $2`,
          [event.external_id, event.connection_id],
        );

        if (existingEvent.length > 0) {
          this.logger.log('Event already exists, skipping duplicate', {
            eventId: event.id,
            eventName: event.name,
            connectionId: event.connection_id,
            userId: event.user_id,
            externalId: event.external_id,
            existingEventId: existingEvent[0].id,
          });
          continue;
        }

        this.logger.log('Saving new event to database', {
          eventId: event.id,
          eventName: event.name,
          connectionId: event.connection_id,
          userId: event.user_id,
          externalId: event.external_id,
        });

        await this.dataSource.query(
          `INSERT INTO events (
            id, name, type, description, start_time, end_time, 
            external_id, source_url, source_data, user_id, connection_id, 
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
          [
            event.id,
            event.name,
            event.type,
            event.description,
            event.start_time,
            event.end_time,
            event.external_id,
            event.source_url,
            JSON.stringify(event.source_data),
            event.user_id,
            event.connection_id,
          ],
        );

        this.logger.log('Successfully saved new event to database', {
          eventId: event.id,
          eventName: event.name,
          connectionId: event.connection_id,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error saving event';

        this.logger.error('Failed to save event to database', {
          eventId: event.id,
          eventName: event.name,
          connectionId: event.connection_id,
          error: errorMessage,
        });

        throw new Error(`Failed to save event ${event.name} (${event.id}): ${errorMessage}`);
      }
    }
  }

  /**
   * Determines if an API is a calendar API
   */
  private isCalendarApi(apiName: string): boolean {
    return apiName.toLowerCase().includes('calendar');
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.dataSource.query('SELECT 1');

      return { healthy: true, message: 'Post-processor service is healthy' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error('Post-processor health check failed', { error: errorMessage });

      return { healthy: false, message: `Post-processor service failed: ${errorMessage}` };
    }
  }
}
