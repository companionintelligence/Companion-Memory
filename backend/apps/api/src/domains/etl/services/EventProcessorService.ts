import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import { EventService } from '@ci/domains/events';
import { EventEntity } from '@ci/domains/memory/entities/EventEntity';

import { ApiLogEntity } from '../entities/ApiLogEntity';
import { ApiLogService } from './ApiLogService';
import { parseApiLogData, ParsedEvent } from '../utils/parser';
import type { ApiLog } from '../types';

@Injectable()
export class EventProcessorService {
  private logger = new LoggerService(EventProcessorService.name);

  constructor(
    private readonly apiLogService: ApiLogService,
    private readonly eventService: EventService,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
  ) {}

  /**
   * Process API logs for a specific connection and create structured events
   */
  async processConnectionLogs(connectionId: string): Promise<void> {
    this.logger.log('Processing API logs for connection', { connectionId });

    try {
      // Get all unprocessed API logs for this connection
      const apiLogEntities = await this.apiLogRepository.find({
        where: {
          connection_id: connectionId,
          processed: false,
        },
        order: { created_at: 'ASC' },
      });

      const apiLogs = apiLogEntities.map(entity => entity.toApiLog());
      
      let processedCount = 0;
      let errorCount = 0;

      for (const apiLog of apiLogs) {
        try {
          await this.processApiLog(apiLog);
          processedCount++;
        } catch (error) {
          errorCount++;
          this.logger.error('Failed to process API log', {
            apiLogId: apiLog.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Finished processing API logs', {
        connectionId,
        totalLogs: apiLogs.length,
        processedCount,
        errorCount,
      });
    } catch (error) {
      this.logger.error('Error processing connection logs', {
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Process a single API log and create structured events
   */
  async processApiLog(apiLog: ApiLog): Promise<void> {
    if (!apiLog.content || !apiLog.user_id) {
      this.logger.warn('Skipping API log without content or user_id', {
        apiLogId: apiLog.id,
      });
      return;
    }

    try {
      // Parse the API log data
      const parsedEvents = parseApiLogData(
        apiLog.content,
        apiLog.scope,
        apiLog.connection_id || '',
        apiLog.user_id,
      );

      this.logger.log('Parsed events from API log', {
        apiLogId: apiLog.id,
        eventCount: parsedEvents.length,
        scope: apiLog.scope,
      });

      // Create events for each parsed item
      for (const parsedEvent of parsedEvents) {
        await this.createEventFromParsed(parsedEvent, apiLog);
      }

      // Mark the API log as processed
      await this.apiLogRepository.update(apiLog.id, { processed: true });
      this.logger.log('Marked API log as processed', { apiLogId: apiLog.id });
    } catch (error) {
      this.logger.error('Failed to process API log', {
        apiLogId: apiLog.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Create an event entity from parsed data
   */
  private async createEventFromParsed(parsedEvent: ParsedEvent, apiLog: ApiLog): Promise<void> {
    try {
      // Check if event already exists by external_id and connection_id
      const existingEvent = await this.eventRepository.findOne({
        where: {
          external_id: parsedEvent.external_id,
          connection_id: parsedEvent.connection_id,
        },
      });

      if (existingEvent) {
        this.logger.debug('Event already exists, skipping', {
          externalId: parsedEvent.external_id,
          connectionId: parsedEvent.connection_id,
        });
        return;
      }

      // Create the event based on type
      if (parsedEvent.type === 'calendar_event') {
        await this.eventService.create({
          name: parsedEvent.name,
          type: 'calendar_event',
          description: parsedEvent.description,
          start_time: parsedEvent.start_time,
          end_time: parsedEvent.end_time,
          external_id: parsedEvent.external_id,
          source_url: parsedEvent.source_url,
          source_data: {
            ...parsedEvent.source_data as Record<string, unknown>,
            attendees: parsedEvent.attendees,
            api_log_id: apiLog.id,
          },
          user_id: parsedEvent.user_id,
          connection_id: parsedEvent.connection_id,
        });
      } else if (parsedEvent.type === 'email') {
        await this.eventService.create({
          name: parsedEvent.name,
          type: 'email',
          description: parsedEvent.description,
          start_time: parsedEvent.received_at,
          external_id: parsedEvent.external_id,
          source_url: parsedEvent.source_url,
          source_data: {
            ...parsedEvent.source_data as Record<string, unknown>,
            from: parsedEvent.from,
            to: parsedEvent.to,
            sent_at: parsedEvent.sent_at,
            api_log_id: apiLog.id,
          },
          user_id: parsedEvent.user_id,
          connection_id: parsedEvent.connection_id,
        });
      }

      this.logger.log('Created event from parsed data', {
        eventType: parsedEvent.type,
        externalId: parsedEvent.external_id,
        name: parsedEvent.name,
      });
    } catch (error) {
      this.logger.error('Failed to create event from parsed data', {
        parsedEvent,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Process all unprocessed API logs for a user
   */
  async processUserLogs(userId: string): Promise<void> {
    this.logger.log('Processing API logs for user', { userId });

    try {
      // Get all unprocessed API logs for this user
      const apiLogEntities = await this.apiLogRepository.find({
        where: {
          user_id: userId,
          processed: false,
        },
        order: { created_at: 'ASC' },
      });

      const apiLogs = apiLogEntities.map(entity => entity.toApiLog());
      
      let processedCount = 0;
      let errorCount = 0;

      for (const apiLog of apiLogs) {
        try {
          await this.processApiLog(apiLog);
          processedCount++;
        } catch (error) {
          errorCount++;
          this.logger.error('Failed to process API log', {
            apiLogId: apiLog.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Finished processing user API logs', {
        userId,
        totalLogs: apiLogs.length,
        processedCount,
        errorCount,
      });
    } catch (error) {
      this.logger.error('Error processing user logs', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}
