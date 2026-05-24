import { Injectable } from '@nestjs/common';
import { Point } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { EventService as MemoryEventService, type CreateEventDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

interface OutlookCalendarEvent {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    content?: string;
    contentType?: string;
  };
  start?: {
    dateTime?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    timeZone?: string;
  };
  location?: {
    displayName?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      countryOrRegion?: string;
      postalCode?: string;
    };
    coordinates?: {
      latitude?: number;
      longitude?: number;
    };
  };
  attendees?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
    type?: string;
    status?: {
      response?: string;
    };
  }>;
  organizer?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  recurrence?: unknown;
  seriesMasterId?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webLink?: string;
}

interface Participant {
  email: string;
  name: string;
  responseStatus: string;
  isOrganizer: boolean;
}

@Injectable()
export class OutlookCalendarTransformService {
  constructor(
    private readonly eventService: MemoryEventService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OutlookCalendarTransformService.name);
  }

  async transformOutlookCalendar({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Outlook Calendar transformation', {
        userId,
        syncJobId,
      });

      const events = this.extractCalendarEvents(data);

      if (events.length === 0) {
        this.logger.log('No Outlook Calendar events found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${events.length} Outlook Calendar events`, {
        userId,
        syncJobId,
        eventCount: events.length,
      });

      await Promise.all(
        events.map(
          async (event) =>
            await this.processCalendarEvent({
              event,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('Outlook Calendar transformation completed', {
        userId,
        syncJobId,
        processedCount: events.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Outlook Calendar events', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractCalendarEvents(data: unknown): OutlookCalendarEvent[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for Outlook Calendar events', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Microsoft Graph API
    if ('calendars' in dataObj && Array.isArray(dataObj.calendars)) {
      for (const calendar of dataObj.calendars) {
        return calendar.events as OutlookCalendarEvent[];
      }
    }

    this.logger.warn('No Outlook Calendar events found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processCalendarEvent({
    event,
    userId,
    connectionId,
  }: {
    event: OutlookCalendarEvent;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const eventId = event.id || 'unknown';
      const subject = event.subject || 'Untitled Event';

      // Skip cancelled events
      if (event.isCancelled) {
        this.logger.debug('Skipping cancelled event', {
          userId,
          connectionId,
          eventId,
          subject,
        });

        return;
      }

      this.logger.log('Processing Outlook Calendar event', {
        eventId,
        subject,
        attendeeCount: event.attendees?.length ?? 0,
      });

      // Extract participants
      const participants = this.extractParticipants(event);

      // Transform and save event
      const eventDto = await this.transformToEventDto(event, userId, connectionId);

      await this.eventService.create({ userId }, eventDto);

      // Process participants
      if (participants.length > 0) {
        await this.processParticipants(
          participants,
          userId,
          connectionId,
          event.start?.dateTime,
          event.end?.dateTime,
        );
      }

      this.logger.log('Outlook Calendar event saved successfully', {
        eventId,
        subject,
      });
    } catch (error) {
      this.logger.error('Error processing individual Outlook Calendar event', {
        userId,
        connectionId,
        eventId: event.id,
        subject: event.subject,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other events
    }
  }

  private extractParticipants(event: OutlookCalendarEvent): Participant[] {
    const participants: Participant[] = [];

    // Add organizer
    if (event.organizer?.emailAddress) {
      participants.push({
        email: event.organizer.emailAddress.address || 'unknown',
        name: event.organizer.emailAddress.name || event.organizer.emailAddress.address || 'unknown',
        responseStatus: 'organizer',
        isOrganizer: true,
      });
    }

    // Add attendees
    if (event.attendees) {
      for (const attendee of event.attendees) {
        if (attendee.emailAddress) {
          participants.push({
            email: attendee.emailAddress.address || 'unknown',
            name: attendee.emailAddress.name || attendee.emailAddress.address || 'unknown',
            responseStatus: attendee.status?.response || 'none',
            isOrganizer: false,
          });
        }
      }
    }

    return participants;
  }

  private async transformToEventDto(
    event: OutlookCalendarEvent,
    userId: string,
    connectionId: string,
  ): Promise<CreateEventDto> {
    const start_time = event.start?.dateTime ? new Date(event.start.dateTime) : new Date();
    const end_time = event.end?.dateTime ? new Date(event.end.dateTime) : null;

    // Extract location
    const location_name = event.location?.displayName || null;
    let location_coordinates: Point | null = null;

    if (event.location?.coordinates?.latitude && event.location?.coordinates?.longitude) {
      location_coordinates = {
        type: 'Point',
        coordinates: [event.location.coordinates.longitude, event.location.coordinates.latitude],
      };
    }

    // Build metadata
    const metadata = {
      connectionId,
      organizerEmail: event.organizer?.emailAddress?.address,
      organizerName: event.organizer?.emailAddress?.name,
      participantCount: event.attendees?.length ?? 0,
      outlookEventUrl: event.webLink,
      created: event.createdDateTime,
      updated: event.lastModifiedDateTime,
      isOrganizer: event.isOrganizer,
    };

    return {
      id: uuidv7(),
      title: event.subject || 'Untitled Event',
      description: event.bodyPreview || event.body?.content || undefined,
      event_type: 'calendar_event',
      category: 'outlook_calendar',
      start_time,
      end_time: end_time || undefined,
      location_name: location_name || undefined,
      location_coordinates: location_coordinates || undefined,
      source_type: 'ETL',
      source_system: 'outlook_calendar',
      source_id: event.id || undefined,
      is_recurring: !!event.recurrence || !!event.seriesMasterId,
      is_all_day: event.isAllDay || false,
      status: this.normalizeStatus(event.isCancelled),
      metadata,
      user: { id: userId },
    };
  }

  private async processParticipants(
    participants: Participant[],
    userId: string,
    connectionId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<string[]> {
    const participantInfos = participants.map((p) => ({
      email: p.email,
      name: p.name,
      type: p.isOrganizer ? 'organizer' : 'attendee',
      responseStatus: p.responseStatus,
    }));

    // Use MET_WITH for regular attendees, ORGANIZED_EVENT_WITH for organizers
    const organizerInfos = participantInfos.filter((p) => p.type === 'organizer');
    const attendeeInfos = participantInfos.filter((p) => p.type === 'attendee');

    const organizerEntityIds = await this.promoteService.processParticipants(
      organizerInfos,
      userId,
      connectionId,
      'calendar',
      'ORGANIZED_EVENT_WITH',
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    const attendeeEntityIds = await this.promoteService.processParticipants(
      attendeeInfos,
      userId,
      connectionId,
      'calendar',
      'MET_WITH',
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    return [...organizerEntityIds, ...attendeeEntityIds];
  }

  private normalizeStatus(isCancelled?: boolean): string {
    return isCancelled ? 'cancelled' : 'confirmed';
  }
}
