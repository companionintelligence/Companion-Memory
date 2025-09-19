import { DataSource } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { EventEntity } from '@ci/domains/memory';

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;
    date?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
  };
  htmlLink?: string;
  location?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
  }>;
}

interface GoogleCalendarResponse {
  items: GoogleCalendarEvent[];
}

interface SyncResponse {
  success: boolean;
  message: string;
  data?: {
    results: Array<{
      api: string;
      data: unknown;
    }>;
    errors: string[];
  };
}

export class GoogleDigester {
  private logger = new LoggerService('GoogleDigester');

  constructor(private dataSource: DataSource) {}

  /**
   * Process raw Google Calendar JSON data and create event entities
   */
  async digestGoogleCalendarData(
    rawData: unknown,
    userId: string,
    connectionId?: string,
  ): Promise<{ processed: number; errors: string[] }> {
    const errors: string[] = [];
    let processed = 0;

    try {
      // Handle the sync response wrapper structure
      let calendarData: GoogleCalendarResponse | undefined;
      
      if (this.isSyncResponse(rawData)) {
        // Extract calendar data from sync response
        const calendarResult = rawData.data?.results?.find(r => r.api === 'Google Calendar');
        if (calendarResult?.data) {
          calendarData = calendarResult.data as GoogleCalendarResponse;
        }
      } else if (this.isGoogleCalendarResponse(rawData)) {
        // Direct calendar response
        calendarData = rawData;
      }

      if (!calendarData?.items) {
        errors.push('No calendar items found in the data');
        return { processed, errors };
      }

      // Process each calendar event
      for (const event of calendarData.items) {
        try {
          await this.createEventFromGoogleCalendar(event, userId, connectionId);
          processed++;
        } catch (error) {
          const errorMsg = `Failed to process event ${event.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          this.logger.error(errorMsg);
        }
      }

      this.logger.log(`Processed ${processed} Google Calendar events`, { userId, connectionId });
    } catch (error) {
      const errorMsg = `Failed to digest Google Calendar data: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg);
    }

    return { processed, errors };
  }

  /**
   * Process all unprocessed Google Calendar data from api_logs
   */
  async processUndigestedLogs(): Promise<{ totalProcessed: number; totalErrors: number }> {
    let totalProcessed = 0;
    let totalErrors = 0;

    try {
      // Find api_logs with Google Calendar data that haven't been processed
      const unprocessedLogs = await this.dataSource.query(`
        SELECT 
          al.id,
          al.content,
          al.user_id,
          al.connection_id,
          c.provider_id
        FROM api_logs al
        JOIN connections c ON c.id = al.connection_id
        JOIN providers p ON p.id = c.provider_id
        WHERE p.name = 'Google'
          AND al.content::jsonb -> 'data' -> 'results' @> '[{"api": "Google Calendar"}]'
          AND NOT EXISTS (
            SELECT 1 FROM events e 
            WHERE e.source_data::jsonb ->> 'api_log_id' = al.id
          )
        ORDER BY al.created_at DESC
        LIMIT 100
      `);

      for (const log of unprocessedLogs) {
        try {
          const content = JSON.parse(log.content);
          const result = await this.digestGoogleCalendarData(
            content,
            log.user_id,
            log.connection_id,
          );
          
          totalProcessed += result.processed;
          totalErrors += result.errors.length;

          // Mark this log as processed by storing the api_log_id in the events
          if (result.processed > 0) {
            await this.dataSource.query(`
              UPDATE events 
              SET source_data = jsonb_set(
                COALESCE(source_data, '{}')::jsonb,
                '{api_log_id}',
                $1::jsonb
              )
              WHERE user_id = $2
                AND source_data::jsonb ->> 'provider' = 'google'
                AND created_at >= NOW() - INTERVAL '1 minute'
            `, [JSON.stringify(log.id), log.user_id]);
          }
        } catch (error) {
          totalErrors++;
          this.logger.error(`Failed to process log ${log.id}`, error);
        }
      }

      this.logger.log(`Batch processing complete: ${totalProcessed} events created, ${totalErrors} errors`);
    } catch (error) {
      this.logger.error('Failed to process undigested logs', error);
    }

    return { totalProcessed, totalErrors };
  }

  private async createEventFromGoogleCalendar(
    event: GoogleCalendarEvent,
    userId: string,
    connectionId?: string,
  ): Promise<void> {
    // Check if event already exists
    const existing = await this.dataSource.getRepository(EventEntity).findOne({
      where: {
        external_id: event.id,
        user: { id: userId },
      },
    });

    if (existing) {
      this.logger.debug(`Event ${event.id} already exists, skipping`);
      return;
    }

    const eventEntity = this.dataSource.getRepository(EventEntity).create({
      id: uuid7(),
      type: 'calendar_event',
      name: event.summary || 'Untitled Event',
      description: event.description || null,
      start_time: this.parseGoogleDate(event.start),
      end_time: this.parseGoogleDate(event.end),
      external_id: event.id,
      source_url: event.htmlLink || null,
      source_data: {
        provider: 'google',
        connection_id: connectionId,
        location: event.location,
        attendees: event.attendees?.map(a => ({
          email: a.email,
          name: a.displayName,
        })),
        raw: event,
      },
      user: { id: userId },
    });

    await this.dataSource.getRepository(EventEntity).save(eventEntity);
  }

  private parseGoogleDate(dateObj?: { dateTime?: string; date?: string }): Date | null {
    if (!dateObj) return null;
    
    const dateStr = dateObj.dateTime || dateObj.date;
    if (!dateStr) return null;
    
    try {
      return new Date(dateStr);
    } catch {
      return null;
    }
  }

  private isSyncResponse(data: unknown): data is SyncResponse {
    return (
      typeof data === 'object' &&
      data !== null &&
      'success' in data &&
      'message' in data
    );
  }

  private isGoogleCalendarResponse(data: unknown): data is GoogleCalendarResponse {
    return (
      typeof data === 'object' &&
      data !== null &&
      'items' in data &&
      Array.isArray((data as any).items)
    );
  }
}
