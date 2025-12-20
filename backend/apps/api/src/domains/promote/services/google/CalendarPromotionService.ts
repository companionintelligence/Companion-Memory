import { Injectable } from '@nestjs/common';
import { Point } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EventService as MemoryEventService, type CreateEventDto } from '@ci/domains/memory';

import { PromoteService } from '../PromoteService';

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
  private readonly googleMapsApiKey = process.env.GOOGLE_MAPS_KEY;

  constructor(
    private readonly eventService: MemoryEventService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GoogleCalendarEventPromotionService.name);
  }

  private async geocodeLocation(location: string | null): Promise<Point | null> {
    if (!location || location.trim().length === 0) {
      return null;
    }

    try {
      const encodedLocation = encodeURIComponent(location.trim());
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedLocation}&key=${this.googleMapsApiKey}`;

      this.logger.debug('Attempting to geocode location', { location });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'CI-Server/1.0',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logger.warn('Google Maps API request failed', {
          location,
          status: response.status,
          statusText: response.statusText,
        });

        return null;
      }

      const data = await response.json();

      // Handle API key restrictions
      if (data.status === 'REQUEST_DENIED') {
        this.logger.warn('Google Maps API key has restrictions (likely referer restrictions)', {
          location,
          status: data.status,
          errorMessage: data.error_message,
        });

        return null;
      }

      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        this.logger.warn('Google Maps geocoding failed', {
          location,
          status: data.status,
          errorMessage: data.error_message,
        });

        return null;
      }

      const result = data.results[0];
      const lat = result.geometry.location.lat;
      const lng = result.geometry.location.lng;

      if (typeof lat !== 'number' || typeof lng !== 'number') {
        this.logger.warn('Invalid coordinates returned from Google Maps API', {
          location,
          lat,
          lng,
        });

        return null;
      }

      const point: Point = {
        type: 'Point',
        coordinates: [lng, lat],
      };

      this.logger.debug('Successfully geocoded location', {
        location,
        coordinates: { lat, lng },
      });

      return point;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Geocoding request timed out', { location });
      } else {
        this.logger.error('Error during geocoding', {
          location,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      return null;
    }
  }

  async promoteCalendarEvents(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    // Validate input parameters
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid userId parameter');
    }

    if (!connectionId || typeof connectionId !== 'string') {
      throw new Error('Invalid connectionId parameter');
    }

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
    const eventDetails = this.extractEventDetails(event);

    // Transform and save event
    const eventDto = await this.transformToEventDto(eventDetails, event, userId, connectionId);

    await this.eventService.create({ userId }, eventDto);

    // Process participants
    await this.processParticipants(eventDetails.participants, userId, connectionId);

    this.logger.log('Calendar event saved successfully', {
      eventId: eventDetails.id,
      summary: eventDetails.summary,
    });
  }

  private extractEventDetails(event: CalendarEvent): EventDetails {
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

    const location_coordinates = await this.geocodeLocation(eventDetails.location);

    return {
      id: '', // Will be generated by the service
      title: eventDetails.summary,
      description: eventDetails.description || undefined,
      event_type: 'calendar_event',
      category: 'google_calendar',
      start_time,
      end_time: end_time || undefined,
      location_name: eventDetails.location || undefined,
      location_coordinates: location_coordinates || undefined,
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
    );

    const attendeeEntityIds = await this.promoteService.processParticipants(
      attendeeInfos,
      userId,
      connectionId,
      'calendar',
      'MET_WITH',
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
}
