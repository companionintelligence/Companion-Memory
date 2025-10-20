import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { ConnectionService } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import { EventService, type CreateEventDto } from '@ci/domains/memory';

import { PersonPromotionService } from '../PersonPromotionService';

interface RawData {
  data: object;
  syncState: object;
}

interface ExtractedUser {
  name: string;
  email: string;
}

interface CalendarLocation {
  displayName: string;
  locationType: string;
  address: {
    street?: string;
    city?: string;
    state?: string;
    countryOrRegion?: string;
    postalCode?: string;
  };
  coordinates: {
    latitude: number;
    longitude: number;
  };
}

interface CalendarAttendee {
  emailAddress: {
    name: string;
    address: string;
  };
}

interface OutlookCalendarEvent {
  id?: string;
  bodyPreview?: string;
  body: {
    contentType: string;
    content: string;
  };
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  subject: string;
  isAllDay: boolean;
  hasAttachments: boolean;
  location?: CalendarLocation;
  locations?: CalendarLocation[];
  attendees: CalendarAttendee[];
  organizer: CalendarAttendee;
}

interface OutlookCalendarAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string; // Base64 encoded content
}

interface ExtractedEvent {
  id: string;
  subject: string;
  startTime: Date;
  endTime: Date;
  isAllDay: boolean;
  bodyPreview?: string | null;
  body: string;
  participants: ExtractedUser[];
  attachments?: OutlookCalendarAttachment[];
  organizer: ExtractedUser;
  location?: CalendarLocation;
}

interface EventParticipant {
  email: string;
  name: string;
}

@Injectable()
export class OutlookCalendarPromotionService {
  private logger = new LoggerService(OutlookCalendarPromotionService.name);

  constructor(
    private readonly fileService: FileService,
    private readonly eventService: EventService,
    private readonly personPromotionService: PersonPromotionService,
    private readonly connectionService: ConnectionService,
  ) {}

  async promoteOutlookCalendarEvents(
    apiLogContent: unknown,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    this.logger.log('Starting Outlook Calendar promotion', {
      userId,
      connectionId,
      contentType: typeof apiLogContent,
      contentKeys: apiLogContent && typeof apiLogContent === 'object' ? Object.keys(apiLogContent) : [],
    });

    try {
      // Extract event ids from the API log content
      const events = this.extractOutlookCalendarEvents(apiLogContent as RawData[]);

      // Get the connection
      const connection = await this.connectionService.findById(connectionId);
      if (!connection || !connection.accessToken) {
        this.logger.error('Connection not found or missing access token', { connectionId });

        return;
      }

      // Process each event individually
      for (const event of events) {
        if (!event.id) {
          this.logger.warn('Skipping event without ID', { event });
          continue;
        }

        // Process the event
        await this.processOutlookCalendarEvent(event, userId, connectionId);
      }
    } catch (error) {
      this.logger.error('Error promoting Outlook Calendar events', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractOutlookCalendarEvents(content: RawData[]): OutlookCalendarEvent[] {
    if (!content || typeof content !== 'object') {
      this.logger.warn('Invalid content type for OutlookCalendar events', {
        contentType: typeof content,
        contentNull: content === null,
      });

      return [];
    }

    let returned = [] as OutlookCalendarEvent[];

    content.map((obj) => {
      const dataObj = obj.data as Record<string, unknown>;

      // Handle the structure from OutlookCalendar API - events array
      if (dataObj.events && Array.isArray(dataObj.events)) {
        this.logger.log('Extracting events from events array', {
          eventCount: dataObj.events.length,
        });

        returned = returned.concat(dataObj.events as OutlookCalendarEvent[]);
      }

      if (returned.length === 0) {
        this.logger.warn('No events found in content', {
          contentKeys: Object.keys(dataObj),
        });
      }
    });

    return returned;
  }

  private async processOutlookCalendarEvent(
    event: OutlookCalendarEvent,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    // Extract event details
    const eventDetails = await this.extractEventDetails(event, connectionId);

    this.logger.log('Processing OutlookCalendar event', {
      eventId: eventDetails.id,
      subject: eventDetails.subject,
      participantCount: eventDetails.participants.length,
    });

    const participants = eventDetails.participants;
    const organizer = eventDetails.organizer;

    const participantEntityIds = await this.personPromotionService.processParticipants(
      participants,
      userId,
      connectionId,
      'email',
      'MET_WITH',
    );

    const organizerEntityId = (
      await this.personPromotionService.processParticipants(
        [organizer],
        userId,
        connectionId,
        'calendar',
        'ORGANIZED_EVENT_WITH',
      )
    )[0];

    await Promise.all(
      (eventDetails.attachments || []).map(async (attachment) => {
        const file = {
          fieldname: 'attachment',
          originalname: attachment.name,
          mimetype: attachment.contentType,
          size: attachment.size,
          encoding: 'base64',
          destination: '',
          stream: '' as unknown as Readable,
          filename: attachment.name,
          path: '',
          buffer: attachment.contentBytes ? Buffer.from(attachment.contentBytes, 'base64') : Buffer.from(''),
        };

        return this.fileService.upload({ userId }, file);
      }),
    );

    const newEvent = {
      id: uuidv7(),
      start_time: new Date(eventDetails.startTime),
      end_time: new Date(eventDetails.endTime),
      title: eventDetails.subject,
      user: {
        id: userId,
      },
      is_all_day: eventDetails.isAllDay,
      organizer_entity_id: organizerEntityId,
      source_type: 'ETL',
      participant_entity_ids: participantEntityIds,
      metadata: {
        connection_id: connectionId,
      },
    } as CreateEventDto;

    const location = eventDetails.location;
    if (location) {
      newEvent.location_name = location.displayName;
      newEvent.location_coordinates = {
        type: 'Point',
        coordinates: [location.coordinates.longitude, location.coordinates.latitude],
      };
    }

    // Save to events table
    await this.eventService.create({ userId }, newEvent);
  }

  private async extractEventDetails(
    event: OutlookCalendarEvent,
    connectionId: string,
  ): Promise<ExtractedEvent> {
    const connection = await this.connectionService.findById(connectionId);
    const { id, start, end, subject, isAllDay, hasAttachments, attendees, organizer } = event;
    let attachments;

    // Extract participants
    const participants: EventParticipant[] = [];

    if (hasAttachments) {
      attachments = await this.fetchEventAttachments(connection!.accessToken!, id!);
    }

    for (const attendee of attendees) {
      const parsed = {
        name: attendee.emailAddress.name,
        email: attendee.emailAddress.address,
      };
      participants.push(parsed);
    }

    const returnedOrganizer = {
      name: organizer.emailAddress.name,
      email: organizer.emailAddress.address,
    };

    // Extract body
    const body = event.body?.content || '';

    return {
      id: event.id || 'unknown',
      subject,
      startTime: new Date(start.dateTime),
      endTime: new Date(end.dateTime),
      isAllDay,
      bodyPreview: event.bodyPreview || null,
      body,
      participants,
      attachments,
      organizer: returnedOrganizer,
      location: event.location || undefined,
    };
  }

  private async fetchEventAttachments(
    accessToken: string,
    eventId: string,
  ): Promise<OutlookCalendarAttachment[] | undefined> {
    try {
      const response = await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}/attachments`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        this.logger.error('Failed to fetch Outlook Mail event', {
          eventId,
          status: response.status,
          statusText: response.statusText,
        });

        return undefined;
      }

      return (await response.json()).value as OutlookCalendarAttachment[];
    } catch (error) {
      this.logger.error('Failed to fetch Outlook Mail event', {
        eventId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return undefined;
    }
  }
}
