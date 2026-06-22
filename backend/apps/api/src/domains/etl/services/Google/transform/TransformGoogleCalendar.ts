import { Injectable } from '@nestjs/common';
import { Point } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { GeocodeService } from '@ci/domains/geocode';
import { EventService as MemoryEventService, type CreateEventDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
  }>;
  organizer?: {
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  location?: string;
  status?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  recurrence?: string[];
}

interface EventDetails {
  id: string;
  summary: string;
  description: string | null;
  startTime: string | undefined;
  endTime: string | undefined;
  location: string | null;
  organizerEmail: string;
  organizerName: string;
  participants: Participant[];
  isRecurring: boolean;
  status: string;
  created: string | null;
  updated: string | null;
}

interface Participant {
  email: string;
  name: string;
  responseStatus: string;
  isOrganizer: boolean;
  isSelf: boolean;
}

@Injectable()
export class GoogleCalendarTransformService {
  constructor(
    private readonly eventService: MemoryEventService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly geocodeService: GeocodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GoogleCalendarTransformService.name);
  }

  async transformGoogleCalendar({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Google Calendar event transformation', {
        userId,
        syncJobId,
      });

      const events = this.extractCalendarEvents(data);

      if (events.length === 0) {
        this.logger.log('No calendar events found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${events.length} calendar events`, {
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

      this.logger.log('Google Calendar event transformation completed', {
        userId,
        syncJobId,
        processedCount: events.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Google Calendar events', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractCalendarEvents(data: unknown): CalendarEvent[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for calendar events', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Google Calendar API
    if ('items' in dataObj && Array.isArray(dataObj.items)) {
      return dataObj.items as CalendarEvent[];
    }

    if ('events' in dataObj && Array.isArray(dataObj.events)) {
      return dataObj.events as CalendarEvent[];
    }

    if ('id' in dataObj && ('summary' in dataObj || 'start' in dataObj)) {
      return [dataObj as CalendarEvent];
    }

    this.logger.warn('No events found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processCalendarEvent({
    event,
    userId,
    connectionId,
  }: {
    event: CalendarEvent;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const eventDetails = this.extractEventDetails(event);

      this.logger.log('Processing Google Calendar event', {
        eventId: eventDetails.id,
        summary: eventDetails.summary,
        participantCount: eventDetails.participants.length,
      });

      // Transform and save event
      const eventDto = await this.transformToEventDto(eventDetails, event, userId, connectionId);

      await this.eventService.create({ userId }, eventDto);

      // Process participants
      await this.processParticipants(
        eventDetails.participants,
        userId,
        connectionId,
        eventDetails.startTime,
        eventDetails.endTime,
      );

      this.logger.log('Google Calendar event saved successfully', {
        eventId: eventDetails.id,
        summary: eventDetails.summary,
      });
    } catch (error) {
      console.log('error', error);
      this.logger.error('Error processing individual calendar event', {
        userId,
        connectionId,
        eventId: event.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other events
    }
  }

  private extractEventDetails(event: CalendarEvent): EventDetails {
    const startTime = event.start?.dateTime || event.start?.date || undefined;
    const endTime = event.end?.dateTime || event.end?.date || undefined;

    // Extract participants (attendees)
    const participants: Participant[] = (event.attendees || []).map((attendee) => ({
      email: attendee.email || 'unknown',
      name: attendee.displayName || attendee.email || 'unknown',
      responseStatus: attendee.responseStatus || 'unknown',
      isOrganizer: attendee.organizer || false,
      isSelf: attendee.self || false,
    }));

    // Extract organizer info
    const organizerEmail = event.organizer?.email || 'unknown';
    const organizerName = event.organizer?.displayName || event.organizer?.email || 'unknown';

    return {
      id: event.id || 'unknown',
      summary: event.summary || 'Untitled Event',
      description: event.description || null,
      startTime,
      endTime,
      location: event.location || null,
      organizerEmail,
      organizerName,
      participants,
      isRecurring: !!event.recurringEventId || !!event.recurrence,
      status: event.status || 'unknown',
      created: event.created || null,
      updated: event.updated || null,
    };
  }

  private async transformToEventDto(
    eventDetails: EventDetails,
    rawEvent: CalendarEvent,
    userId: string,
    connectionId: string,
  ): Promise<CreateEventDto> {
    const start_time = this.parseDateTime(eventDetails.startTime);
    const end_time = eventDetails.endTime ? this.parseDateTime(eventDetails.endTime) : null;

    if (!start_time) {
      throw new Error(`Calendar event ${eventDetails.id} has no start time`);
    }

    // Build metadata with essential information only (avoid storing large rawEvent)
    const metadata = {
      connectionId,
      organizerEmail: eventDetails.organizerEmail,
      organizerName: eventDetails.organizerName,
      participantCount: eventDetails.participants.length,
      participants: eventDetails.participants,
      googleCalendarUrl: `https://calendar.google.com/calendar/event?eid=${eventDetails.id}`,
      created: eventDetails.created,
      updated: eventDetails.updated,
      rawEventId: rawEvent.id,
      rawEventSummary: rawEvent.summary,
      rawEventStatus: rawEvent.status,
    };

    const isAllDay = this.isAllDayEvent(eventDetails.startTime);

    const { point: location_coordinates, confidence: location_confidence } =
      await this.geocodeLocationWithConfidence(eventDetails.location);

    return {
      id: uuidv7(), // Will be generated by the service
      title: eventDetails.summary,
      description: eventDetails.description || undefined,
      event_type: 'calendar_event',
      category: 'google_calendar',
      start_time,
      end_time: end_time || undefined,
      location_name: eventDetails.location || undefined,
      location_coordinates: location_coordinates || undefined,
      // Inferred / coarse coords carry < 1.0 so HBPE/RAG don't treat them as
      // ground truth; leave the default 1.0 when there are no coordinates.
      ...(location_confidence !== null ? { confidence_score: location_confidence } : {}),
      source_type: 'ETL',
      source_system: 'google_calendar',
      source_id: eventDetails.id,
      is_recurring: eventDetails.isRecurring,
      is_all_day: isAllDay,
      status: this.normalizeStatus(eventDetails.status),
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

  /**
   * Forward-geocode a calendar location via the shared {@link GeocodeService}
   * (cache + provider + virtual-location denylist) and return both the Point and
   * a precision-derived confidence (street ≈ 0.95, venue ≈ 0.8, city-centroid ≈
   * 0.4) so inferred / coarse coordinates are NOT stored at the default 1.0
   * ground-truth weight.
   */
  private async geocodeLocationWithConfidence(
    location: string | null,
  ): Promise<{ point: Point | null; confidence: number | null }> {
    const outcome = await this.geocodeService.geocode(location);

    if (outcome.status === 'OK' && outcome.point) {
      return { point: outcome.point, confidence: outcome.confidence };
    }

    return { point: null, confidence: null };
  }

  private parseDateTime(dateTimeStr: string | undefined): Date | undefined {
    if (!dateTimeStr) {
      return undefined;
    }

    try {
      return new Date(dateTimeStr);
    } catch {
      this.logger.warn('Failed to parse datetime', { dateTimeStr });

      return undefined;
    }
  }

  private isAllDayEvent(startTime: string | undefined): boolean {
    // If no time component (no 'T' in ISO string), it's an all-day event
    return !!startTime && !startTime.includes('T');
  }

  private normalizeStatus(status: string): string {
    const statusMap: Record<string, string> = {
      cancelled: 'cancelled',
      confirmed: 'confirmed',
      tentative: 'tentative',
    };

    return statusMap[status.toLowerCase()] || 'confirmed';
  }
}
