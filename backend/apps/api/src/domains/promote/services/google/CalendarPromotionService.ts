import { Injectable } from '@nestjs/common';
import { Point } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import { EventService, type CreateEventDto } from '@ci/domains/memory';

import { PersonPromotionService } from '../PersonPromotionService';

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
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  locationCoordinates: Point | null;
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
export class GoogleCalendarEventPromotionService {
  private logger = new LoggerService(GoogleCalendarEventPromotionService.name);

  private readonly GOOGLE_MAPS_API_KEY = 'AIzaSyD7dLUudRwPlBemrnLDm_RCxT4NFaT5Ab0';

  constructor(
    private readonly eventService: EventService,
    private readonly personPromotionService: PersonPromotionService,
  ) {}

  async promoteCalendarEvents(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Starting calendar event promotion', {
      userId,
      connectionId,
    });

    try {
      const events = this.extractCalendarEvents(apiLogContent);

      if (events.length === 0) {
        this.logger.log('No calendar events found to promote', { userId, connectionId });

        return;
      }

      this.logger.log(`Processing ${events.length} calendar events`, {
        userId,
        connectionId,
        eventCount: events.length,
      });

      await this.processEvents(events, userId, connectionId);

      this.logger.log('Calendar event promotion completed', {
        userId,
        connectionId,
        processedCount: events.length,
      });
    } catch (error) {
      this.logger.error('Error promoting calendar events', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractCalendarEvents(content: unknown): CalendarEvent[] {
    if (!content || typeof content !== 'object') {
      this.logger.warn('Invalid content type for calendar events', {
        contentType: typeof content,
      });

      return [];
    }

    const contentObj = content as Record<string, unknown>;

    // Handle the structure from Google Calendar API
    if ('items' in contentObj && Array.isArray(contentObj.items)) {
      return contentObj.items as CalendarEvent[];
    }

    // Handle single event
    if ('id' in contentObj && ('summary' in contentObj || 'start' in contentObj)) {
      return [contentObj as CalendarEvent];
    }

    this.logger.warn('No events found in content', {
      contentKeys: Object.keys(contentObj),
    });

    return [];
  }

  private async processEvents(events: CalendarEvent[], userId: string, connectionId: string): Promise<void> {
    let processedCount = 0;

    for (const event of events) {
      try {
        await this.processCalendarEvent(event, userId, connectionId);
        processedCount++;

        // Log progress every 10 events
        if (processedCount % 10 === 0) {
          this.logger.log('Calendar event promotion progress', {
            userId,
            connectionId,
            processedCount,
            totalEvents: events.length,
          });
        }
      } catch (error) {
        this.logger.error('Error processing individual calendar event', {
          userId,
          connectionId,
          eventId: event.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Don't throw - continue processing other events
      }
    }
  }

  private async processCalendarEvent(
    event: CalendarEvent,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    const eventDetails = await this.extractEventDetails(event);

    this.logEventDetails(eventDetails);

    // Transform and save event
    const eventDto = this.transformToEventDto(eventDetails, event, userId, connectionId);
    await this.eventService.create({ userId }, eventDto);

    // Process participants with the event start time
    const eventStartTime = eventDetails.startTime ? new Date(eventDetails.startTime) : undefined;
    await this.processParticipants(eventDetails.participants, userId, connectionId, eventStartTime);

    this.logger.log('Calendar event saved successfully', {
      eventId: eventDetails.id,
      summary: eventDetails.summary,
    });

    this.logFutureEventIfApplicable(eventDetails);
  }

  private async extractEventDetails(event: CalendarEvent): Promise<EventDetails> {
    const startTime = event.start?.dateTime || event.start?.date || null;
    const endTime = event.end?.dateTime || event.end?.date || null;

    // Extract participants (attendees)
    const participants: Participant[] = (event.attendees || []).map((attendee) => ({
      email: attendee.email || 'unknown',
      name: attendee.displayName || attendee.email || 'unknown',
      responseStatus: attendee.responseStatus || 'unknown',
      isOrganizer: attendee.organizer || false,
      isSelf: attendee.self || false,
    }));

    // Extract and geocode location
    const location = event.location || null;
    let locationCoordinates: Point | null = null;

    if (location) {
      locationCoordinates = await this.geocodeLocation(location);
    }

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
      locationCoordinates,
      organizerEmail,
      organizerName,
      participants,
      isRecurring: !!event.recurringEventId || !!event.recurrence,
      status: event.status || 'unknown',
      created: event.created || null,
      updated: event.updated || null,
    };
  }

  private transformToEventDto(
    eventDetails: EventDetails,
    rawEvent: CalendarEvent,
    userId: string,
    connectionId: string,
  ): CreateEventDto {
    const start_time = this.parseDateTime(eventDetails.startTime);
    const end_time = eventDetails.endTime ? this.parseDateTime(eventDetails.endTime) : null;

    if (!start_time) {
      throw new Error(`Calendar event ${eventDetails.id} has no start time`);
    }

    // Build metadata with all relevant information
    const metadata = {
      rawEvent,
      connectionId,
      organizerEmail: eventDetails.organizerEmail,
      organizerName: eventDetails.organizerName,
      participantCount: eventDetails.participants.length,
      participants: eventDetails.participants,
      googleCalendarUrl: `https://calendar.google.com/calendar/event?eid=${eventDetails.id}`,
      created: eventDetails.created,
      updated: eventDetails.updated,
    };

    const isAllDay = this.isAllDayEvent(eventDetails.startTime);

    return {
      id: '', // Will be generated by the service
      title: eventDetails.summary,
      description: eventDetails.description || undefined,
      event_type: 'calendar_event',
      category: 'google_calendar',
      start_time,
      end_time: end_time || undefined,
      location_name: eventDetails.location || undefined,
      location_coordinates: eventDetails.locationCoordinates || undefined,
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
    eventStartTime?: Date,
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

    const organizerEntityIds = await this.personPromotionService.processParticipants(
      organizerInfos,
      userId,
      connectionId,
      'calendar',
      'ORGANIZED_EVENT_WITH',
      eventStartTime,
    );

    const attendeeEntityIds = await this.personPromotionService.processParticipants(
      attendeeInfos,
      userId,
      connectionId,
      'calendar',
      'MET_WITH',
      eventStartTime,
    );

    return [...organizerEntityIds, ...attendeeEntityIds];
  }

  private parseDateTime(dateTimeStr: string | null): Date | null {
    if (!dateTimeStr) {
      return null;
    }

    try {
      return new Date(dateTimeStr);
    } catch {
      this.logger.warn('Failed to parse datetime', { dateTimeStr });

      return null;
    }
  }

  private isAllDayEvent(startTime: string | null): boolean {
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

  private logEventDetails(eventDetails: EventDetails): void {
    this.logger.log('Processing calendar event', {
      eventId: eventDetails.id,
      summary: eventDetails.summary,
      startTime: eventDetails.startTime,
      endTime: eventDetails.endTime,
      location: eventDetails.location,
      locationCoordinates: eventDetails.locationCoordinates
        ? `[${eventDetails.locationCoordinates.coordinates[1]}, ${eventDetails.locationCoordinates.coordinates[0]}]`
        : null,
      organizer: `${eventDetails.organizerName} (${eventDetails.organizerEmail})`,
      status: eventDetails.status,
      isRecurring: eventDetails.isRecurring,
      participantCount: eventDetails.participants.length,
    });
  }

  private logFutureEventIfApplicable(eventDetails: EventDetails): void {
    if (!eventDetails.startTime) {
      return;
    }

    const startDate = new Date(eventDetails.startTime);
    const now = new Date();

    if (startDate > now) {
      const daysInFuture = Math.ceil((startDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      this.logger.log('Future event detected', {
        eventId: eventDetails.id,
        summary: eventDetails.summary,
        daysInFuture,
        startDate: startDate.toISOString(),
      });
    }
  }

  private async geocodeLocation(location: string): Promise<Point | null> {
    try {
      this.logger.log('Geocoding location', { location });

      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.append('address', location);
      url.searchParams.append('key', this.GOOGLE_MAPS_API_KEY);

      const response = await fetch(url.toString());
      const data = await response.json();

      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        this.logger.warn('Geocoding failed or no results', {
          location,
          status: data.status,
          error: data.error_message,
        });

        return null;
      }

      const { lat, lng } = data.results[0].geometry.location;

      this.logger.log('Geocoding successful', {
        location,
        lat,
        lng,
      });

      // Return in GeoJSON Point format (TypeORM Point)
      return {
        type: 'Point',
        coordinates: [lng, lat], // [longitude, latitude]
      } as Point;
    } catch (error) {
      this.logger.error('Error geocoding location', {
        location,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return null;
    }
  }
}
