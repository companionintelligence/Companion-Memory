import { v7 as uuidv7 } from 'uuid';

import type { CreateEventDto } from '@ci/domains/memory/types';

interface GoogleCalendarEvent {
  kind?: string;
  etag?: string;
  id: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
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
  location?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
  }>;
  creator?: {
    email: string;
    displayName?: string;
    self?: boolean;
  };
  organizer?: {
    email: string;
    displayName?: string;
    self?: boolean;
  };
  recurrence?: string[];
  transparency?: string;
  iCalUID?: string;
  sequence?: number;
  reminders?: {
    useDefault?: boolean;
  };
  eventType?: string;
}

interface GoogleCalendarResponse {
  items?: GoogleCalendarEvent[];
}

interface MicrosoftCalendarEvent {
  id: string;
  subject?: string;
  body?: {
    content?: string;
  };
  start?: {
    dateTime: string;
    timeZone: string;
  };
  end?: {
    dateTime: string;
    timeZone: string;
  };
  webLink?: string;
  location?: {
    displayName?: string;
  };
  attendees?: Array<{
    emailAddress: {
      address: string;
      name?: string;
    };
  }>;
  organizer?: {
    emailAddress: {
      address: string;
      name?: string;
    };
  };
}

interface MicrosoftCalendarResponse {
  value?: MicrosoftCalendarEvent[];
}

export function parseCalendarDataToEvents(
  calendarData: unknown,
  connectionId: string,
  userId: string,
): CreateEventDto[] {
  const events: CreateEventDto[] = [];

  // Handle Google Calendar data
  if (isGoogleCalendarResponse(calendarData)) {
    const googleEvents = calendarData.items || [];

    for (const event of googleEvents) {
      const parsedEvent = parseGoogleCalendarEvent(event, connectionId, userId);
      if (parsedEvent) {
        events.push(parsedEvent);
      }
    }
  }

  // Handle Microsoft Calendar data
  else if (isMicrosoftCalendarResponse(calendarData)) {
    const microsoftEvents = calendarData.value || [];

    for (const event of microsoftEvents) {
      const parsedEvent = parseMicrosoftCalendarEvent(event, connectionId, userId);
      if (parsedEvent) {
        events.push(parsedEvent);
      }
    }
  }

  return events;
}

function isGoogleCalendarResponse(data: unknown): data is GoogleCalendarResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'items' in data &&
    Array.isArray((data as Record<string, unknown>).items)
  );
}

function isMicrosoftCalendarResponse(data: unknown): data is MicrosoftCalendarResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'value' in data &&
    Array.isArray((data as Record<string, unknown>).value)
  );
}

function parseGoogleCalendarEvent(
  event: GoogleCalendarEvent,
  connectionId: string,
  userId: string,
): CreateEventDto | null {
  try {
    console.log('Parsing Google Calendar event:', {
      eventId: event.id,
      summary: event.summary,
      connectionId,
      userId,
    });

    // Parse start time
    let startTime: Date | null = null;
    if (event.start?.dateTime) {
      startTime = new Date(event.start.dateTime);
    } else if (event.start?.date) {
      startTime = new Date(event.start.date);
    }

    // Parse end time
    let endTime: Date | null = null;
    if (event.end?.dateTime) {
      endTime = new Date(event.end.dateTime);
    } else if (event.end?.date) {
      endTime = new Date(event.end.date);
    }

    // Parse created and updated times
    let createdAt: Date | null = null;
    if (event.created) {
      createdAt = new Date(event.created);
    }

    let updatedAt: Date | null = null;
    if (event.updated) {
      updatedAt = new Date(event.updated);
    }

    // Build source data with the entire event blob
    const sourceData: Record<string, unknown> = {
      ...event, // Include the entire event object
      parsed_at: new Date().toISOString(),
    };

    const parsedEvent = {
      id: uuidv7(),
      name: event.summary || 'Untitled Event',
      type: 'Calendar Event',
      description: event.description || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: event.id,
      source_url: event.htmlLink || undefined,
      source_data: sourceData,
      connection_id: connectionId,
      user_id: userId,
      user: {
        id: userId,
      },
      created_at: createdAt || undefined,
      updated_at: updatedAt || undefined,
    };

    console.log('Parsed event data:', {
      id: parsedEvent.id,
      name: parsedEvent.name,
      type: parsedEvent.type,
      external_id: parsedEvent.external_id,
      connection_id: parsedEvent.connection_id,
      user_id: parsedEvent.user_id,
      start_time: parsedEvent.start_time,
      end_time: parsedEvent.end_time,
    });

    return parsedEvent;
  } catch (error) {
    console.error('Error parsing Google Calendar event:', error);

    return null;
  }
}

function parseMicrosoftCalendarEvent(
  event: MicrosoftCalendarEvent,
  connectionId: string,
  userId: string,
): CreateEventDto | null {
  try {
    // Parse start time
    let startTime: Date | null = null;
    if (event.start?.dateTime) {
      startTime = new Date(event.start.dateTime);
    }

    // Parse end time
    let endTime: Date | null = null;
    if (event.end?.dateTime) {
      endTime = new Date(event.end.dateTime);
    }

    // Build source data with additional information
    const sourceData: Record<string, unknown> = {
      microsoft_event_id: event.id,
      location: event.location?.displayName,
      attendees: event.attendees?.map((attendee) => ({
        email: attendee.emailAddress.address,
        name: attendee.emailAddress.name,
      })),
      organizer: event.organizer
        ? {
            email: event.organizer.emailAddress.address,
            name: event.organizer.emailAddress.name,
          }
        : null,
    };

    return {
      id: uuidv7(),
      name: event.subject || 'Untitled Event',
      type: 'calendar_event',
      description: event.body?.content || undefined,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      external_id: event.id,
      source_url: event.webLink || undefined,
      source_data: sourceData,
      connection_id: connectionId,
      user_id: userId,
      user: {
        id: userId,
      },
    };
  } catch (error) {
    console.error('Error parsing Microsoft Calendar event:', error);

    return null;
  }
}
